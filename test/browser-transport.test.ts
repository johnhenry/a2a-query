// Browser transport: the same A2AQuery, over a REAL local HTTP server (sockets,
// SSE framing, CORS preflight) through a fetch that enforces browser CORS rules.
// Node's own fetch ignores CORS, so `browserLikeFetch` re-implements the
// browser's preflight + response-header checks; a server config that passes it
// is one a real page can talk to.

import { afterEach, describe, expect, it } from "vitest";
import type { AgentCard } from "@a2a-js/sdk";
import { A2AQuery, DevtoolsHub, type A2ADevtoolsEvent, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import { browserLikeFetch, serveMockAgent, type MockAgentServer } from "../src/testing/http.js";
import { artifactText, msg, until } from "./helpers.js";

const ORIGIN = "https://app.example";
let server: MockAgentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(executor = echoExecutor(), opts: Parameters<typeof serveMockAgent>[1] = {}) {
  const mock = new MockA2AAgent(executor, { card: { capabilities: { streaming: true } } as Partial<AgentCard> });
  server = await serveMockAgent(mock, opts);
  return { mock, server };
}

describe("serveMockAgent + browserLikeFetch", () => {
  it("a page on an allowed origin completes a task over real HTTP (preflight + POST)", async () => {
    const { server } = await start(echoExecutor(), { cors: { origins: [ORIGIN], headers: ["content-type", "authorization", "a2a-version"] } });
    const fetchImpl = browserLikeFetch({ origin: ORIGIN });
    const q = new A2AQuery({ agents: { a: { url: server.url, fetchImpl } }, streaming: false, taskPollMs: 15 });
    const h = (await q.sendMessage("a", msg("hi"))) as TaskHandle;
    const task = await h.result();
    expect(artifactText(task)).toContain("echo: hi");
    expect(server.requests.some((r) => r.method === "OPTIONS")).toBe(true);
  });

  it("fails like a browser when the origin is not allowed", async () => {
    const { server } = await start(echoExecutor(), { cors: { origins: ["https://other.example"] } });
    const fetchImpl = browserLikeFetch({ origin: ORIGIN });
    await expect(fetchImpl(`${server.url}/.well-known/agent-card.json`)).rejects.toThrow(/CORS/);
  });

  it("fails the preflight when a request header is not in Access-Control-Allow-Headers", async () => {
    const { server } = await start(echoExecutor(), { cors: { origins: [ORIGIN], headers: ["content-type"] } });
    const fetchImpl = browserLikeFetch({ origin: ORIGIN });
    await expect(
      fetchImpl(server.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: "{}" }),
    ).rejects.toThrow(/Access-Control-Allow-Headers/);
  });

  it("sends auth headers (via a fetch wrapper) on card, send and stream requests", async () => {
    const { server } = await start(pacedStreamingExecutor({ stepMs: 5 }), {
      cors: { origins: [ORIGIN], headers: ["content-type", "authorization", "a2a-version", "a2a-extensions"] },
      requireBearer: "tok-123",
    });
    const base = browserLikeFetch({ origin: ORIGIN });
    const authed: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer tok-123");
      return base(input, { ...init, headers });
    };
    const q = new A2AQuery({ agents: { a: { url: server.url, fetchImpl: authed } }, taskPollMs: 15 });
    const h = (await q.sendMessage("a", msg("stream me"))) as TaskHandle;
    const task = await h.result();
    expect(artifactText(task)).toContain("chunk-1");
    expect(server.requests.filter((r) => r.method !== "OPTIONS").every((r) => r.authorization === "Bearer tok-123")).toBe(true);
    expect(server.requests.some((r) => (r.accept ?? "").includes("text/event-stream"))).toBe(true);
  });

  it("rejects requests without the bearer token (401), as a protected agent would", async () => {
    const { server } = await start(echoExecutor(), { cors: { origins: [ORIGIN], headers: ["content-type", "authorization"] }, requireBearer: "tok" });
    const res = await browserLikeFetch({ origin: ORIGIN })(`${server.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(401);
  });

  it("applies responseHeaders to 401 responses too", async () => {
    const { server } = await start(echoExecutor(), {
      cors: { origins: [ORIGIN], headers: ["content-type", "authorization", "a2a-version"], expose: ["x-request-id"] },
      requireBearer: "tok",
      responseHeaders: { "x-request-id": "r9" },
    });
    const res = await browserLikeFetch({ origin: ORIGIN })(`${server.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBe("r9");
  });

  it("resubscribes after the SSE connection is cut mid-stream and still completes", async () => {
    const hub = new DevtoolsHub<A2ADevtoolsEvent>();
    const { server } = await start(pacedStreamingExecutor({ chunks: ["a", "b", "c", "d"], stepMs: 30 }), {
      cors: { origins: [ORIGIN], headers: ["content-type", "a2a-version"] },
      dropFirstStreamAfterEvents: 2,
    });
    const q = new A2AQuery({
      agents: { a: { url: server.url, fetchImpl: browserLikeFetch({ origin: ORIGIN }) } },
      devtools: hub,
      retry: { retries: 3, baseDelayMs: 5 },
      taskPollMs: 15,
    });
    const h = (await q.sendMessage("a", msg("go"))) as TaskHandle;
    await until(() => hub.events().some((e) => e.type === "a2a:stream" && e.phase === "resubscribe"), 4000);
    const task = await h.result();
    expect(artifactText(task)).toContain("d");
    const phases = hub.events().flatMap((e) => (e.type === "a2a:stream" ? [e.phase] : []));
    expect(phases).toContain("drop");
    expect(phases).toContain("resubscribe");
  });

  it("exposes only allowlisted response headers to the page", async () => {
    const { server } = await start(echoExecutor(), { cors: { origins: [ORIGIN], expose: ["x-request-id"] }, responseHeaders: { "x-request-id": "r1", "x-secret": "s" } });
    const res = await browserLikeFetch({ origin: ORIGIN })(`${server.url}/.well-known/agent-card.json`);
    expect(res.headers.get("x-request-id")).toBe("r1");
    expect(res.headers.get("x-secret")).toBeNull();
  });
});
