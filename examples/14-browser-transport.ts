// 14 · Browser transport — the same A2AQuery a page would build, talking to a
// REAL local HTTP server (agent card, JSON-RPC, SSE) from a different origin.
// `browserLikeFetch` applies the browser's CORS rules (preflight, allow-headers,
// response-header filtering) that Node's own fetch skips, so if this runs, the
// CORS config below is one a real page can use. The auth header is added by a
// fetch wrapper — the one seam a page has for credentials.
// Run: npm run example:14   (binds 127.0.0.1 on an ephemeral port)

import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import { browserLikeFetch, serveMockAgent } from "../src/testing/http.js";
import type { AgentCard, Message } from "@a2a-js/sdk";

const PAGE_ORIGIN = "https://app.example";
const msg = (text: string): Message =>
  ({ messageId: `m-${Date.now()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const mock = new MockA2AAgent(pacedStreamingExecutor({ stepMs: 10 }), { card: { capabilities: { streaming: true } } as Partial<AgentCard> });
const server = await serveMockAgent(mock, {
  cors: {
    origins: [PAGE_ORIGIN],
    // a2a-version rides on EVERY request (card GET included), so it must be allowed.
    headers: ["content-type", "authorization", "a2a-version", "a2a-extensions"],
  },
  requireBearer: "demo-token",
});

const pageFetch = browserLikeFetch({ origin: PAGE_ORIGIN });
const authedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer demo-token");
  return pageFetch(input, { ...init, headers });
};

const q = new A2AQuery({ agents: { remote: { url: server.url, fetchImpl: authedFetch } }, taskPollMs: 25 });
const handle = (await q.sendMessage("remote", msg("hello from a page"))) as TaskHandle;
const task = await handle.result();
console.log("state:", task.status?.state);
console.log("requests seen by the server:", server.requests.map((r) => r.method).join(" "));
await server.close();
