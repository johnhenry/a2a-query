// Resilience: the StatusStore lifecycle (connecting → ready → degraded →
// recovery → closed), the retry policy with the fixed-messageId idempotency
// contract, poll-loop retry composing with broker pause tracking, and the
// no-retry default staying exactly as before.

import { describe, it, expect } from "vitest";
import { A2AQuery, InteractionBroker, StatusStore, type InputDecision, type RetryPolicy, type TaskHandle } from "../src/index.js";
import {
  MockA2AAgent,
  askThenEchoExecutor,
  echoExecutor,
  flakyFetchImpl,
  type AgentExecutor,
} from "../src/testing/mockAgent.js";
import { msg, until, countCalls, artifactText } from "./helpers.js";

/** Deterministic, near-instant backoff: full jitter with random() = 0 ⇒ 0ms delays. */
const fastRetry: RetryPolicy = { retries: 3, baseDelayMs: 1, random: () => 0 };

function make(
  executor: AgentExecutor,
  opts: {
    flaky?: { failFirst: number; methods?: string[] };
    retry?: RetryPolicy;
    status?: StatusStore;
    interactions?: InteractionBroker<InputDecision>;
  } = {},
) {
  const mock = new MockA2AAgent(executor);
  const fetch = opts.flaky ? flakyFetchImpl(mock, opts.flaky) : mock.fetchImpl;
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: fetch } },
    taskPollMs: 15,
    retry: opts.retry,
    status: opts.status,
    interactions: opts.interactions,
  });
  return { mock, q };
}

const sendMessageIds = (mock: MockA2AAgent): string[] =>
  mock.callLog
    .filter((c) => c.method === "SendMessage")
    .map((c) => (c.params as { message?: { messageId?: string } }).message?.messageId ?? "");

describe("status store", () => {
  it("walks connecting → ready across a clean task lifecycle and stays ready", async () => {
    const { q } = make(echoExecutor());
    const states: string[] = [];
    q.status.subscribe(() => states.push(q.status.get("a1")!.state));

    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();

    expect(states[0]).toBe("connecting");
    expect(states).toContain("ready");
    expect(states).not.toContain("degraded");
    expect(q.status.get("a1")).toMatchObject({ state: "ready", attempt: 0 });
  });

  it("goes degraded on flaky sends (attempt + retryAt + lastError) and back to ready on recovery", async () => {
    const { q } = make(echoExecutor(), {
      flaky: { failFirst: 2, methods: ["SendMessage"] },
      retry: fastRetry,
    });
    const seen: Array<{ state: string; attempt: number; retryAt?: number }> = [];
    q.status.subscribe(() => {
      const s = q.status.get("a1")!;
      seen.push({ state: s.state, attempt: s.attempt, retryAt: s.retryAt });
    });

    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();

    const degraded = seen.filter((s) => s.state === "degraded");
    expect(degraded.map((s) => s.attempt)).toEqual([1, 2]); // one bump per scheduled retry
    expect(degraded.every((s) => typeof s.retryAt === "number")).toBe(true);
    // Recovery: ready again, attempt auto-reset, error cleared.
    expect(q.status.get("a1")).toMatchObject({ state: "ready", attempt: 0 });
    expect(q.status.get("a1")?.lastError).toBeUndefined();
  });

  it("marks the peer closed when a failed connect evicts the client", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: flakyFetchImpl(mock, { failFirst: 100 }) } },
    });
    await expect(q.sendMessage("a1", msg("hi"))).rejects.toThrow();
    await until(() => q.status.get("a1")?.state === "closed");
    expect(q.status.get("a1")?.state).toBe("closed");
    expect(q.status.get("a1")?.lastError).toBeInstanceOf(TypeError);
  });

  it("an injected StatusStore is shared across clients", async () => {
    const shared = new StatusStore();
    const a = new MockA2AAgent(echoExecutor(), { name: "alpha" });
    const b = new MockA2AAgent(echoExecutor(), { name: "beta" });
    const qa = new A2AQuery({ agents: { alpha: { url: a.url, fetchImpl: a.fetchImpl } }, status: shared, taskPollMs: 15 });
    const qb = new A2AQuery({ agents: { beta: { url: b.url, fetchImpl: b.fetchImpl } }, status: shared, taskPollMs: 15 });
    expect(qa.status).toBe(shared);
    expect(qb.status).toBe(shared);

    await ((await qa.sendMessage("alpha", msg("x"))) as TaskHandle).result();
    await ((await qb.sendMessage("beta", msg("y"))) as TaskHandle).result();

    const peers = shared.list().map(([name]) => name).sort();
    expect(peers).toEqual(["alpha", "beta"]);
    expect(shared.list().every(([, s]) => s.state === "ready")).toBe(true);
  });
});

describe("retry + idempotency", () => {
  it("reuses the SAME messageId across every send attempt (the idempotency key)", async () => {
    const { mock, q } = make(echoExecutor(), {
      flaky: { failFirst: 2, methods: ["SendMessage"] },
      retry: fastRetry,
    });
    // No messageId from the caller — a2aq must fix one BEFORE the first attempt.
    const bare = { role: "user", parts: [{ content: { $case: "text", value: "hi" } }] };
    const handle = (await q.sendMessage("a1", bare as never)) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toContain("echo: hi");

    const ids = sendMessageIds(mock);
    expect(ids).toHaveLength(3); // 2 failed attempts + the success — all on the wire log
    expect(ids[0]).toBeTruthy(); // generated client-side, not empty
    expect(new Set(ids).size).toBe(1); // identical on every attempt
  });

  it("no retry policy (default) still rejects on the first send failure — regression", async () => {
    const { mock, q } = make(echoExecutor(), { flaky: { failFirst: 1, methods: ["SendMessage"] } });
    await expect(q.sendMessage("a1", msg("hi"))).rejects.toThrow(/fetch failed/);
    expect(countCalls(mock, "SendMessage")).toBe(1); // single attempt, as before
    expect(q.status.get("a1")?.state).toBe("degraded"); // truthful: client still usable
  });

  it("retries transient poll failures instead of settling, without double-prompting the broker", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { mock, q } = make(askThenEchoExecutor(), {
      flaky: { failFirst: 3, methods: ["GetTask"] },
      retry: { ...fastRetry, retries: 5 },
      interactions: broker,
    });
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    const resultP = handle.result();

    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "approve", message: msg("the answer") });

    const task = await resultP; // poll failures were absorbed by the policy
    expect(artifactText(task)).toContain("got: the answer");
    // Composition with pause tracking: retried polls must not re-prompt.
    expect(broker.auditLog()).toHaveLength(1);
    expect(countCalls(mock, "SendMessage")).toBe(2); // original + one resume only
  });

  it("settles the handle rejected only when poll retries are exhausted", async () => {
    // A paused executor keeps the loop polling; every GetTask fails.
    const { q } = make(askThenEchoExecutor(), {
      flaky: { failFirst: 100, methods: ["GetTask"] },
      retry: { ...fastRetry, retries: 1 },
    });
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    await expect(handle.result()).rejects.toThrow(/fetch failed/);
    expect(q.status.get("a1")?.state).toBe("degraded");
  });

  it("card refetches are retried as idempotent reads", async () => {
    const { mock, q } = make(echoExecutor(), {
      flaky: { failFirst: 1, methods: ["GetAgentCard"] },
      retry: fastRetry,
    });
    const card = await q.card("a1"); // first GET fails, retry lands
    expect(card.name).toBe("mock-agent");
    expect(countCalls(mock, "GetAgentCard")).toBe(2);
    expect(q.status.get("a1")?.state).toBe("ready");
  });
});
