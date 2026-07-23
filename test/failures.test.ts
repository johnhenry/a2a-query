// Terminal-state behavior: FAILED (with server detail), REJECTED, respond() on a
// terminal task, cancel() racing terminality, and seeding a handle from a
// finished task.

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { TaskHandle } from "../src/index.js";
import {
  echoExecutor,
  failingExecutor,
  rejectingExecutor,
} from "../src/testing/mockAgent.js";
import { setup, msg, until, countCalls } from "./helpers.js";

describe("failed tasks", () => {
  it("result() rejects and carries the server's error detail", async () => {
    const { q } = setup(failingExecutor("disk quota exceeded"));
    const handle = (await q.sendMessage("a1", msg("do it"))) as TaskHandle;
    await expect(handle.result()).rejects.toThrow(/failed: disk quota exceeded/);
  });

  it("result() rejects with a plain message when the server gives no detail", async () => {
    const { q } = setup(failingExecutor(""));
    const handle = (await q.sendMessage("a1", msg("do it"))) as TaskHandle;
    await expect(handle.result()).rejects.toThrow(/task .* failed$/);
  });

  it("REJECTED tasks reject the result with the rejection detail", async () => {
    const { q } = setup(rejectingExecutor("not in scope"));
    const handle = (await q.sendMessage("a1", msg("write my thesis"))) as TaskHandle;
    await expect(handle.result()).rejects.toThrow(/was rejected: not in scope/);
  });
});

describe("terminal-task guards", () => {
  it("respond() on a terminal task rejects clearly", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    await until(() => {
      const s = handle.task()?.status?.state;
      return s !== undefined && s === TaskState.TASK_STATE_COMPLETED;
    });
    await expect(handle.respond(msg("more"))).rejects.toThrow(/already terminal.*TASK_STATE_COMPLETED/);
  });

  it("cancel() on an already-terminal task refreshes instead of bubbling", async () => {
    const { mock, q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    const cancelsBefore = countCalls(mock, "CancelTask");
    await handle.cancel(); // server refuses to cancel a finished task — must not throw
    expect(countCalls(mock, "CancelTask")).toBe(cancelsBefore + 1);
    expect(handle.task()?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("a handle seeded from an already-terminal task resolves from the seed", async () => {
    const { q } = setup(echoExecutor());
    const first = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await first.result();
    // Re-open the finished task by id — result() settles without endless polling.
    const reopened = await q.task("a1", first.taskId);
    const task = await reopened.result();
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await expect(reopened.respond(msg("more"))).rejects.toThrow(/already terminal/);
  });
});
