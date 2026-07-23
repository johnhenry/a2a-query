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
  type BaseDecision,
  type CacheEntry,
} from "@johnhenry/agent-query-core";

import { agentTag, cardTag, serializeA2AKey, taskTag, type A2AKey } from "./keys.js";

/** The broker decision shape for paused tasks: approve with the follow-up message. */
export interface InputDecision extends BaseDecision {
  /** The message to resume the task with (its taskId is filled in automatically). */
  message?: Message;
}

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

export class A2AQuery {
  readonly cache: QueryCache<A2AKey>;
  readonly interactions?: InteractionBroker<InputDecision>;
  private clients = new Map<string, Promise<Client>>();
  private resolvers = new Map<string, DefaultAgentCardResolver>();
  private cfg: A2AQueryConfig;
  private taskPollMs: number;

  constructor(cfg: A2AQueryConfig) {
    this.cfg = cfg;
    this.interactions = cfg.interactions;
    this.taskPollMs = cfg.taskPollMs ?? 150;
    this.cache = new QueryCache<A2AKey>({ serializeKey: serializeA2AKey });
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
      p = factory.createFromUrl(conf.url, conf.cardPath).then((client) => {
        void this.refreshCard(agent, client);
        return client;
      });
      this.clients.set(agent, p);
      // A failed connect (bad URL, unreachable card) must not poison the map
      // forever — drop the rejected promise so the next call can retry.
      p.catch(() => {
        if (this.clients.get(agent) === p) this.clients.delete(agent);
      });
    }
    return p;
  }

  // ── agent cards ───────────────────────────────────────────────────────────
  /** The agent's card, cached (cardStaleTime, default 5 min). */
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
    const card = await resolver.resolve(conf.url, conf.cardPath);
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

  // ── messages & tasks ──────────────────────────────────────────────────────
  /**
   * Send a message. A direct Message reply is returned as-is; a Task reply is
   * cached and wrapped in a poll-driven TaskHandle whose paused states route
   * through the broker.
   */
  async sendMessage(agent: string, message: Message): Promise<Message | TaskHandle> {
    const client = await this.client(agent);
    const result = await client.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined });
    if (this.isTask(result)) {
      this.writeTask(agent, result);
      return this.makeHandle(agent, result);
    }
    return result;
  }

  /** A handle for an existing task (e.g. resumed from a stored id). */
  async task(agent: string, taskId: string): Promise<TaskHandle> {
    const client = await this.client(agent);
    const task = await client.getTask({ tenant: "", id: taskId, historyLength: undefined });
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
    let resolveResult!: (t: Task) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<Task>((res, rej) => ((resolveResult = res), (rejectResult = rej)));
    result.catch(() => {}); // callers may never ask for the result

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

    const respond = async (message: Message): Promise<void> => {
      const current = (this.cache.getSnapshot(key)?.data as Task | undefined) ?? seed;
      const currentState = current.status?.state;
      if (settled || (currentState !== undefined && TERMINAL.has(currentState))) {
        throw new Error(
          `task ${seed.id} is already terminal (${currentState !== undefined ? TaskState[currentState] : "settled"}); cannot respond`,
        );
      }
      const client = await this.client(agent);
      const followUp: Message = { ...message, taskId: seed.id };
      const res = await client.sendMessage({ tenant: "", message: followUp, configuration: undefined, metadata: undefined });
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
      brokerInflight = this.interactions
        .gate(type, agent, task)
        .then(({ decision }) => {
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

    const pollOnce = async (): Promise<Task> => {
      const client = await this.client(agent);
      const task = await client.getTask({ tenant: "", id: seed.id, historyLength: undefined });
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
