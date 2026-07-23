// 08 · Streaming — the agent card advertises capabilities.streaming, so the
// SAME TaskHandle surface is driven by sendMessageStream/resubscribeTask
// instead of polling: artifact chunks land in the cache as they arrive, a
// mid-stream network drop degrades the status and resubscribes (with the
// family-rule getTask reconcile), and the devtools timeline narrates every
// stream edge. Nothing about the consumer changes — subscribe/result/respond
// behave exactly as in the polling examples.
// Run: npm run example:08   (in-process mock agent — no network)

import { A2AQuery, DevtoolsHub, type A2ADevtoolsEvent, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, droppingStreamFetchImpl, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import type { AgentCard, Message } from "@a2a-js/sdk";

const msg = (id: string, text: string): Message =>
  ({ messageId: id, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

// A streaming-capable mock agent that emits its answer in paced chunks…
const mock = new MockA2AAgent(pacedStreamingExecutor({ chunks: ["stream", "ing", "works"], stepMs: 40 }), {
  name: "stream-agent",
  card: { capabilities: { streaming: true } } as Partial<AgentCard>,
});
// …behind a connection that DROPS after the first SSE event. The server keeps
// executing; the client degrades, resubscribes, reconciles, and finishes.
const fetchImpl = droppingStreamFetchImpl(mock, { dropAfterEvents: 1 });

const hub = new DevtoolsHub<A2ADevtoolsEvent>();
const q = new A2AQuery({
  agents: { streamer: { url: mock.url, fetchImpl } },
  taskPollMs: 25,
  devtools: hub, // a2a:stream events: open / drop / resubscribe / fallback
  // streaming: "auto" is the default — poll agents keep polling, this one streams.
});

q.status.subscribe(() => {
  const s = q.status.get("streamer");
  if (s?.state === "degraded") console.log(`[status]  degraded (${s.lastError?.message})`);
});

console.log("── sending to a streaming agent over a dropping connection ──");
const handle = (await q.sendMessage("streamer", msg("m-1", "go"))) as TaskHandle;

// Chunks land in the SAME cache entry a polling handle would write.
handle.subscribe((task) => {
  const text = (task.artifacts ?? [])
    .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
    .join("");
  console.log(`[chunk]   "${text}" (${task.status?.state === 2 ? "working" : "done"})`);
});

const task = await handle.result();
const text = (task.artifacts ?? [])
  .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
  .join("");
console.log(`\nresult: ${text}`);

// What actually hit the wire: ONE streaming send, a resubscribe after the drop,
// and the family-rule getTask reconciles bracketing it — no steady-state polling.
const methods = mock.callLog.map((c) => c.method).filter((m) => m !== "GetAgentCard");
console.log(`wire: ${methods.join(" → ")}`);

console.log("\n── devtools timeline ──");
for (const e of hub.events()) {
  const { type, ...rest } = e;
  console.log(`${type.padEnd(16)} ${JSON.stringify(rest)}`);
}
