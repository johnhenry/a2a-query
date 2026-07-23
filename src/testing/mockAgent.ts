// In-process mock A2A agent — the SDK's OWN server stack (DefaultRequestHandler +
// JsonRpcTransportHandler + InMemoryTaskStore) served through an injected fetch,
// so tests exercise the real wire codec with no sockets. Provide an AgentExecutor
// (the SDK server contract) or use the helpers below.

import { TaskState, type AgentCard } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";

export type { AgentExecutor, ExecutionEventBus, RequestContext };

export interface MockA2AAgentOptions {
  name?: string;
  url?: string;
  card?: Partial<AgentCard>;
}

export class MockA2AAgent {
  readonly url: string;
  readonly card: AgentCard;
  callLog: Array<{ method: string; params: unknown }> = [];
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
    this.handler = new JsonRpcTransportHandler(
      new DefaultRequestHandler(this.card, new InMemoryTaskStore(), executor),
    );
  }

  /** Inject as AgentConfig.fetchImpl — serves the card (GET) and JSON-RPC (POST). */
  fetchImpl: typeof fetch = async (input, init) => {
    if (!init?.method || init.method.toUpperCase() === "GET") {
      return new Response(JSON.stringify(this.card), {
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.callLog.push({ method: String(body.method), params: body.params });
    const res = await this.handler.handle(body, new ServerCallContext());
    // Streaming methods return an async generator of JSON-RPC responses; the
    // first slice serves non-streaming clients, so drain to the LAST envelope.
    if (isAsyncGenerator(res)) {
      let last: unknown;
      for await (const chunk of res) last = chunk;
      return jsonResponse(last);
    }
    return jsonResponse(res);
  };
}

function isAsyncGenerator(v: unknown): v is AsyncGenerator<unknown> {
  return typeof (v as AsyncGenerator<unknown>)?.[Symbol.asyncIterator] === "function";
}

function jsonResponse(v: unknown): Response {
  return new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
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
  opts: { artifactText?: string } = {},
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
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: { state, timestamp: undefined } as never,
      metadata: undefined,
    } as never),
  );
}
