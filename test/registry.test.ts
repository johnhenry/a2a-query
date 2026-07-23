// The multi-agent registry: routing, cache isolation, card staleness and
// tag-driven invalidation, unknown agents, and connect-failure retry.

import { describe, it, expect } from "vitest";
import { A2AQuery, agentTag, cardTag, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import { msg, tick, until, countCalls, artifactText } from "./helpers.js";

function twoAgents() {
  const alpha = new MockA2AAgent(echoExecutor(), { name: "alpha" });
  const beta = new MockA2AAgent(echoExecutor(), { name: "beta" });
  const q = new A2AQuery({
    agents: {
      alpha: { url: alpha.url, fetchImpl: alpha.fetchImpl },
      beta: { url: beta.url, fetchImpl: beta.fetchImpl },
    },
    taskPollMs: 15,
  });
  return { alpha, beta, q };
}

describe("multi-agent routing", () => {
  it("routes each send to its own agent and isolates cache entries per agent", async () => {
    const { alpha, beta, q } = twoAgents();
    expect(q.agents()).toEqual(["alpha", "beta"]);

    const ha = (await q.sendMessage("alpha", msg("to alpha"))) as TaskHandle;
    const hb = (await q.sendMessage("beta", msg("to beta"))) as TaskHandle;
    const [ta, tb] = await Promise.all([ha.result(), hb.result()]);

    expect(artifactText(ta)).toBe("echo: to alpha");
    expect(artifactText(tb)).toBe("echo: to beta");
    expect(countCalls(alpha, "SendMessage")).toBe(1);
    expect(countCalls(beta, "SendMessage")).toBe(1);

    // Cache entries live under distinct agent-scoped keys.
    expect(q.taskSnapshot("alpha", ha.taskId)?.data).toBeDefined();
    expect(q.taskSnapshot("beta", hb.taskId)?.data).toBeDefined();
    expect(q.taskSnapshot("alpha", hb.taskId)).toBeUndefined();
    expect((await q.card("alpha")).name).toBe("alpha");
    expect((await q.card("beta")).name).toBe("beta");
  });

  it("invalidateTags(agentTag) marks one agent's entries stale without touching the other", async () => {
    const { alpha, beta, q } = twoAgents();
    await q.card("alpha");
    await q.card("beta");
    const alphaGets = countCalls(alpha, "GetAgentCard");
    const betaGets = countCalls(beta, "GetAgentCard");

    q.cache.invalidateTags([agentTag("alpha")]);
    await q.card("alpha"); // stale → refetch
    await q.card("beta"); // untouched → cache hit
    expect(countCalls(alpha, "GetAgentCard")).toBeGreaterThan(alphaGets);
    expect(countCalls(beta, "GetAgentCard")).toBe(betaGets);
  });

  it("cardTag targets just the card entry", async () => {
    const { alpha, q } = twoAgents();
    await q.card("alpha");
    const gets = countCalls(alpha, "GetAgentCard");
    q.cache.invalidateTags([cardTag("alpha")]);
    await q.card("alpha");
    expect(countCalls(alpha, "GetAgentCard")).toBeGreaterThan(gets);
  });
});

describe("cards", () => {
  it("card() is typed, cached, and refetches after cardStaleTime", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      cardStaleTime: 40,
    });
    const card = await q.card("a1");
    expect(card.name).toBe("mock-agent"); // AgentCard-typed, no cast needed
    const gets = countCalls(mock, "GetAgentCard");
    await q.card("a1"); // fresh → cache hit
    expect(countCalls(mock, "GetAgentCard")).toBe(gets);
    await tick(60); // let it go stale
    await q.card("a1");
    expect(countCalls(mock, "GetAgentCard")).toBeGreaterThan(gets);
  });

  it("card({ refresh: true }) forces a refetch", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({ agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } } });
    await q.card("a1");
    const gets = countCalls(mock, "GetAgentCard");
    await q.card("a1", { refresh: true });
    expect(countCalls(mock, "GetAgentCard")).toBeGreaterThan(gets);
  });
});

describe("failure modes", () => {
  it("unknown agent throws", async () => {
    const { q } = twoAgents();
    await expect(q.sendMessage("nope", msg("hi"))).rejects.toThrow(/Unknown agent "nope"/);
    await expect(q.card("nope")).rejects.toThrow(/Unknown agent/);
  });

  it("a failed client creation is not cached — the next call retries and succeeds", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    let failures = 2;
    const flaky: typeof fetch = async (input, init) => {
      if (failures > 0) {
        failures--;
        throw new Error("network down");
      }
      return mock.fetchImpl(input, init);
    };
    const q = new A2AQuery({ agents: { a1: { url: mock.url, fetchImpl: flaky } }, taskPollMs: 15 });

    // Two connect attempts fail (card resolution) — each must clear the client map…
    await expect(q.sendMessage("a1", msg("hi"))).rejects.toThrow(/network down/);
    await expect(q.sendMessage("a1", msg("hi"))).rejects.toThrow(/network down/);
    // …so the third attempt gets a fresh factory and succeeds. Before the fix
    // the first rejected promise was cached forever.
    const handle = (await q.sendMessage("a1", msg("third time lucky"))) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toBe("echo: third time lucky");
  });
});

describe("shared cache entries", () => {
  it("concurrent handles for the same task read the same snapshot", async () => {
    const { alpha, q } = twoAgents();
    const h1 = (await q.sendMessage("alpha", msg("hi"))) as TaskHandle;
    await h1.result();
    const h2 = await q.task("alpha", h1.taskId);
    expect(h2.taskId).toBe(h1.taskId);
    // Same cache entry: identical object reference, not merely equal data.
    expect(h2.task()).toBe(h1.task());
    expect(q.taskSnapshot("alpha", h1.taskId)?.data).toBe(h1.task());
    void alpha;
  });
});
