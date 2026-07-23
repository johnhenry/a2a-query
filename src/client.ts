// A2AQuery — the reactive, cached, embeddable A2A client. Sits on the official
// @a2a-js/sdk Client (transports, wire, card resolution) and adds the stratum the
// SDK deliberately leaves out: a multi-agent registry/router (the SDK Client is
// single-endpoint), a TanStack-style cache over cards and tasks, poll-driven
// TaskHandles, and an approval broker for the protocol's paused task states
// (INPUT_REQUIRED / AUTH_REQUIRED — first-class human-in-the-loop resume points).

import { TaskState, type AgentCard, type Artifact, type Message, type StreamResponse, type Task } from "@a2a-js/sdk";
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

import { artifactText as artifactTextOf, artifactsText } from "./artifacts.js";
import { agentTag, artifactTag, cardTag, serializeA2AKey, taskTag, type A2AKey } from "./keys.js";

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
  /**
   * A streaming lifecycle edge for an observed task: the initial send stream
   * opened, a resubscribe (re)attached, the stream dropped mid-flight, or the
   * handle gave up on streaming and fell back to polling.
   */
  | { type: "a2a:stream"; agent: string; taskId: string; phase: "open" | "resubscribe" | "drop" | "fallback" }
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
  /**
   * Task observation mode. `"auto"` (default): stream (`sendMessageStream` /
   * `resubscribeTask`) when the agent card advertises `capabilities.streaming`,
   * poll otherwise. `true`: same as `"auto"` (streaming still requires the
   * capability — the wire method is rejected without it). `false`: always poll.
   * Polling remains the fallback and the reconnect path either way; a dropped
   * stream degrades the agent's status and resubscribes (governed by `retry`),
   * falling back to the poll loop when resubscription fails.
   */
  streaming?: boolean | "auto";
  /**
   * Store task snapshots WITHOUT their inline `artifacts` (large outputs live
   * only under their own `{ kind: "artifact" }` cache entries, readable via the
   * artifact accessors and individually evictable). Default false: task
   * snapshots keep the server-truth inline list AND artifacts are mirrored to
   * their own entries.
   */
  detachArtifacts?: boolean;
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
  /** The task's artifacts, from their own cache entries (works with `detachArtifacts`). */
  artifacts(): Artifact[];
  /** One artifact by id, from its own cache entry. */
  artifact(artifactId: string): Artifact | undefined;
  /**
   * Text convenience over the Part oneofs: with an id, that artifact's text
   * parts concatenated; without, every artifact's text joined by newlines.
   */
  artifactText(artifactId?: string): string;
}

/** Client-side message id — fixed before the first attempt so retries reuse it. */
const newMessageId = (): string => crypto.randomUUID();

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Collision-safe map key for the per-task artifact-id index. */
const artifactIndexKey = (agent: string, taskId: string): string => JSON.stringify([agent, taskId]);

const stateName = (state: TaskState): string => TaskState[state] ?? String(state);

export class A2AQuery {
  readonly cache: QueryCache<A2AKey>;
  readonly interactions?: InteractionBroker<InputDecision>;
  /** Per-agent connectivity (versioned, subscribable). Shared when injected via config. */
  readonly status: StatusStore;
  private clients = new Map<string, Promise<Client>>();
  private resolvers = new Map<string, DefaultAgentCardResolver>();
  /** Per-task artifact ids in arrival order — the listing index for `artifacts()`. */
  private artifactIds = new Map<string, Set<string>>();
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
    const params = { tenant: "", message: outbound, configuration: undefined, metadata: undefined };
    // One retried closure covers BOTH modes: a failed stream open is re-attempted
    // whole (fresh generator, same messageId — the dedupe key), exactly like a
    // failed unary send.
    const opened = await this.attempt(
      agent,
      async (): Promise<
        | { kind: "unary"; result: Message | Task }
        | { kind: "stream"; gen: AsyncGenerator<StreamResponse, void, undefined>; first: IteratorResult<StreamResponse, void> }
      > => {
        const client = await this.client(agent);
        if (await this.wantsStream(client)) {
          const gen = client.sendMessageStream(params);
          // Pull the first event here so connect errors surface under the retry policy.
          return { kind: "stream", gen, first: await gen.next() };
        }
        return { kind: "unary", result: await client.sendMessage(params) };
      },
      true, // safe: the fixed messageId above is the dedupe key
    );
    this.markReady(agent);
    if (opened.kind === "unary") {
      const result = opened.result;
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
    // Streaming: the first event decides the reply shape (the SDK server always
    // leads with the task — or a direct message for message-shaped replies).
    const payload = opened.first.done ? undefined : opened.first.value.payload;
    if (payload?.$case === "message") {
      await opened.gen.return?.();
      this.emit({ type: "a2a:send", agent, taskId: outbound.taskId || undefined, messageId: outbound.messageId });
      return payload.value;
    }
    if (payload?.$case !== "task") {
      await opened.gen.return?.();
      throw new Error(
        `agent "${agent}" opened a stream without a leading task event (got ${payload ? payload.$case : "nothing"})`,
      );
    }
    const task = payload.value;
    this.emit({ type: "a2a:send", agent, taskId: task.id, messageId: outbound.messageId });
    this.emit({ type: "a2a:stream", agent, taskId: task.id, phase: "open" });
    this.writeTask(agent, task);
    return this.makeHandle(agent, task, opened.gen);
  }

  /** Whether task observation should stream, given the config mode and the agent card. */
  private async wantsStream(client: Client): Promise<boolean> {
    if ((this.cfg.streaming ?? "auto") === false) return false;
    const card = await client.getAgentCard();
    return !!card.capabilities?.streaming;
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
    // Artifacts are mirrored to their own entries on every task write —
    // artifact-kind keys are the accessor/eviction surface either way.
    for (const artifact of task.artifacts ?? []) this.writeArtifact(agent, task.id, artifact);
    const data = this.cfg.detachArtifacts ? { ...task, artifacts: [] } : task;
    this.cache.write({ kind: "task", agent, taskId: task.id }, data, {
      tags: [taskTag(agent, task.id), agentTag(agent)],
      staleTime: this.taskPollMs,
    });
  }

  private writeArtifact(agent: string, taskId: string, artifact: Artifact): void {
    const indexKey = artifactIndexKey(agent, taskId);
    let ids = this.artifactIds.get(indexKey);
    if (!ids) this.artifactIds.set(indexKey, (ids = new Set()));
    ids.add(artifact.artifactId);
    this.cache.write({ kind: "artifact", agent, taskId, artifactId: artifact.artifactId }, artifact, {
      tags: [artifactTag(agent, taskId, artifact.artifactId), taskTag(agent, taskId), agentTag(agent)],
    });
  }

  // ── artifacts ─────────────────────────────────────────────────────────────
  /** A task's artifacts, read from their own cache entries (insertion order). */
  artifacts(agent: string, taskId: string): Artifact[] {
    const ids = this.artifactIds.get(artifactIndexKey(agent, taskId));
    if (!ids) return [];
    const out: Artifact[] = [];
    for (const artifactId of ids) {
      const a = this.cache.getSnapshot({ kind: "artifact", agent, taskId, artifactId })?.data as Artifact | undefined;
      if (a) out.push(a);
    }
    return out;
  }

  /** One artifact by id, from its own cache entry. */
  artifact(agent: string, taskId: string, artifactId: string): Artifact | undefined {
    return this.cache.getSnapshot({ kind: "artifact", agent, taskId, artifactId })?.data as Artifact | undefined;
  }

  /** The raw cache entry for an artifact — subscribe to it for reactive reads. */
  artifactSnapshot(agent: string, taskId: string, artifactId: string): CacheEntry<unknown, A2AKey> | undefined {
    return this.cache.getSnapshot({ kind: "artifact", agent, taskId, artifactId });
  }

  /**
   * Evict a task's artifact entries (one, or all of them) — reclaim large
   * outputs after consuming them. The task snapshot itself stays. Note a still-
   * observed task re-mirrors artifacts on its next write; eviction is for
   * settled tasks (or pair it with `detachArtifacts` for one-copy storage).
   */
  evictArtifacts(agent: string, taskId: string, artifactId?: string): void {
    const indexKey = artifactIndexKey(agent, taskId);
    const ids = this.artifactIds.get(indexKey);
    if (!ids) return;
    for (const id of artifactId ? [artifactId] : [...ids]) {
      this.cache.remove({ kind: "artifact", agent, taskId, artifactId: id });
      ids.delete(id);
    }
    if (ids.size === 0) this.artifactIds.delete(indexKey);
  }

  private makeHandle(
    agent: string,
    seed: Task,
    initialStream?: AsyncGenerator<StreamResponse, void, undefined>,
  ): TaskHandle {
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
      // Artifact entries are the canonical listing (inline task.artifacts is
      // empty under detachArtifacts); at observe() time they are already mirrored.
      for (const artifact of this.artifacts(agent, task.id)) {
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
      return task;
    };

    /**
     * The ONE per-observation application step, shared by the poll loop and the
     * stream loop: cache write → devtools change detection → settle → broker
     * gating. Returns true once the handle has settled.
     */
    const applyTask = (task: Task): boolean => {
      this.writeTask(agent, task);
      observe(task);
      if (settle(task)) return true;
      maybeBroker(task);
      return false;
    };

    const currentTask = (): Task => (this.cache.getSnapshot(key)?.data as Task | undefined) ?? seed;

    /** Fold one stream event into the SAME task snapshot the poll loop writes. */
    const applyStreamEvent = (ev: StreamResponse): boolean => {
      const p = ev.payload;
      if (!p) return settled;
      switch (p.$case) {
        case "task":
          return applyTask(p.value);
        case "statusUpdate": {
          const cur = currentTask();
          return applyTask({ ...cur, status: p.value.status ?? cur.status });
        }
        case "artifactUpdate": {
          const incoming = p.value.artifact;
          if (!incoming) return settled;
          // Merge against the artifact ENTRY (the canonical copy — inline task
          // artifacts are empty under detachArtifacts), then upsert in place.
          const existing = this.artifact(agent, seed.id, incoming.artifactId);
          const merged =
            existing && p.value.append ? { ...incoming, parts: [...existing.parts, ...incoming.parts] } : incoming;
          const list = this.artifacts(agent, seed.id);
          const at = list.findIndex((a) => a.artifactId === merged.artifactId);
          const artifacts = at < 0 ? [...list, merged] : list.map((a, i) => (i === at ? merged : a));
          return applyTask({ ...currentTask(), artifacts });
        }
        case "message":
          return settled; // agent chatter mid-stream — not task state
      }
    };

    /** FAMILY RULE: a full getTask read, reconverging the cache to server truth. */
    const reconcile = async (): Promise<boolean> => applyTask(await pollOnce());

    /**
     * Stream-driven observation. Consumes the initial send stream when given,
     * then loops resubscribe → reconcile → consume. Returns true when the
     * handle settled on the stream path; false ⇒ the caller falls back to the
     * poll loop (resubscription failed even under the retry policy). Reconcile
     * failures (retry-exhausted reads) propagate and settle the handle, exactly
     * like a failed poll.
     */
    const runStream = async (initial?: AsyncGenerator<StreamResponse, void, undefined>): Promise<boolean> => {
      let gen = initial;
      for (;;) {
        if (!gen) {
          // Reconcile BEFORE resubscribing: the task may have settled during the
          // gap (servers reject resubscription to terminal tasks).
          if (await reconcile()) return true;
          try {
            gen = await this.attempt(
              agent,
              async () => {
                const client = await this.client(agent);
                const g = client.resubscribeTask({ tenant: "", id: seed.id });
                // Pull the first event (the current task) here so connect errors
                // surface under the retry policy.
                const first = await g.next();
                if (!first.done) applyStreamEvent(first.value);
                return g;
              },
              true, // read-shaped: attaching to an existing task
            );
          } catch {
            this.emit({ type: "a2a:stream", agent, taskId: seed.id, phase: "fallback" });
            return false; // retry policy exhausted — poll from here on
          }
          this.markReady(agent);
          this.emit({ type: "a2a:stream", agent, taskId: seed.id, phase: "resubscribe" });
          // FAMILY RULE: after any resume/resubscribe, do a full getTask
          // reconcile — never assume the gap was empty.
          if (await reconcile()) {
            await gen.return?.();
            return true;
          }
        }
        try {
          for await (const ev of gen) {
            if (applyStreamEvent(ev)) {
              await gen.return?.();
              return true;
            }
          }
          // Graceful end without a terminal state (e.g. the executor's turn
          // ended on a pause): reconcile, breathe, resubscribe.
          gen = undefined;
          if (await reconcile()) return true;
          await sleep(this.taskPollMs);
        } catch (err) {
          // Mid-stream drop: degrade honestly, then loop back into resubscribe.
          this.emit({ type: "a2a:stream", agent, taskId: seed.id, phase: "drop" });
          this.setStatus(agent, { state: "degraded", lastError: asError(err), retryAt: undefined });
          gen = undefined;
        }
      }
    };

    const ensureLoop = (): void => {
      if (loop || settled) return;
      loop = (async () => {
        if (settle(seed)) return;
        maybeBroker(seed);
        let stream = initialStream;
        initialStream = undefined;
        let streaming = stream !== undefined;
        if (!streaming && (this.cfg.streaming ?? "auto") !== false) {
          // Handles without a live stream (q.task(), unary sends) still stream
          // when the card allows it — via resubscribeTask.
          try {
            streaming = await this.wantsStream(await this.client(agent));
          } catch {
            streaming = false; // client creation failures surface on the wire calls below
          }
        }
        if (streaming) {
          try {
            if (await runStream(stream)) return;
          } catch (err) {
            settled = true;
            rejectResult(err);
            return;
          }
          stream = undefined; // fell back: continue into the poll loop
        }
        for (;;) {
          let task: Task;
          try {
            task = await pollOnce();
          } catch (err) {
            settled = true;
            rejectResult(err);
            return;
          }
          if (applyTask(task)) return;
          await sleep(this.taskPollMs);
        }
      })();
    };
    // A live stream is already consuming server resources — drive it eagerly.
    // (Poll-mode handles stay lazy: the loop starts on result()/subscribe().)
    if (initialStream) ensureLoop();

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
      artifacts: () => this.artifacts(agent, seed.id),
      artifact: (artifactId: string) => this.artifact(agent, seed.id, artifactId),
      artifactText: (artifactId?: string) => {
        if (artifactId !== undefined) {
          const a = this.artifact(agent, seed.id, artifactId);
          return a ? artifactTextOf(a) : "";
        }
        return artifactsText(this.artifacts(agent, seed.id));
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
