// Real-HTTP integration: a genuine 402 Response served over MockA2AAgent's own
// injected-fetch wire (not a hand-built error), captured by x402Fetch, and
// routed through A2AQuery's real interceptor onion + InteractionBroker.

import { describe, it, expect } from "vitest";
import { InteractionBroker } from "@johnhenry/agent-query-core";
import { A2AQuery, type TaskHandle } from "../src/index.js";
import { X402ChallengeError, type X402Decision } from "../src/x402Interceptor.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import { msg } from "./helpers.js";
import type { X402Challenge } from "../src/x402.js";

const CHALLENGE: X402Challenge = {
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", payTo: "0xabc", asset: "0xdef" }],
};

/** Serve a fabricated 402 for the first `failFirst` matching requests, then delegate. */
function payWallFetchImpl(mock: MockA2AAgent, opts: { failFirst: number; methods?: string[] }): typeof fetch {
  let served = 0;
  const matches = (method: string) => !opts.methods || opts.methods.includes(method);
  return async (input, init) => {
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const body = isGet ? undefined : (JSON.parse(String(init!.body)) as Record<string, unknown>);
    const method = isGet ? "GetAgentCard" : String(body!.method);
    if (served < opts.failFirst && matches(method)) {
      served++;
      return new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });
    }
    return mock.fetchImpl(input, init);
  };
}

describe("x402Interceptor (real HTTP integration)", () => {
  it("pays (simulated) and retries transparently on policy 'allow'", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const broker = new InteractionBroker<X402Decision>({ policy: () => "allow" });
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: payWallFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      x402: { enabled: true, broker },
      taskPollMs: 15,
    });

    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    const task = await handle.result();
    expect(task.status?.state).toBeDefined();
    expect(broker.auditLog().some((e) => e.type === "x402-payment" && e.outcome === "auto-allow")).toBe(true);
  });

  it("surfaces X402ChallengeError when the policy denies", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const broker = new InteractionBroker<X402Decision>({ policy: () => "deny" });
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: payWallFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      x402: { enabled: true, broker },
      taskPollMs: 15,
    });

    await expect(q.sendMessage("a1", msg("hi"))).rejects.toBeInstanceOf(X402ChallengeError);
    expect(broker.auditLog().some((e) => e.type === "x402-payment" && e.outcome === "auto-deny")).toBe(true);
  });

  it("policy 'ask' queues for a human; broker.resolve(approve) pays and retries", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const broker = new InteractionBroker<X402Decision>({ policy: () => "ask" });
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: payWallFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      x402: { enabled: true, broker },
      taskPollMs: 15,
    });

    const sent = q.sendMessage("a1", msg("hi"));
    await new Promise((r) => setTimeout(r, 20));
    const pending = broker.list().find((i) => i.type === "x402-payment");
    expect(pending).toBeDefined();
    broker.resolve(pending!.id, { action: "approve", requirement: CHALLENGE.accepts[0] });

    const handle = (await sent) as TaskHandle;
    const task = await handle.result();
    expect(task.status?.state).toBeDefined();
  });

  it("policy 'ask' with no resolution times out to deny", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const broker = new InteractionBroker<X402Decision>({ policy: () => "ask" });
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: payWallFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      x402: { enabled: true, broker, timeoutMs: 30 },
      taskPollMs: 15,
    });

    await expect(q.sendMessage("a1", msg("hi"))).rejects.toBeInstanceOf(X402ChallengeError);
  }, 10_000);

  it("is disabled by default — a 402 propagates as a plain error, not X402ChallengeError", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: payWallFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      taskPollMs: 15,
    });

    await expect(q.sendMessage("a1", msg("hi"))).rejects.not.toBeInstanceOf(X402ChallengeError);
  });
});
