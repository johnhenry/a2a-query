// 03 · Approval inbox — the human-in-the-loop pattern. The agent pauses
// INPUT_REQUIRED; the InteractionBroker queues it; a "human" (simulated below)
// reviews the pending queue and approves with a follow-up message, which
// resumes the task. The audit trail records every decision.
// Run: npx tsx examples/03-approval-inbox.ts

import { A2AQuery, InteractionBroker, type InputDecision, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const mock = new MockA2AAgent(askThenEchoExecutor(), { name: "hr-agent" });
const broker = new InteractionBroker<InputDecision>(); // default policy: "ask" a human

const q = new A2AQuery({
  agents: { hr: { url: mock.url, fetchImpl: mock.fetchImpl } },
  interactions: broker,
  taskPollMs: 25,
});

const handle = (await q.sendMessage("hr", msg("draft an offer letter"))) as TaskHandle;
const resultP = handle.result();

// ── the approval inbox (in a real app this is a UI bound to broker.subscribe) ─
while (broker.list().length === 0) await new Promise((r) => setTimeout(r, 20));

for (const pending of broker.list()) {
  console.log(`inbox: [#${pending.id}] ${pending.type} from "${pending.peer}"`);
  // The human reads the paused task and answers:
  broker.resolve(pending.id, { action: "approve", message: msg("salary band C, start date 8/1") });
}

const task = await resultP;
const text = (task.artifacts ?? [])
  .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
  .join("");
console.log("result:", text);

console.log("\naudit trail:");
for (const entry of broker.auditLog()) {
  console.log(`  ${new Date(entry.at).toISOString()}  ${entry.peer}  ${entry.type}  → ${entry.outcome}`);
}
