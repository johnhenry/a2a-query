// 06 · Policy autopilot — the broker's trust policy decides without a human.
// "allow" auto-approves (here: auto-answer a form-filling agent from app
// state); "deny" auto-blocks and the task stays parked in its paused state.
// Run: npx tsx examples/06-policy-autopilot.ts

import { TaskState } from "@a2a-js/sdk";
import { A2AQuery, InteractionBroker, type InputDecision, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor, askAuthThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

// Policy: plain input requests are fine to auto-handle; auth requests never are.
const broker = new InteractionBroker<InputDecision>({
  policy: ({ type }) => (type === "input-required" ? "allow" : "deny"),
});
// "allow" synthesizes an approval without a resume message — the pause is
// cleared for handling, and the app supplies the actual answer via respond().
// "deny" blocks silently: no resume is ever sent and the task stays paused.

const inputAgent = new MockA2AAgent(askThenEchoExecutor(), { name: "form-filler" });
const authAgent = new MockA2AAgent(askAuthThenEchoExecutor(), { name: "bank-agent" });

const q = new A2AQuery({
  agents: {
    form: { url: inputAgent.url, fetchImpl: inputAgent.fetchImpl },
    bank: { url: authAgent.url, fetchImpl: authAgent.fetchImpl },
  },
  interactions: broker,
  taskPollMs: 25,
});

// ── allowed: input-required is auto-approved (no human, no queue) ────────────
const formHandle = (await q.sendMessage("form", msg("fill the intake form"))) as TaskHandle;
formHandle.result().catch(() => {});
await new Promise((r) => setTimeout(r, 100));
console.log("form task :", TaskState[formHandle.task()!.status!.state], "— policy auto-approved (no message ⇒ app supplies the answer)");
await formHandle.respond(msg("name: Ada, dept: R&D"));
const formTask = await formHandle.result();
console.log("form done :", TaskState[formTask.status!.state]);

// ── denied: auth-required is auto-blocked; the task stays paused ─────────────
const bankHandle = (await q.sendMessage("bank", msg("move $10,000"))) as TaskHandle;
bankHandle.result().catch(() => {});
await new Promise((r) => setTimeout(r, 150));
console.log("bank task :", TaskState[bankHandle.task()!.status!.state], "— policy auto-denied, no resume sent");

console.log("\naudit:");
for (const e of broker.auditLog()) console.log(`  ${e.peer.padEnd(5)} ${e.type.padEnd(15)} → ${e.outcome}`);

// Tidy up so the process can exit: cancel the parked bank task.
await bankHandle.cancel();
await bankHandle.result().catch((err: Error) => console.log("\nbank task settled:", err.message));
