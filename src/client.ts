// A2AQuery — the reactive, cached, embeddable A2A client. Sits on the official
// @a2a-js/sdk Client (transports, wire, card resolution) and adds the stratum the
// SDK deliberately leaves out: a multi-agent registry/router (the SDK Client is
// single-endpoint), a TanStack-style cache over cards and tasks, poll-driven
// TaskHandles, and an approval broker for the protocol's paused task states
// (INPUT_REQUIRED / AUTH_REQUIRED — first-class human-in-the-loop resume points).

import { TaskState, type AgentCard, type Message, type Task } from "@a2a-js/sdk";
import {
  Client,
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  InteractionBroker,
  QueryCache,
  StatusStore,
  withRetry,
  type BaseDecision,
  type CacheEntry,
  type ConnectivityState,
  type DevtoolsSink,
  type PeerStatus,
  type RetryPolicy,
} from "@johnhenry/agent-query-core";

import { agentTag, cardTag, serializeA2AKey, taskTag, type A2AKey } from "./keys.js";

/** The broker decision shape for paused tasks: approve with the follow-up message. */
export interface InputDecision extends BaseDecision {
  /** The message to resume the task with (its taskId is filled in automatically). */
  message?: Message;
}

/**
 * Compact, serializable devtools events a2aq emits into a `DevtoolsSink`
 * (e.g. the core's `DevtoolsHub`). Task states are emitted as their enum
 * *names* (`"TASK_STATE_WORKING"`) so timelines read without a decoder ring.
 */
export type A2ADevtoolsEvent =
  /** A message hit the wire successfully (initial send or a paused-task resume). */
  | { type: "a2a:send"; agent: string; taskId?: string; messageId: string }
  /** An observed task changed state (emitted on CHANGE, not on every poll). */
  | { type: "a2a:task-status"; agent: string; taskId: string; state: string }
  /** A new artifact appeared on an observed task. */
  | { type: "a2a:artifact"; agent: string; taskId: string; artifactId: string }
  /** The interaction broker resolved a paused-state gate. */
  | { type: "a2a:gate"; agent: string; taskId: string; kind: "input" | "auth"; outcome: "approve" | "deny" }
  /** The agent card was refetched from the wire. */
  | { type: "a2a:card-refresh"; agent: string }
  /** The agent's connectivity state changed (mirrors the StatusStore). */
  | { type: "a2a:status"; agent: string; state: ConnectivityState };

export interface AgentConfig {
  /** Base URL of the agent (card fetched from /.well-known/agent-card.json by default). */
  url: string;
  /** Custom card path, when the agent serves it elsewhere. */
  cardPath?: string;
  /** In-process/testing escape hatch: the fetch used for card resolution AND transport. */
  fetchImpl?: typeof fetch;
}

export interface A2AQueryConfig {
  agents: Record<string, AgentConfig>;
  /** Human-in-the-loop broker gating INPUT_REQUIRED / AUTH_REQUIRED resumes. */
  interactions?: InteractionBroker<InputDecision>;
  /** Poll cadence (ms) for task handles. Default 150. */
  taskPollMs?: number;
  /** Card cache freshness (ms). Default 5 minutes. */
  cardStaleTime?: number;
  /**
   * Per-agent connectivity store. Default: a fresh `StatusStore`. Inject one to
   * share a single store across several clients (multi-protocol dashboards).
   */
  status?: StatusStore;
  /**
   * Retry policy for transient failures on sends, task polls, and card fetches.
   * Absent ⇒ single-attempt behavior (no retries), exactly as before.
   *
   * Sends are retried as idempotent because a2aq fixes the A2A `messageId`
   * BEFORE the first attempt and reuses it on every retry — the messageId IS
   * the idempotency key the receiving agent can dedupe on.
   */
  retry?: RetryPolicy;
  /** Devtools sink (e.g. the core's `DevtoolsHub`). Absent ⇒ zero emission. */
  devtools?: DevtoolsSink<A2ADevtoolsEvent>;
}

/** Paused, non-terminal states a human can resume; terminal states settle handles. */
const PAUSED = new Set([TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]);
const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export interface TaskHandle {
  taskId: string;
  agent: string;
  /** Latest cached snapshot (undefined only before the first write lands). */
  task(): Task | undefined;
  /** Observe live status updates (cache-backed). Returns unsubscribe. */
  subscribe(fn: (task: Task) => void): () => void;
  /** Resolves with the terminal COMPLETED task; rejects on FAILED/REJECTED/CANCELED. */
  result(): Promise<Task>;
  /** Resume a paused task with a follow-up message (taskId is attached). */
  respond(message: Message): Promise<void>;
  /** Ask the agent to cancel this task. */
  cancel(): Promise<void>;
}

/** Client-side message id — fixed before the first attempt so retries reuse it. */
const newMessageId = (): string => crypto.randomUUID();

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const stateName = (state: TaskState): string => TaskState[state] ?? String(state);

export class A2AQuery {
  readonly cache: QueryCache<A2AKey>;
  readonly interactions?: InteractionBroker<InputDecision>;
  /** Per-agent connectivity (versioned, subscribable). Shared when injected via config. */
  readonly status: StatusStore;
  private clients = new Map<string, Promise<Client>>();
  private resolvers = new Map<string, DefaultAgentCardResolver>();
  private cfg: A2AQueryConfig;
  private taskPollMs: number;

  constructor(cfg: A2AQueryConfig) {
    this.cfg = cfg;
    this.interactions = cfg.interactions;
    this.taskPollMs = cfg.taskPollMs ?? 150;
    this.cache = new QueryCache<A2AKey>({ serializeKey: serializeA2AKey });
    this.status = cfg.status ?? new StatusStore();
  }

  agents(): string[] {
    return Object.keys(this.cfg.agents);
  }

  /** The underlying SDK Client for an agent (lazy; card resolved on first use). */
  client(agent: string): Promise<Client> {
    let p = this.clients.get(agent);
    if (!p) {
      const conf = this.cfg.agents[agent];
      if (!conf) throw new Error(`Unknown agent "${agent}"`);
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          transports: [new JsonRpcTransportFactory({ fetchImpl: conf.fetchImpl })],
          cardResolver: new DefaultAgentCardResolver({ fetchImpl: conf.fetchImpl, path: conf.cardPath }),
          // Polling mode: sends return promptly with the (possibly non-terminal)
          // task; the TaskHandle owns the poll loop — the reactive-store model.
          clientConfig: { polling: true },
        }),
      );
      this.setStatus(agent, { state: "connecting" });
      p = factory.createFromUrl(conf.url, conf.cardPath).then((client) => {
        this.markReady(agent);
        void this.refreshCard(agent, client);
        return client;
      });
      this.clients.set(agent, p);
      // A failed connect (bad URL, unreachable card) must not poison the map
      // forever — drop the rejected promise so the next call can retry. The
      // evicted client is gone, not merely degraded: status goes "closed".
      p.catch((err) => {
        if (this.clients.get(agent) === p) {
          this.clients.delete(agent);
          this.setStatus(agent, { state: "closed", lastError: asError(err) });
        }
      });
    }
    return p;
  }

  // ── agent cards ───────────────────────────────────────────────────────────
  /** The agent's card, cached (cardStaleTime, default 5 min). Wire refetches are idempotent reads — retried per `retry` when configured. */
  async card(agent: string, opts: { refresh?: boolean } = {}): Promise<AgentCard> {
    const key: A2AKey = { kind: "card", agent };
    if (!opts.refresh && !this.cache.isStale(key)) return this.cache.getSnapshot(key)!.data as AgentCard;
    // Refetch through the card resolver: the SDK Client's getAgentCard() returns
    // its in-memory copy (except for extended cards), so a stale refresh must
    // go back to the well-known endpoint itself.
    const conf = this.cfg.agents[agent];
    if (!conf) throw new Error(`Unknown agent "${agent}"`);
    let resolver = this.resolvers.get(agent);
    if (!resolver) {
      resolver = new DefaultAgentCardResolver({ fetchImpl: conf.fetchImpl, path: conf.cardPath });
      this.resolvers.set(agent, resolver);
    }
    const card = await this.attempt(agent, () => resolver.resolve(conf.url, conf.cardPath), true);
    this.markReady(agent);
    this.emit({ type: "a2a:card-refresh", agent });
    this.writeCard(agent, card);
    return card;
  }

  /** Seed the card cache from the client's already-resolved card (no wire call). */
  private async refreshCard(agent: string, client: Client) {
    const card = await client.getAgentCard();
    this.writeCard(agent, card);
    return card;
  }

  private writeCard(agent: string, card: AgentCard): void {
    this.cache.write({ kind: "card", agent }, card, {
      tags: [cardTag(agent), agentTag(agent)],
      staleTime: this.cfg.cardStaleTime ?? 5 * 60_000,
    });
  }

  // ── resilience plumbing ───────────────────────────────────────────────────
  /**
   * Run a wire call under the configured retry policy (or single-attempt when
   * none). Threads status through: each scheduled retry marks the agent
   * `degraded` with the attempt count and the `retryAt` stamp; a final failure
   * leaves it `degraded` (the client object is still usable — eviction, which
   * is terminal, sets `closed` in `client()` instead and wins over this).
   */
  private attempt<T>(agent: string, fn: () => Promise<T>, idempotent: boolean): Promise<T> {
    const policy = this.cfg.retry;
    const run = policy
      ? withRetry(() => fn(), policy, {
          idempotent,
          onRetry: (err, attemptNo, delayMs) =>
            this.setStatus(agent, {
              state: "degraded",
              attempt: attemptNo + 1,
              retryAt: Date.now() + delayMs,
              lastError: asError(err),
            }),
        })
      : fn();
    return run.catch((err) => {
      // Connect failures evict the client and set "closed" first — keep that.
      if (this.status.get(agent)?.state !== "closed") {
        this.setStatus(agent, { state: "degraded", lastError: asError(err), retryAt: undefined });
      }
      throw err;
    });
  }

  /** A successful wire call: back to ready (attempt auto-resets, errors cleared). */
  private markReady(agent: string): void {
    this.setStatus(agent, { state: "ready", lastError: undefined, retryAt: undefined });
  }

  private setStatus(agent: string, partial: Partial<PeerStatus> & { state: ConnectivityState }): void {
    const prev = this.status.get(agent)?.state;
    this.status.set(agent, partial);
    if (prev !== partial.state) this.emit({ type: "a2a:status", agent, state: partial.state });
  }

  private emit(e: A2ADevtoolsEvent): void {
    this.cfg.devtools?.emit(e);
  }

  // ── messages & tasks ──────────────────────────────────────────────────────
  /**
   * Send a message. A direct Message reply is returned as-is; a Task reply is
   * cached and wrapped in a poll-driven TaskHandle whose paused states route
   * through the broker.
   *
   * **Idempotency contract.** If `message.messageId` is empty, a2aq generates
   * one client-side BEFORE the first attempt; either way the SAME messageId is
   * sent on every retry attempt (when a `retry` policy is configured). The A2A
   * messageId IS the idempotency key: an agent that already processed the id
   * can dedupe the duplicate delivery, which is what makes retrying a send safe.
   */
  async sendMessage(agent: string, message: Message): Promise<Message | TaskHandle> {
    const outbound: Message = message.messageId ? message : { ...message, messageId: newMessageId() };
    const result = await this.attempt(
      agent,
      async () => {
        const client = await this.client(agent);
        return client.sendMessage({ tenant: "", message: outbound, configuration: undefined, metadata: undefined });
      },
      true, // safe: the fixed messageId above is the dedupe key
    );
    this.markReady(agent);
    this.emit({
      type: "a2a:send",
      agent,
      taskId: this.isTask(result) ? result.id : outbound.taskId || undefined,
      messageId: outbound.messageId,
    });
    if (this.isTask(result)) {
      this.writeTask(agent, result);
      return this.makeHandle(agent, result);
    }
    return result;
  }

  /** A handle for an existing task (e.g. resumed from a stored id). */
  async task(agent: string, taskId: string): Promise<TaskHandle> {
    const task = await this.attempt(
      agent,
      async () => {
        const client = await this.client(agent);
        return client.getTask({ tenant: "", id: taskId, historyLength: undefined });
      },
      true, // read
    );
    this.markReady(agent);
    this.writeTask(agent, task);
    return this.makeHandle(agent, task);
  }

  /** Reactive snapshot access for hooks/dashboards. */
  taskSnapshot(agent: string, taskId: string): CacheEntry<unknown, A2AKey> | undefined {
    return this.cache.getSnapshot({ kind: "task", agent, taskId });
  }

  private isTask(r: Message | Task): r is Task {
    return typeof (r as Task).status === "object" && (r as Task).status !== null;
  }

  private writeTask(agent: string, task: Task): void {
    this.cache.write({ kind: "task", agent, taskId: task.id }, task, {
      tags: [taskTag(agent, task.id), agentTag(agent)],
      staleTime: this.taskPollMs,
    });
  }

  private makeHandle(agent: string, seed: Task): TaskHandle {
    const key: A2AKey = { kind: "task", agent, taskId: seed.id };
    let loop: Promise<void> | undefined;
    let settled = false;
    /**
     * Broker re-prompt guard. The broker is prompted only on a *transition into*
     * a paused state: once prompted, the handle stays quiet while the task sits
     * in that same state across polls (the agent may take several polls to
     * process a resume), and re-arms only after observing the task leave it.
     * A different paused state (INPUT_REQUIRED → AUTH_REQUIRED) is a new pause.
     */
    let lastState: TaskState | undefined;
    /** Single-flight guard: at most one broker gate() in flight per handle. */
    let brokerInflight: Promise<void> | undefined;
    /** Devtools change-tracking: last emitted state + artifact ids already seen. */
    let lastEmittedState: TaskState | undefined;
    const seenArtifacts = new Set<string>();
    let resolveResult!: (t: Task) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<Task>((res, rej) => ((resolveResult = res), (rejectResult = rej)));
    result.catch(() => {}); // callers may never ask for the result

    /** Emit devtools events for state CHANGES and newly-arrived artifacts only. */
    const observe = (task: Task): void => {
      if (!this.cfg.devtools) return;
      const state = task.status?.state;
      if (state !== undefined && state !== lastEmittedState) {
        lastEmittedState = state;
        this.emit({ type: "a2a:task-status", agent, taskId: task.id, state: stateName(state) });
      }
      for (const artifact of task.artifacts ?? []) {
        const id = artifact.artifactId;
        if (id && !seenArtifacts.has(id)) {
          seenArtifacts.add(id);
          this.emit({ type: "a2a:artifact", agent, taskId: task.id, artifactId: id });
        }
      }
    };
    observe(seed);

    const settle = (task: Task): boolean => {
      if (settled) return true;
      const state = task.status?.state;
      if (state === TaskState.TASK_STATE_COMPLETED) {
        settled = true;
        resolveResult(task);
      } else if (state !== undefined && TERMINAL.has(state)) {
        settled = true;
        const verb =
          state === TaskState.TASK_STATE_CANCELED
            ? "was canceled"
            : state === TaskState.TASK_STATE_REJECTED
              ? "was rejected"
              : "failed";
        // Surface the server's error detail (status message text) when present.
        const detail = statusMessageText(task);
        rejectResult(new Error(`task ${task.id} ${verb}${detail ? `: ${detail}` : ""}`));
      }
      return settled;
    };

    /**
     * Resume sends share the send idempotency contract: the messageId is fixed
     * before the first attempt and reused across retries (see `sendMessage`).
     */
    const respond = async (message: Message): Promise<void> => {
      const current = (this.cache.getSnapshot(key)?.data as Task | undefined) ?? seed;
      const currentState = current.status?.state;
      if (settled || (currentState !== undefined && TERMINAL.has(currentState))) {
        throw new Error(
          `task ${seed.id} is already terminal (${currentState !== undefined ? TaskState[currentState] : "settled"}); cannot respond`,
        );
      }
      const followUp: Message = {
        ...message,
        taskId: seed.id,
        messageId: message.messageId || newMessageId(),
      };
      const res = await this.attempt(
        agent,
        async () => {
          const client = await this.client(agent);
          return client.sendMessage({ tenant: "", message: followUp, configuration: undefined, metadata: undefined });
        },
        true, // fixed messageId above is the dedupe key
      );
      this.markReady(agent);
      this.emit({ type: "a2a:send", agent, taskId: seed.id, messageId: followUp.messageId });
      if (this.isTask(res)) this.writeTask(agent, res);
    };

    const maybeBroker = (task: Task): void => {
      const state = task.status?.state;
      const prev = lastState;
      if (state !== undefined) lastState = state;
      if (state === undefined || !PAUSED.has(state)) return;
      if (state === prev) return; // still parked in the same pause — already prompted
      if (brokerInflight) return; // single-flight: one gate at a time per handle
      if (!this.interactions) return; // app drives respond() manually via the cache state
      const type = state === TaskState.TASK_STATE_INPUT_REQUIRED ? "input-required" : "auth-required";
      const kind = state === TaskState.TASK_STATE_INPUT_REQUIRED ? ("input" as const) : ("auth" as const);
      brokerInflight = this.interactions
        .gate(type, agent, task)
        .then(({ decision }) => {
          this.emit({ type: "a2a:gate", agent, taskId: task.id, kind, outcome: decision.action });
          if (decision.action === "approve" && decision.message) {
            return respond(decision.message).catch(() => {});
          }
          return undefined;
        })
        .catch(() => {})
        .finally(() => {
          brokerInflight = undefined;
        });
    };

    // A transiently-failing poll is retried per the policy (idempotent read)
    // INSTEAD of settling the handle; only exhaustion reaches the loop's catch.
    // Retries happen inside ONE pollOnce() call, so pause tracking (maybeBroker)
    // still sees each successfully-observed state exactly once — a retried poll
    // cannot double-prompt the broker.
    const pollOnce = async (): Promise<Task> => {
      const task = await this.attempt(
        agent,
        async () => {
          const client = await this.client(agent);
          return client.getTask({ tenant: "", id: seed.id, historyLength: undefined });
        },
        true, // read
      );
      this.markReady(agent);
      this.writeTask(agent, task);
      return task;
    };

    const ensureLoop = (): void => {
      if (loop || settled) return;
      loop = (async () => {
        if (settle(seed)) return;
        maybeBroker(seed);
        for (;;) {
          let task: Task;
          try {
            task = await pollOnce();
          } catch (err) {
            settled = true;
            rejectResult(err);
            return;
          }
          observe(task);
          if (settle(task)) return;
          maybeBroker(task);
          await new Promise((r) => setTimeout(r, this.taskPollMs));
        }
      })();
    };

    return {
      taskId: seed.id,
      agent,
      task: () => this.cache.getSnapshot(key)?.data as Task | undefined,
      subscribe: (fn) => {
        ensureLoop();
        return this.cache.subscribe(key, () => {
          const t = this.cache.getSnapshot(key)?.data as Task | undefined;
          if (t) fn(t);
        });
      },
      result: () => {
        ensureLoop();
        return result;
      },
      respond,
      cancel: async () => {
        const client = await this.client(agent);
        let task: Task;
        try {
          task = await client.cancelTask({ tenant: "", id: seed.id, metadata: undefined });
        } catch (err) {
          // Canceling an already-terminal task is a server-side error in the SDK;
          // refresh the snapshot instead of bubbling when the task is settled.
          try {
            task = await client.getTask({ tenant: "", id: seed.id, historyLength: undefined });
          } catch {
            throw err;
          }
          const state = task.status?.state;
          if (state === undefined || !TERMINAL.has(state)) throw err;
        }
        this.writeTask(agent, task);
        observe(task);
      },
    };
  }
}

/** Text of the message attached to a task's status, if any (server error detail). */
function statusMessageText(task: Task): string {
  const parts = task.status?.message?.parts ?? [];
  return parts
    .map((p) => (p.content?.$case === "text" ? String(p.content.value) : ""))
    .filter(Boolean)
    .join(" ");
}
