// 05 · Multi-agent — one A2AQuery over several agents, tasks in flight on
// both, and a mini dashboard rendered purely from cache snapshots (no extra
// wire calls): this is what a hooks layer or devtools panel would read.
// Run: npx tsx examples/05-multi-agent.ts

import { TaskState } from "@a2a-js/sdk";
import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const translator = new MockA2AAgent(echoExecutor(), { name: "translator" });
const researcher = new MockA2AAgent(askThenEchoExecutor(), { name: "researcher" });

const q = new A2AQuery({
  agents: {
    translator: { url: translator.url, fetchImpl: translator.fetchImpl },
    researcher: { url: researcher.url, fetchImpl: researcher.fetchImpl },
  },
  taskPollMs: 25,
});

const handles: TaskHandle[] = [
  (await q.sendMessage("translator", msg("bonjour"))) as TaskHandle,
  (await q.sendMessage("researcher", msg("find prior art"))) as TaskHandle,
];
for (const h of handles) h.result().catch(() => {}); // start the poll loops

function dashboard(): void {
  console.log("┌─ task dashboard ─────────────────────────────");
  for (const h of handles) {
    const entry = q.taskSnapshot(h.agent, h.taskId);
    const task = entry?.data as { status?: { state?: TaskState } } | undefined;
    const state = task?.status?.state;
    console.log(
      `│ ${h.agent.padEnd(11)} ${h.taskId.slice(0, 8)}…  ${state !== undefined ? TaskState[state] : "(pending)"}`,
    );
  }
  console.log("└──────────────────────────────────────────────");
}

await new Promise((r) => setTimeout(r, 80));
dashboard(); // translator done; researcher paused for input

const researchHandle = handles[1]!;
await researchHandle.respond(msg("narrow to 2024+"));
await Promise.all(handles.map((h) => h.result()));
dashboard(); // both COMPLETED

console.log("cards:", (await q.card("translator")).name, "+", (await q.card("researcher")).name);
