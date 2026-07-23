// 10 · Wire log — devtoolsWire: true taps the injected fetch and emits
// a2a:wire summaries (method, taskId, sizes, status, streaming flag — bodies
// never dumped) into the SAME DevtoolsHub as the task-level events, so one
// timeline tells the whole story: what the client did AND what hit the wire.
// In a React app, hand the hub to the core's <AgentQueryDevtools> panel —
// see docs/api.md "Devtools" for the snippet.
// Run: npm run example:10   (in-process mock agent — no network)

import { A2AQuery, DevtoolsHub, type A2ADevtoolsEvent, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor, flakyFetchImpl } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (id: string, text: string): Message =>
  ({ messageId: id, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

// A flaky network (first send dies) makes the wire log earn its keep: the
// failed attempt and the retry both show up, same messageId, different fates.
const mock = new MockA2AAgent(echoExecutor(), { name: "wire-agent" });
const fetchImpl = flakyFetchImpl(mock, { failFirst: 1, methods: ["SendMessage"] });

const hub = new DevtoolsHub<A2ADevtoolsEvent>();
const q = new A2AQuery({
  agents: { wired: { url: mock.url, fetchImpl } },
  taskPollMs: 25,
  devtools: hub,
  devtoolsWire: true, // ← the fetch tap
  retry: { retries: 2, baseDelayMs: 20, random: () => 0.5 },
});

// withRetry's backoff timers are unref'd (a pending retry never holds a real
// app open) — but this script IS only the retry, so hold the loop open here.
const keepAlive = setInterval(() => {}, 1_000);

console.log("── one task over a flaky wire ──");
const handle = (await q.sendMessage("wired", msg("m-1", "ping"))) as TaskHandle;
await handle.result();
clearInterval(keepAlive);
console.log(`result: ${handle.artifactText()}\n`);

// One hub, two altitudes: task-level events tell intent, a2a:wire tells traffic.
console.log("── unified devtools timeline ──");
for (const e of hub.events()) {
  if (e.type === "a2a:wire") {
    const arrow = e.dir === "out" ? "→" : "←";
    const detail =
      e.error !== undefined ? `ERROR ${e.error}` : e.dir === "in" ? `${e.status}${e.streaming ? " (SSE)" : ""}` : `${e.bytes ?? 0}B`;
    console.log(`  wire ${arrow} ${e.method.padEnd(12)} ${detail}${e.taskId ? `  task=${e.taskId.slice(0, 8)}` : ""}`);
  } else {
    const { type, ...rest } = e;
    console.log(`${type.padEnd(16)} ${JSON.stringify(rest)}`);
  }
}
