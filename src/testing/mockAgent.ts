// In-process mock A2A agent — the SDK's OWN server stack (DefaultRequestHandler +
// JsonRpcTransportHandler + InMemoryTaskStore) served through an injected fetch,
// so tests exercise the real wire codec with no sockets. Provide an AgentExecutor
// (the SDK server contract) or use the helpers below.

import { TaskState, type AgentCard, type StreamResponse } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  V1PushNotificationSerializer,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationSender,
  type RequestContext,
} from "@a2a-js/sdk/server";

export type { AgentExecutor, ExecutionEventBus, RequestContext };

export interface MockA2AAgentOptions {
  name?: string;
  url?: string;
  card?: Partial<AgentCard>;
  /**
   * Enable push notifications: the card advertises
   * `capabilities.pushNotifications` and every execution event is dispatched
   * to each registered webhook config as a POST `Request` — serialized by the
   * SDK's own `V1PushNotificationSerializer` (`application/a2a+json`, token in
   * `X-A2A-Notification-Token`) — delivered to THIS function instead of the
   * network. The SDK's real `DefaultPushNotificationSender` uses global
   * `fetch` with no injection seam, so in-process tests swap the transport at
   * this boundary; the wire shape is identical.
   */
  pushDelivery?: (req: Request) => Promise<Response> | Response;
}

/** The taskId a StreamResponse concerns ("" for standalone messages ⇒ no dispatch). */
function pushTaskIdOf(ev: StreamResponse): string {
  switch (ev.payload?.$case) {
    case "task":
      return ev.payload.value.id;
    case "statusUpdate":
    case "artifactUpdate":
      return ev.payload.value.taskId;
    default:
      return "";
  }
}

/** In-process stand-in for DefaultPushNotificationSender — same payloads, injected delivery. */
class InProcessPushSender implements PushNotificationSender {
  private serializer = new V1PushNotificationSerializer();
  constructor(
    private store: InMemoryPushNotificationStore,
    private deliver: (req: Request) => Promise<Response> | Response,
  ) {}
  async send(streamResponse: StreamResponse, context: ServerCallContext): Promise<void> {
    const taskId = pushTaskIdOf(streamResponse);
    if (!taskId) return;
    for (const cfg of await this.store.load(taskId, context)) {
      const { body, contentType } = this.serializer.serialize(streamResponse);
      const headers: Record<string, string> = { "content-type": contentType };
      if (cfg.token) headers["x-a2a-notification-token"] = cfg.token;
      try {
        await this.deliver(new Request(cfg.url, { method: "POST", headers, body }));
      } catch {
        // The real sender logs and moves on — a webhook must never fail the task.
      }
    }
  }
}

export class MockA2AAgent {
  readonly url: string;
  readonly card: AgentCard;
  callLog: Array<{ method: string; params: unknown }> = [];
  /** The server's task store — inspect or (via setTaskState) mutate task state out-of-band. */
  readonly store: InMemoryTaskStore;
  /** The server's push-config store — inspect registered webhook configs. */
  readonly pushStore: InMemoryPushNotificationStore;
  private handler: JsonRpcTransportHandler;

  constructor(executor: AgentExecutor, opts: MockA2AAgentOptions = {}) {
    this.url = opts.url ?? "http://mock-agent.local/a2a";
    this.card = {
      protocolVersions: ["1.0"],
      name: opts.name ?? "mock-agent",
      description: "in-process mock A2A agent",
      version: "1.0.0",
      supportedInterfaces: [{ url: this.url, protocolBinding: "JSONRPC" }],
      capabilities: {},
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      ...opts.card,
    } as AgentCard;
    if (opts.pushDelivery && !this.card.capabilities?.pushNotifications) {
      this.card.capabilities = { ...this.card.capabilities, pushNotifications: true } as AgentCard["capabilities"];
    }
    this.store = new InMemoryTaskStore();
    this.pushStore = new InMemoryPushNotificationStore();
    this.handler = new JsonRpcTransportHandler(
      new DefaultRequestHandler(
        this.card,
        this.store,
        executor,
        undefined,
        this.pushStore,
        opts.pushDelivery ? new InProcessPushSender(this.pushStore, opts.pushDelivery) : undefined,
      ),
    );
  }

  /**
   * Force a task into a given state out-of-band — a deterministic way to drive
   * state transitions (leave / re-enter a pause) that a polling client observes.
   */
  async setTaskState(taskId: string, state: TaskState): Promise<void> {
    const ctx = new ServerCallContext();
    const task = await this.store.load(taskId, ctx);
    if (!task) throw new Error(`setTaskState: unknown task ${taskId}`);
    // Clone before mutating — never hand a mutated shared object back to a store.
    const next = { ...task, status: { ...task.status, state } } as typeof task;
    await this.store.save(next, ctx);
  }

  /** Inject as AgentConfig.fetchImpl — serves the card (GET) and JSON-RPC (POST). */
  fetchImpl: typeof fetch = async (input, init) => {
    if (!init?.method || init.method.toUpperCase() === "GET") {
      this.callLog.push({ method: "GetAgentCard", params: String(input) });
      return new Response(JSON.stringify(this.card), {
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.callLog.push({ method: String(body.method), params: body.params });
    const res = await this.handler.handle(body, new ServerCallContext());
    // Streaming methods return an async generator of JSON-RPC envelopes. A
    // client that asked for a stream (the SDK's JSON-RPC transport sends
    // `Accept: text/event-stream` for SendStreamingMessage / SubscribeToTask)
    // gets a REAL SSE response — one envelope per `data:` event, delivered as
    // the server produces them. Anyone else keeps the pre-streaming behavior:
    // drain to the LAST envelope and serve it as plain JSON.
    if (isAsyncGenerator(res)) {
      const accept = new Headers(init.headers).get("accept") ?? "";
      if (accept.includes("text/event-stream")) return sseResponse(res);
      let last: unknown;
      for await (const chunk of res) last = chunk;
      return jsonResponse(last);
    }
    return jsonResponse(res);
  };
}

export interface FlakyFetchOptions {
  /** Fail the first N matching requests, then delegate normally. */
  failFirst: number;
  /**
   * Restrict failures to these wire methods (`"SendMessage"`, `"GetTask"`,
   * `"CancelTask"`, `"GetAgentCard"` for card GETs). Default: every request.
   */
  methods?: string[];
  /** Error factory. Default: a network-ish `TypeError("fetch failed")` (undici-style). */
  error?: () => Error;
}

/**
 * Wrap a mock agent's fetch in transient network failure: the first
 * `failFirst` matching requests throw BEFORE reaching the server (the request
 * is still recorded in `mock.callLog`, so tests can assert what EVERY attempt
 * carried — e.g. that retries reuse the identical messageId), then delegates.
 */
export function flakyFetchImpl(mock: MockA2AAgent, opts: FlakyFetchOptions): typeof fetch {
  let failed = 0;
  const matches = (method: string) => !opts.methods || opts.methods.includes(method);
  const makeError = opts.error ?? (() => new TypeError("fetch failed"));
  return async (input, init) => {
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const body = isGet ? undefined : (JSON.parse(String(init!.body)) as Record<string, unknown>);
    const method = isGet ? "GetAgentCard" : String(body!.method);
    if (failed < opts.failFirst && matches(method)) {
      failed++;
      mock.callLog.push({ method, params: isGet ? String(input) : body!.params });
      throw makeError();
    }
    return mock.fetchImpl(input, init);
  };
}

export interface StreamDropOptions {
  /** Error the SSE stream after forwarding this many events (a mid-stream network drop). */
  dropAfterEvents: number;
  /** How many streaming requests to sabotage this way. Default 1 (the first). */
  streams?: number;
  /**
   * After the sabotaged streams, reject FURTHER streaming requests outright with
   * a network error instead of serving them — forces the client's resubscribe
   * attempts to exhaust and exercises the poll fallback. Default false.
   */
  thenFailStreams?: boolean;
  /** Error used both for the mid-stream drop and rejected resubscribes. */
  error?: () => Error;
}

/**
 * Wrap a mock agent's fetch so streaming responses DROP mid-stream: the first
 * `streams` SSE responses error after `dropAfterEvents` events (the server keeps
 * executing — only the client's connection dies), and, with `thenFailStreams`,
 * later streaming requests fail at connect time. Non-streaming traffic
 * (SendMessage / GetTask / card fetches) always passes through — exactly the
 * partial-failure shape a stream-drop → resubscribe/poll-fallback client must survive.
 */
export function droppingStreamFetchImpl(mock: MockA2AAgent, opts: StreamDropOptions): typeof fetch {
  const sabotage = opts.streams ?? 1;
  const makeError = opts.error ?? (() => new TypeError("stream dropped"));
  let streamCount = 0;
  return async (input, init) => {
    const wantsStream =
      init?.method?.toUpperCase() === "POST" && (new Headers(init.headers).get("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) return mock.fetchImpl(input, init);
    streamCount++;
    if (streamCount > sabotage) {
      if (opts.thenFailStreams) throw makeError();
      return mock.fetchImpl(input, init);
    }
    const res = await mock.fetchImpl(input, init);
    if (!res.body) return res;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let events = 0;
    const truncated = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (events >= opts.dropAfterEvents) {
          await reader.cancel().catch(() => {});
          controller.error(makeError());
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        events += (decoder.decode(value, { stream: true }).match(/\n\n/g) ?? []).length;
        controller.enqueue(value);
      },
      cancel: () => reader.cancel().catch(() => {}),
    });
    return new Response(truncated, { headers: res.headers });
  };
}

function isAsyncGenerator(v: unknown): v is AsyncGenerator<unknown> {
  return typeof (v as AsyncGenerator<unknown>)?.[Symbol.asyncIterator] === "function";
}

function jsonResponse(v: unknown): Response {
  return new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
}

/**
 * One JSON-RPC envelope per SSE `data:` event, flushed as the server yields.
 * The generator is pumped EAGERLY (not per client read): the SDK server
 * persists execution events as this generator is consumed, and a real agent
 * does not stop executing because a subscriber disconnected — so on client
 * cancel the pump keeps draining (persisting task state) and discards output.
 */
function sseResponse(gen: AsyncGenerator<unknown>): Response {
  const encoder = new TextEncoder();
  let discard = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for await (const value of gen) {
            if (discard) continue;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          }
          if (!discard) controller.close();
        } catch (err) {
          if (!discard) controller.error(err);
        }
      })();
    },
    cancel() {
      discard = true;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// ── executor helpers ─────────────────────────────────────────────────────────

/**
 * An executor that completes immediately with a text artifact echoing the user
 * message — the "hello world" of task lifecycles.
 */
export function echoExecutor(): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const text = textOf(ctx);
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      publishStatus(bus, ctx, TaskState.TASK_STATE_COMPLETED, { artifactText: `echo: ${text}` });
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: "",
          status: { state: TaskState.TASK_STATE_CANCELED, timestamp: undefined } as never,
          metadata: undefined,
        } as never),
      );
    },
  };
}

/**
 * An executor that streams: WORKING, then `chunks` artifact updates (appended to
 * one artifact) spaced `stepMs` apart, then COMPLETED. The pacing keeps the
 * execution alive long enough for mid-stream observation (drops, resubscribes).
 */
export function pacedStreamingExecutor(opts: { chunks?: string[]; stepMs?: number } = {}): AgentExecutor {
  const chunks = opts.chunks ?? ["chunk-1", "chunk-2", "chunk-3"];
  const stepMs = opts.stepMs ?? 25;
  const pause = () => new Promise((r) => setTimeout(r, stepMs));
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      for (let i = 0; i < chunks.length; i++) {
        await pause();
        bus.publish(
          AgentEvent.artifactUpdate({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            artifact: {
              artifactId: "out",
              name: "out",
              description: "",
              parts: [{ content: { $case: "text", value: chunks[i] } }],
              metadata: undefined,
              extensions: [],
            },
            append: i > 0,
            lastChunk: i === chunks.length - 1,
            metadata: undefined,
          } as never),
        );
      }
      await pause();
      publishStatus(bus, ctx, TaskState.TASK_STATE_COMPLETED);
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      publishCanceled(bus, taskId);
    },
  };
}

/**
 * An executor that pauses INPUT_REQUIRED on the first turn and completes on the
 * follow-up turn with the resumed message's text.
 */
export function askThenEchoExecutor(): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      if (!ctx.task) {
        publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
        publishStatus(bus, ctx, TaskState.TASK_STATE_INPUT_REQUIRED);
        return;
      }
      const text = textOf(ctx);
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      publishStatus(bus, ctx, TaskState.TASK_STATE_COMPLETED, { artifactText: `got: ${text}` });
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: "",
          status: { state: TaskState.TASK_STATE_CANCELED, timestamp: undefined } as never,
          metadata: undefined,
        } as never),
      );
    },
  };
}

/**
 * An executor that pauses AUTH_REQUIRED on the first turn (e.g. "connect your
 * calendar") and completes on the follow-up turn once credentials arrive.
 */
export function askAuthThenEchoExecutor(): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      if (!ctx.task) {
        publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
        publishStatus(bus, ctx, TaskState.TASK_STATE_AUTH_REQUIRED);
        return;
      }
      const text = textOf(ctx);
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      publishStatus(bus, ctx, TaskState.TASK_STATE_COMPLETED, { artifactText: `authed: ${text}` });
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      publishCanceled(bus, taskId);
    },
  };
}

/**
 * An executor that fails immediately, attaching `detail` as the status message —
 * the server-side error-detail path.
 */
export function failingExecutor(detail = "synthetic failure"): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      publishStatus(bus, ctx, TaskState.TASK_STATE_FAILED, { statusMessageText: detail });
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      publishCanceled(bus, taskId);
    },
  };
}

/** An executor that rejects the task outright (never starts working). */
export function rejectingExecutor(detail?: string): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      publishTask(bus, ctx, TaskState.TASK_STATE_WORKING);
      publishStatus(bus, ctx, TaskState.TASK_STATE_REJECTED, { statusMessageText: detail });
    },
    async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
      publishCanceled(bus, taskId);
    },
  };
}

function publishCanceled(bus: ExecutionEventBus, taskId: string): void {
  bus.publish(
    AgentEvent.statusUpdate({
      taskId,
      contextId: "",
      status: { state: TaskState.TASK_STATE_CANCELED, timestamp: undefined } as never,
      metadata: undefined,
    } as never),
  );
}

function textOf(ctx: RequestContext): string {
  const parts = (ctx.userMessage as { parts?: Array<{ content?: { $case: string; value?: unknown } }> }).parts ?? [];
  return parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")).join("");
}

function publishTask(bus: ExecutionEventBus, ctx: RequestContext, state: TaskState): void {
  bus.publish(
    AgentEvent.task({
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, timestamp: undefined } as never,
      history: [],
      artifacts: [],
      metadata: undefined,
    }),
  );
}

function publishStatus(
  bus: ExecutionEventBus,
  ctx: RequestContext,
  state: TaskState,
  opts: { artifactText?: string; statusMessageText?: string } = {},
): void {
  if (opts.artifactText != null) {
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        artifact: {
          artifactId: "out",
          name: "out",
          description: "",
          parts: [{ content: { $case: "text", value: opts.artifactText } }],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      } as never),
    );
  }
  const statusMessage =
    opts.statusMessageText != null
      ? {
          messageId: `status-${ctx.taskId}`,
          role: "agent",
          parts: [{ content: { $case: "text", value: opts.statusMessageText } }],
        }
      : undefined;
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, message: statusMessage, timestamp: undefined } as never,
      metadata: undefined,
    } as never),
  );
}
