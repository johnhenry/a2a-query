import { describe, it, expect } from "vitest";
import { A2AQuery, InteractionBroker, type InputDecision } from "../src/index.js";
import { MockA2AAgent, echoExecutor, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

function setup(executor = echoExecutor(), interactions?: InteractionBroker<InputDecision>) {
  const mock = new MockA2AAgent(executor);
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
    interactions,
    taskPollMs: 15,
  });
  return { mock, q };
}

describe("agent cards", () => {
  it("resolves and caches the card", async () => {
    const { mock, q } = setup();
    const card = (await q.card("a1")) as { name: string };
    expect(card.name).toBe("mock-agent");
    const before = mock.callLog.length;
    await q.card("a1"); // cached — no extra wire call
    expect(mock.callLog.length).toBe(before);
  });
});

describe("task lifecycle", () => {
  it("sendMessage returns a handle that resolves the completed task", async () => {
    const { q } = setup();
    const res = await q.sendMessage("a1", msg("hi"));
    expect(typeof res).toBe("object");
    const handle = res as Exclude<typeof res, Message>;
    expect("result" in handle).toBe(true);
    const task = await (handle as { result(): Promise<unknown> }).result();
    const t = task as { status: { state: unknown }; artifacts?: Array<{ parts: Array<{ text?: string }> }> };
    expect(String(t.status.state)).toMatch(/COMPLETED|3/);
    await tick(30);
  });

  it("routes INPUT_REQUIRED through the broker and resumes with the approved message", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as { result(): Promise<unknown> };
    const resultP = handle.result();

    // Wait for the paused state to surface in the broker queue.
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick(10);
    const pending = broker.list()[0];
    expect(pending?.type).toBe("input-required");
    broker.resolve(pending!.id, { action: "approve", message: msg("the answer") });

    const task = (await resultP) as {
      artifacts?: Array<{ parts: Array<{ content?: { $case: string; value?: unknown } }> }>;
    };
    const texts = (task.artifacts ?? []).flatMap((a) =>
      a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")),
    );
    expect(texts.join(" ")).toContain("got: the answer");
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
  });

  it("cancel reaches a terminal state and the cache snapshot tracks it", async () => {
    const broker = new InteractionBroker<InputDecision>({ policy: () => "deny" });
    const { q } = setup(askThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as {
      taskId: string;
      cancel(): Promise<void>;
      task(): { status?: { state?: unknown } } | undefined;
      result(): Promise<unknown>;
    };
    handle.result().catch(() => {});
    await tick(50);
    await handle.cancel();
    expect(String(handle.task()?.status?.state)).toMatch(/CANCELED|5/);
  });
});
