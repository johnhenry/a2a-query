// 12 · Push-notification webhook — the disconnected-client story. Instead of
// polling, the client registers a webhook on the send; the agent POSTs every
// task update; createWebhookHandler folds each push into the SAME cache the
// poll/stream drivers write and (family rule) follows with a getTask
// reconcile. The receiver below never sends or polls — its snapshots are
// fed entirely by pushes.
//
// Delivery here is in-process: the mock agent's pushDelivery hands each POST
// Request (built by the SDK's own V1PushNotificationSerializer — identical
// wire shape) straight to the handler, standing in for the network hop the
// SDK's DefaultPushNotificationSender would make with global fetch.
// Run: npx tsx examples/12-push-webhook.ts

import {
  A2AQuery,
  DevtoolsHub,
  createWebhookHandler,
  type A2ADevtoolsEvent,
  type TaskHandle,
} from "../src/index.js";
import { MockA2AAgent, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import type { Message, Task } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const HOOK_URL = "http://receiver.local/hooks/worker";
const TOKEN = "example-token";

// ── the agent: pushes every execution event to the registered webhook ────────
let handler!: (req: Request) => Promise<Response>;
const mock = new MockA2AAgent(pacedStreamingExecutor({ chunks: ["alpha ", "beta ", "gamma"], stepMs: 30 }), {
  name: "worker",
  pushDelivery: async (req) => {
    console.log(`  ⇐ push  POST ${new URL(req.url).pathname}`);
    return handler(req);
  },
});

// ── the RECEIVER: a store fed only by webhooks (never sends, never polls) ────
const hub = new DevtoolsHub<A2ADevtoolsEvent>();
const receiver = new A2AQuery({
  agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } },
  devtools: hub,
});
handler = createWebhookHandler(receiver, { agent: "worker", token: TOKEN });

// ── the SENDER: registers the webhook ON the send, then walks away ───────────
const sender = new A2AQuery({ agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } } });
const handle = (await sender.sendMessage("worker", msg("crunch the numbers"), {
  push: { url: HOOK_URL, token: TOKEN },
})) as TaskHandle;
console.log(`sent task ${handle.taskId} with webhook registration — sender now idle\n`);

// Watch the receiver's snapshot converge, purely from pushes + reconcile.
const snapshot = (): Task | undefined => receiver.taskSnapshot("worker", handle.taskId)?.data as Task | undefined;
while (snapshot()?.status?.state !== 3 /* TASK_STATE_COMPLETED */) {
  await new Promise((r) => setTimeout(r, 20));
}

const task = snapshot()!;
console.log("\nreceiver's snapshot (never polled, never sent):");
console.log("  state:    ", task.status?.state, "(TASK_STATE_COMPLETED)");
console.log("  artifact: ", JSON.stringify(receiver.artifacts("worker", handle.taskId)[0]?.parts.length), "parts");

console.log("\ndevtools timeline on the receiver:");
for (const e of hub.events()) {
  if (e.type === "a2a:push") console.log(`  a2a:push   ${e.payload}  (${e.taskId})`);
  if (e.type === "a2a:task-status") console.log(`  a2a:status ${e.state}`);
}

// A bad actor without the token bounces off:
const res = await handler(new Request(HOOK_URL, { method: "POST", body: "{}" }));
console.log(`\nunauthenticated push → HTTP ${res.status}`);
