// 04 · Manual resume — no broker at all. The app watches the cached task
// snapshot via handle.task(), notices the INPUT_REQUIRED pause itself, and
// resumes with handle.respond(). This is the right shape when pause handling
// is inlined in app logic rather than routed to an approval surface.
// Run: npx tsx examples/04-manual-resume.ts

import { TaskState } from "@a2a-js/sdk";
import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const mock = new MockA2AAgent(askThenEchoExecutor());
const q = new A2AQuery({ agents: { a: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 25 });
// note: no `interactions` broker configured — pauses just sit in the cache

const handle = (await q.sendMessage("a", msg("begin"))) as TaskHandle;
const resultP = handle.result(); // starts the poll loop

// Observe the pause via the snapshot (a dashboard would render this state).
while (handle.task()?.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
  await new Promise((r) => setTimeout(r, 20));
}
console.log("paused:", TaskState[handle.task()!.status!.state]);

await handle.respond(msg("42"));
console.log("responded — resuming");

const task = await resultP;
const text = (task.artifacts ?? [])
  .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
  .join("");
console.log("final:", TaskState[task.status!.state], "→", text);
