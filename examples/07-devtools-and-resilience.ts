// 07 · Devtools & resilience — a flaky network, a retry policy, live
// connectivity status, and a devtools timeline of everything that happened.
// The agent pauses INPUT_REQUIRED once (a broker gate shows up on the
// timeline), the first two sends die with a network error and are retried
// with the SAME messageId (the idempotency key), and the StatusStore narrates
// connecting → ready → degraded → ready as it happens.
// Run: npm run example:07   (in-process mock agent — no network)

import {
  A2AQuery,
  DevtoolsHub,
  InteractionBroker,
  type A2ADevtoolsEvent,
  type InputDecision,
  type TaskHandle,
} from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor, flakyFetchImpl } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (id: string, text: string): Message =>
  ({ messageId: id, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

// A mock agent behind a flaky network: the first 2 SendMessage POSTs fail.
const mock = new MockA2AAgent(askThenEchoExecutor(), { name: "flaky-agent" });
const fetchImpl = flakyFetchImpl(mock, { failFirst: 2, methods: ["SendMessage"] });

// Auto-approving broker: answer the pause as soon as it is gated.
const broker = new InteractionBroker<InputDecision>();
broker.subscribe(() => {
  for (const pending of broker.list()) {
    console.log(`[gate]    ${pending.type} from ${pending.peer} → approving`);
    broker.resolve(pending.id, { action: "approve", message: msg("m-answer", "the launch code is 42") });
  }
});

const hub = new DevtoolsHub<A2ADevtoolsEvent>();

const q = new A2AQuery({
  agents: { flaky: { url: mock.url, fetchImpl } },
  interactions: broker,
  taskPollMs: 25,
  // Deterministic backoff: full jitter with injected random() = 0.5 ⇒ half of
  // each capped delay, every run identical.
  retry: { retries: 3, baseDelayMs: 20, factor: 2, random: () => 0.5 },
  devtools: hub,
});

// Live connectivity narration (the store versions on every merge; print changes).
let lastPrinted: string | undefined;
q.status.subscribe(() => {
  const s = q.status.get("flaky");
  if (!s) return;
  const line = s.state === "degraded" ? `${s.state} (attempt ${s.attempt}, retrying: ${s.lastError?.message})` : s.state;
  if (line === lastPrinted) return;
  lastPrinted = line;
  console.log(`[status]  ${line}`);
});

// withRetry's backoff timers are unref'd (a pending retry never holds a real
// app open) — but this script IS only the retry, so hold the loop open here.
const keepAlive = setInterval(() => {}, 1_000);

console.log("── sending through a flaky network ──");
const handle = (await q.sendMessage("flaky", msg("m-1", "start the launch sequence"))) as TaskHandle;
const task = await handle.result();

const text = (task.artifacts ?? [])
  .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
  .join("");
console.log(`\nresult: ${text}`);

// Prove the idempotency contract on the wire log: every SendMessage attempt
// (including the two that died on the network) carried the same messageId.
const sendIds = mock.callLog
  .filter((c) => c.method === "SendMessage")
  .map((c) => (c.params as { message?: { messageId?: string } }).message?.messageId);
console.log(`sendMessage attempts on the wire: ${sendIds.length} → messageIds: ${[...new Set(sendIds)].join(", ")}`);

// The devtools timeline — everything the client did, in order.
console.log("\n── devtools timeline ──");
for (const e of hub.events()) {
  const { type, ...rest } = e;
  console.log(`${type.padEnd(16)} ${JSON.stringify(rest)}`);
}
clearInterval(keepAlive);
