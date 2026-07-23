// Push-notification webhooks — registration (on-send and via the RPC), the
// inbound handler's fold + family-rule reconcile, auth, and malformed input.
// The mock agent runs the SDK's own DefaultRequestHandler with an in-process
// push sender (see MockA2AAgentOptions.pushDelivery): real payload shapes
// (V1PushNotificationSerializer), injected delivery instead of global fetch.

import { describe, it, expect } from "vitest";
import { TaskState, type Task } from "@a2a-js/sdk";
import {
  A2AQuery,
  DevtoolsHub,
  createWebhookHandler,
  type A2ADevtoolsEvent,
  type TaskHandle,
} from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor, echoExecutor } from "../src/testing/mockAgent.js";
import { artifactText, countCalls, msg, until } from "./helpers.js";

const HOOK_URL = "http://receiver.local/hooks/worker";
const TOKEN = "s3cret-token";

/** A mock agent whose pushes are POSTed straight into `handler`. */
function pushSetup(executor = echoExecutor()) {
  let handler: (req: Request) => Promise<Response>;
  const receipts: Response[] = [];
  const mock = new MockA2AAgent(executor, {
    pushDelivery: async (req) => {
      const res = await handler(req);
      receipts.push(res);
      return res;
    },
  });
  // The RECEIVER's store — a different A2AQuery than the sender's, so the
  // disconnected-client story is real: its cache is fed by webhooks only
  // (plus the reconcile reads the handler itself performs).
  const hub = new DevtoolsHub<A2ADevtoolsEvent>();
  const receiver = new A2AQuery({
    agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } },
    devtools: hub,
    taskPollMs: 15,
  });
  handler = createWebhookHandler(receiver, { agent: "worker", token: TOKEN });
  const sender = new A2AQuery({ agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
  return { mock, receiver, sender, hub, receipts, handler: (req: Request) => handler(req) };
}

const snapshotOf = (q: A2AQuery, taskId: string): Task | undefined =>
  q.taskSnapshot("worker", taskId)?.data as Task | undefined;

describe("end-to-end: register on send → agent pushes → handler folds + reconciles", () => {
  it("a disconnected receiver's cache converges to COMPLETED without ever polling", async () => {
    const { mock, receiver, sender, hub, receipts } = pushSetup();
    const handle = (await sender.sendMessage("worker", msg("do the thing"), {
      push: { url: HOOK_URL, token: TOKEN },
    })) as TaskHandle;
    // The sender never drives its handle (no result()/subscribe()) — every
    // cache write on the receiver side comes from pushes + reconcile.
    await until(() => snapshotOf(receiver, handle.taskId)?.status?.state === TaskState.TASK_STATE_COMPLETED);

    const task = snapshotOf(receiver, handle.taskId)!;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(task)).toBe("echo: do the thing");
    expect(receiver.artifacts("worker", handle.taskId)).toHaveLength(1); // mirror entries too
    expect(receipts.length).toBeGreaterThanOrEqual(2); // task + statusUpdate at minimum
    for (const r of receipts) expect(r.status).toBe(200);

    // Family rule on receipt: the handler followed pushes with getTask reads —
    // and the receiver itself never sent a message.
    expect(countCalls(mock, "GetTask")).toBeGreaterThanOrEqual(1);
    const sendersSeen = mock.callLog.filter((c) => c.method === "SendMessage");
    expect(sendersSeen).toHaveLength(1);

    // Devtools narrates the pushes.
    const pushes = hub.events().filter((e) => e.type === "a2a:push");
    expect(pushes.length).toBeGreaterThanOrEqual(2);

    // The registration itself rode the send: config landed in the SDK's store.
    const params = sendersSeen[0]!.params as {
      configuration: { taskPushNotificationConfig: { url: string; token: string } };
    };
    expect(params.configuration.taskPushNotificationConfig.url).toBe(HOOK_URL);
  });

  it("registerPush registers a webhook for an existing task via the RPC", async () => {
    const { mock, receiver, sender } = pushSetup(askThenEchoExecutor());
    // First turn WITHOUT push: the task pauses INPUT_REQUIRED, nothing pushed.
    const handle = (await sender.sendMessage("worker", msg("start"))) as TaskHandle;
    const created = await sender.registerPush("worker", handle.taskId, { url: HOOK_URL, token: TOKEN });
    expect(created.taskId).toBe(handle.taskId);
    expect(countCalls(mock, "CreateTaskPushNotificationConfig")).toBe(1);

    // The resume turn now pushes: the receiver sees the completion arrive.
    await handle.respond(msg("resume-input"));
    await until(() => snapshotOf(receiver, handle.taskId)?.status?.state === TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(snapshotOf(receiver, handle.taskId))).toBe("got: resume-input");
  });
});

describe("createWebhookHandler input handling", () => {
  it("rejects non-POSTs, bad tokens, and unparseable bodies without touching the cache", async () => {
    const { receiver, handler } = pushSetup();
    const post = (body: string, headers: Record<string, string> = {}) =>
      handler(new Request(HOOK_URL, { method: "POST", headers, body }));

    expect((await handler(new Request(HOOK_URL, { method: "GET" }))).status).toBe(405);
    expect((await post("{}", { "x-a2a-notification-token": "wrong" })).status).toBe(401);
    expect((await post("{}" /* no token at all */)).status).toBe(401);
    expect((await post("not json", { "x-a2a-notification-token": TOKEN })).status).toBe(400);
    expect((await post(JSON.stringify({ hello: 1 }), { "x-a2a-notification-token": TOKEN })).status).toBe(400);
    expect(receiver.cache.entriesForDevtools()).toHaveLength(0);
  });

  it("accepts Authorization: Bearer as the token carrier; 202s standalone messages", async () => {
    const { handler } = pushSetup();
    const message = { message: { messageId: "m1", role: "ROLE_AGENT", parts: [] } };
    const res = await handler(
      new Request(HOOK_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(message),
      }),
    );
    expect(res.status).toBe(202); // authenticated, parsed, nothing to fold
  });

  it("out-of-order pushes are healed by the reconcile read (a stale WORKING after COMPLETED)", async () => {
    const { receiver, sender, handler } = pushSetup();
    const handle = (await sender.sendMessage("worker", msg("fast"), {
      push: { url: HOOK_URL, token: TOKEN },
    })) as TaskHandle;
    await until(() => snapshotOf(receiver, handle.taskId)?.status?.state === TaskState.TASK_STATE_COMPLETED);

    // A delayed duplicate arrives claiming the task is still WORKING…
    const stale = {
      statusUpdate: { taskId: handle.taskId, contextId: "", status: { state: "TASK_STATE_WORKING" } },
    };
    const res = await handler(
      new Request(HOOK_URL, {
        method: "POST",
        headers: { "x-a2a-notification-token": TOKEN },
        body: JSON.stringify(stale),
      }),
    );
    expect(res.status).toBe(200);
    // …and the snapshot still ends at server truth, because the handler
    // reconciled with a full getTask after folding.
    expect(snapshotOf(receiver, handle.taskId)?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("accepts a bare Task snapshot body, and skips reconcile when disabled", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({ agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const noReconcile = createWebhookHandler(q, { agent: "worker", reconcile: false });
    const bareTask = {
      id: "task-x",
      contextId: "ctx",
      status: { state: "TASK_STATE_WORKING" },
      artifacts: [],
      history: [],
    };
    const res = await noReconcile(new Request(HOOK_URL, { method: "POST", body: JSON.stringify(bareTask) }));
    expect(res.status).toBe(200);
    expect(snapshotOf(q, "task-x")?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(countCalls(mock, "GetTask")).toBe(0); // reconcile: false ⇒ no read
  });

  it("folds appended artifact chunks against the mirror entry (append: true)", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({ agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handler = createWebhookHandler(q, { agent: "worker", reconcile: false });
    const chunk = (value: string, append: boolean) => ({
      artifactUpdate: {
        taskId: "task-y",
        contextId: "ctx",
        artifact: { artifactId: "out", name: "out", parts: [{ text: value }] },
        append,
      },
    });
    const post = (body: unknown) =>
      handler(new Request(HOOK_URL, { method: "POST", body: JSON.stringify(body) }));
    expect((await post(chunk("hello", false))).status).toBe(200);
    expect((await post(chunk("world", true))).status).toBe(200);
    expect(artifactText({ artifacts: q.artifacts("worker", "task-y") })).toBe("hello world");
  });
});
