// Wire-level devtools: the fetch tap (a2aq's analog of the core's
// instrumentTransport, which targets send/onmessage transports). Opt-in via
// devtoolsWire; summaries only — bodies never dumped, SSE bodies never consumed.

import { describe, it, expect } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import { A2AQuery, DevtoolsHub, tapFetch, type A2ADevtoolsEvent, type A2AWireSummary, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor, flakyFetchImpl, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import { artifactText, msg } from "./helpers.js";

const wireEvents = (hub: DevtoolsHub<A2ADevtoolsEvent>) =>
  hub.events().filter((e): e is Extract<A2ADevtoolsEvent, { type: "a2a:wire" }> => e.type === "a2a:wire");

describe("tapFetch (standalone)", () => {
  it("summarizes JSON-RPC POSTs, card GETs, and network failures", async () => {
    const seen: A2AWireSummary[] = [];
    const okFetch: typeof fetch = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const tapped = tapFetch(okFetch, (e) => seen.push(e));

    await tapped("http://x/card"); // GET
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "GetTask", params: { tenant: "", id: "t-1" } });
    await tapped("http://x/a2a", { method: "POST", body });

    expect(seen[0]).toEqual({ dir: "out", method: "GetAgentCard" });
    expect(seen[1]).toEqual({ dir: "in", method: "GetAgentCard", status: 200, streaming: false });
    expect(seen[2]).toEqual({ dir: "out", method: "GetTask", taskId: "t-1", id: 7, bytes: body.length });
    expect(seen[3]).toEqual({ dir: "in", method: "GetTask", taskId: "t-1", id: 7, status: 200, streaming: false });

    const failFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const seenFail: A2AWireSummary[] = [];
    await expect(tapFetch(failFetch, (e) => seenFail.push(e))("http://x/a2a", { method: "POST", body })).rejects.toThrow(
      "fetch failed",
    );
    expect(seenFail[1]).toMatchObject({ dir: "in", method: "GetTask", error: "fetch failed" });
  });

  it("summarizes unparseable bodies as unknown without throwing", async () => {
    const seen: A2AWireSummary[] = [];
    const okFetch: typeof fetch = async () => new Response("{}", { status: 200 });
    await tapFetch(okFetch, (e) => seen.push(e))("http://x/a2a", { method: "POST", body: "not json" });
    expect(seen[0]).toMatchObject({ dir: "out", method: "unknown", bytes: 8 });
  });
});

describe("devtoolsWire", () => {
  it("emits a2a:wire request/response pairs for the whole lifecycle (no bodies)", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      taskPollMs: 15,
      devtools: hub,
      devtoolsWire: true,
    });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();

    const wire = wireEvents(hub);
    const methods = new Set(wire.map((e) => e.method));
    expect(methods).toContain("GetAgentCard");
    expect(methods).toContain("SendMessage");
    expect(methods).toContain("GetTask");
    // Pairs: every out has an in with a status.
    const outs = wire.filter((e) => e.dir === "out");
    const ins = wire.filter((e) => e.dir === "in");
    expect(outs.length).toBe(ins.length);
    expect(ins.every((e) => e.status === 200)).toBe(true);
    // GetTask events carry the taskId; nothing carries a params/body dump.
    expect(wire.filter((e) => e.method === "GetTask").every((e) => e.taskId === handle.taskId)).toBe(true);
    expect(wire.every((e) => !("params" in e) && !("body" in e))).toBe(true);
  });

  it("flags SSE responses as streaming without consuming them", async () => {
    const mock = new MockA2AAgent(pacedStreamingExecutor({ chunks: ["x", "y"], stepMs: 15 }), {
      card: { capabilities: { streaming: true } } as Partial<AgentCard>,
    });
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      taskPollMs: 15,
      devtools: hub,
      devtoolsWire: true,
    });
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toBe("x y"); // the stream still flowed through the tap

    const streamIn = wireEvents(hub).find((e) => e.method === "SendStreamingMessage" && e.dir === "in");
    expect(streamIn?.streaming).toBe(true);
  });

  it("records failed attempts (flaky network + retry) as error summaries", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: flakyFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] }) } },
      taskPollMs: 15,
      devtools: hub,
      devtoolsWire: true,
      retry: { retries: 2, baseDelayMs: 5, random: () => 0.5 },
    });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();

    const sends = wireEvents(hub).filter((e) => e.method === "SendMessage");
    expect(sends.some((e) => e.dir === "in" && e.error === "fetch failed")).toBe(true);
    expect(sends.some((e) => e.dir === "in" && e.status === 200)).toBe(true);
    // Same messageId on every attempt is proven elsewhere; here: both attempts summarized.
    expect(sends.filter((e) => e.dir === "out")).toHaveLength(2);
  });

  it("stays silent without the flag (and without a sink)", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      taskPollMs: 15,
      devtools: hub, // sink but no devtoolsWire
    });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(wireEvents(hub)).toHaveLength(0);

    // devtoolsWire without a sink: no crash, no tap.
    const q2 = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      taskPollMs: 15,
      devtoolsWire: true,
    });
    const h2 = (await q2.sendMessage("a1", msg("again"))) as TaskHandle;
    await h2.result();
  });
});
