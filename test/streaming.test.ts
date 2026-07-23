// Streaming observation: sendMessageStream/resubscribeTask drive the SAME cache
// entries and handle lifecycle the poll loop drives — status transitions,
// artifacts, broker gating, devtools — plus the failure ladder: mid-stream drop
// → degraded → resubscribe (reconciled per the family rule) → poll fallback.

import { describe, it, expect } from "vitest";
import { TaskState, type AgentCard } from "@a2a-js/sdk";
import {
  A2AQuery,
  DevtoolsHub,
  InteractionBroker,
  type A2ADevtoolsEvent,
  type InputDecision,
  type TaskHandle,
} from "../src/index.js";
import {
  MockA2AAgent,
  askThenEchoExecutor,
  droppingStreamFetchImpl,
  echoExecutor,
  pacedStreamingExecutor,
  type AgentExecutor,
} from "../src/testing/mockAgent.js";
import { artifactText, countCalls, msg, until } from "./helpers.js";

interface StreamSetupOpts {
  interactions?: InteractionBroker<InputDecision>;
  devtools?: DevtoolsHub<A2ADevtoolsEvent>;
  streaming?: boolean | "auto";
  retry?: { retries: number; baseDelayMs?: number; random?: () => number };
  card?: Partial<AgentCard>;
  wrap?: (mock: MockA2AAgent) => typeof fetch;
}

/** A mock agent whose card advertises streaming, wired into a fresh A2AQuery. */
function streamSetup(executor: AgentExecutor, opts: StreamSetupOpts = {}) {
  const mock = new MockA2AAgent(executor, {
    card: { capabilities: { streaming: true }, ...opts.card } as Partial<AgentCard>,
  });
  const fetchImpl = opts.wrap ? opts.wrap(mock) : mock.fetchImpl;
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl } },
    interactions: opts.interactions,
    devtools: opts.devtools,
    streaming: opts.streaming,
    retry: opts.retry,
    taskPollMs: 15,
  });
  return { mock, q };
}

const phases = (hub: DevtoolsHub<A2ADevtoolsEvent>) =>
  hub.events().flatMap((e) => (e.type === "a2a:stream" ? [e.phase] : []));

describe("streaming mode selection", () => {
  it("streams when the card advertises capabilities.streaming (no polls needed)", async () => {
    const { mock, q } = streamSetup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toBe("echo: hi");
    expect(countCalls(mock, "SendStreamingMessage")).toBe(1);
    expect(countCalls(mock, "SendMessage")).toBe(0);
    // The whole lifecycle arrived on the stream — nothing to poll.
    expect(countCalls(mock, "GetTask")).toBe(0);
  });

  it("streaming: false forces the unary + poll path", async () => {
    const { mock, q } = streamSetup(echoExecutor(), { streaming: false });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(countCalls(mock, "SendStreamingMessage")).toBe(0);
    expect(countCalls(mock, "SendMessage")).toBe(1);
  });

  it('"auto" against a card WITHOUT streaming stays on the poll path', async () => {
    const { mock, q } = streamSetup(echoExecutor(), { card: { capabilities: {} as AgentCard["capabilities"] } });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(countCalls(mock, "SendStreamingMessage")).toBe(0);
    expect(countCalls(mock, "SendMessage")).toBe(1);
  });
});

describe("stream-driven cache + devtools", () => {
  it("artifact chunks land incrementally in the SAME cache entry subscribers watch", async () => {
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const { q } = streamSetup(pacedStreamingExecutor({ chunks: ["a", "b", "c"], stepMs: 20 }), {
      devtools: hub,
    });
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const seen: string[] = [];
    handle.subscribe((t) => seen.push(artifactText(t)));
    const task = await handle.result();

    expect(artifactText(task)).toBe("a b c");
    // Incremental arrival: some subscriber saw a strict prefix before the end.
    expect(seen.some((s) => s.length > 0 && s !== "a b c")).toBe(true);
    // Devtools tells the same story the poll loop would: status change + one artifact.
    const types = hub.events().map((e) => e.type);
    expect(types).toContain("a2a:task-status");
    expect(hub.events().filter((e) => e.type === "a2a:artifact")).toHaveLength(1);
    expect(phases(hub)).toEqual(["open"]);
  });

  it("terminal FAILED via the stream rejects with the server detail", async () => {
    const { failingExecutor } = await import("../src/testing/mockAgent.js");
    const { q } = streamSetup(failingExecutor("disk quota exceeded"));
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    await expect(handle.result()).rejects.toThrow(/failed: disk quota exceeded/);
  });
});

describe("mid-stream pause gating", () => {
  it("gates INPUT_REQUIRED through the broker exactly once and resumes", async () => {
    const broker = new InteractionBroker<InputDecision>();
    let prompts = 0;
    broker.subscribe(() => {
      for (const pending of broker.list()) {
        prompts++;
        broker.resolve(pending.id, { action: "approve", message: msg("answer-42") });
      }
    });
    const { mock, q } = streamSetup(askThenEchoExecutor(), { interactions: broker });
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    const task = await handle.result();

    expect(artifactText(task)).toBe("got: answer-42");
    expect(prompts).toBe(1);
    expect(broker.auditLog().filter((e) => e.outcome === "approved")).toHaveLength(1);
    expect(countCalls(mock, "SendStreamingMessage")).toBe(1); // the initial send streamed
    expect(countCalls(mock, "SendMessage")).toBe(1); // the resume is a unary send
  });
});

describe("stream drop → resubscribe (family rule) → poll fallback", () => {
  it("drops mid-stream, degrades, resubscribes, reconciles via getTask, completes", async () => {
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const { mock, q } = streamSetup(pacedStreamingExecutor({ stepMs: 40 }), {
      devtools: hub,
      wrap: (m) => droppingStreamFetchImpl(m, { dropAfterEvents: 1 }),
    });
    const degraded: boolean[] = [];
    q.status.subscribe(() => degraded.push(q.status.get("a1")?.state === "degraded"));

    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const task = await handle.result();

    expect(artifactText(task)).toBe("chunk-1 chunk-2 chunk-3");
    expect(phases(hub)).toEqual(["open", "drop", "resubscribe"]);
    expect(degraded).toContain(true); // honest status during the gap
    expect(countCalls(mock, "SubscribeToTask")).toBeGreaterThanOrEqual(1);
    // FAMILY RULE: the resubscribe was bracketed by full getTask reconciles.
    expect(countCalls(mock, "GetTask")).toBeGreaterThanOrEqual(1);
  });

  it("falls back to polling when resubscription keeps failing", async () => {
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const { mock, q } = streamSetup(pacedStreamingExecutor({ stepMs: 40 }), {
      devtools: hub,
      wrap: (m) => droppingStreamFetchImpl(m, { dropAfterEvents: 1, thenFailStreams: true }),
    });
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const task = await handle.result();

    expect(artifactText(task)).toBe("chunk-1 chunk-2 chunk-3");
    expect(phases(hub)).toEqual(["open", "drop", "fallback"]);
    expect(countCalls(mock, "GetTask")).toBeGreaterThanOrEqual(1); // the poll loop finished the job
  });

  it("reconcile catches out-of-band transitions the stream never delivered", async () => {
    const { mock, q } = streamSetup(askThenEchoExecutor()); // pauses; no broker
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED);

    // The gap was NOT empty: the task completes while no stream is attached.
    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_COMPLETED);
    const task = await handle.result();
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("re-opened handles stream too", () => {
  it("q.task() on a streaming agent observes via resubscribeTask", async () => {
    const { mock, q } = streamSetup(askThenEchoExecutor());
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED);

    const reopened = await q.task("a1", handle.taskId);
    const resultP = reopened.result();
    await until(() => countCalls(mock, "SubscribeToTask") >= 1);
    await reopened.respond(msg("resumed"));
    const task = await resultP;
    expect(artifactText(task)).toBe("got: resumed");
    expect(countCalls(mock, "SubscribeToTask")).toBeGreaterThanOrEqual(1);
  });
});
