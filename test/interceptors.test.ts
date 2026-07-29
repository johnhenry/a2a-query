// Interceptor onion (agent-query-core#3 prerequisite): wraps the real wire
// operations (send/resume/poll/cancel/stream-reattach) OUTSIDE attempt()'s
// retry. Reuses @johnhenry/agent-query-core's already-published Operation/
// RequestInterceptor/runInterceptors — no parallel type authored here.

import { describe, it, expect } from "vitest";
import type { Task } from "@a2a-js/sdk";
import type { RequestInterceptor } from "@johnhenry/agent-query-core";
import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import { msg, until } from "./helpers.js";

function make(interceptors: RequestInterceptor[] = []) {
  const mock = new MockA2AAgent(echoExecutor());
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
    interceptors,
    taskPollMs: 15,
  });
  return { mock, q };
}

describe("interceptor onion", () => {
  it("zero interceptors ⇒ identical to today's baseline (no interceptors option at all)", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({ agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    const task = await handle.result();
    expect(task.status?.state).toBeDefined();
  });

  it("an empty interceptors array behaves identically to omitting the option", async () => {
    const { q } = make([]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    const task = await handle.result();
    expect(task.status?.state).toBeDefined();
  });

  it("observes every real wire operation kind across a task lifecycle: send, poll, cancel", async () => {
    const seen: Array<{ kind: string; peer: string }> = [];
    const observer: RequestInterceptor = async (op, next) => {
      seen.push({ kind: op.kind, peer: op.peer });
      return next(op);
    };
    const { q } = make([observer]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    await handle.cancel().catch(() => {}); // task is already terminal — exercises the cancel op regardless

    const kinds = seen.map((s) => s.kind);
    expect(kinds).toContain("send");
    expect(kinds).toContain("poll");
    expect(kinds).toContain("cancel");
    expect(seen.every((s) => s.peer === "a1")).toBe(true);
  });

  it("an interceptor can short-circuit cancel without reaching the wire", async () => {
    // sendMessage/respond/poll all post-process `opened`/`task` after the onion resolves
    // (writeTask, devtools, stream-vs-unary branching) — a short-circuit there must return
    // a value shaped like what the call site expects. cancel() is the simplest to
    // demonstrate: its short-circuit value just needs to be Task-shaped.
    let calls = 0;
    let fakeResult: Task | undefined;
    const skipCancel: RequestInterceptor = async (op, next) => {
      if (op.kind === "cancel") {
        calls++;
        return fakeResult;
      }
      return next(op);
    };
    const { mock, q } = make([skipCancel]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    fakeResult = handle.task()!; // reuse the already-cached (terminal) task as the short-circuited "result"
    await handle.cancel();
    expect(calls).toBe(1);
    expect(mock.callLog.filter((c) => c.method === "CancelTask")).toHaveLength(0);
  });

  it("an interceptor can deny (throw) a specific op kind, propagating the error", async () => {
    const denyCancel: RequestInterceptor = async (op, next) => {
      if (op.kind === "cancel") throw new Error("cancel denied by policy");
      return next(op);
    };
    const { q } = make([denyCancel]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    await expect(handle.cancel()).rejects.toThrow("cancel denied by policy");
  });

  it("op.state is a fresh scratch bag per operation — no bleed across the poll loop", async () => {
    const stateBleed: unknown[] = [];
    const tagger: RequestInterceptor = async (op, next) => {
      if (op.state.marker !== undefined) stateBleed.push(op.state.marker);
      op.state.marker = `${op.kind}:${Date.now()}`;
      return next(op);
    };
    const { q } = make([tagger]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(stateBleed).toEqual([]);
  });

  it("multiple interceptors compose in order, each getting a chance to observe or short-circuit", async () => {
    const order: string[] = [];
    const first: RequestInterceptor = async (op, next) => {
      order.push("first:before");
      const r = await next(op);
      order.push("first:after");
      return r;
    };
    const second: RequestInterceptor = async (op, next) => {
      order.push("second:before");
      const r = await next(op);
      order.push("second:after");
      return r;
    };
    const { q } = make([first, second]);
    await q.sendMessage("a1", msg("hi"));
    expect(order).toEqual(["first:before", "second:before", "second:after", "first:after"]);
  });

  it("op.state.idempotent is set for read-shaped ops (poll) and true for the fixed-messageId send", async () => {
    const idempotency: Record<string, boolean | undefined> = {};
    const capture: RequestInterceptor = async (op, next) => {
      idempotency[op.kind] = op.state.idempotent as boolean | undefined;
      return next(op);
    };
    const { q } = make([capture]);
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(idempotency.send).toBe(true);
    await until(() => idempotency.poll !== undefined);
    expect(idempotency.poll).toBe(true);
  });
});
