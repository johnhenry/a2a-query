// Cache-backed reactivity: subscribe() emits on real status transitions
// (structural sharing suppresses no-op polls), and the manual respond() flow
// works with no broker configured.

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import type { TaskHandle } from "../src/index.js";
import { askThenEchoExecutor, echoExecutor } from "../src/testing/mockAgent.js";
import { setup, msg, until, artifactText } from "./helpers.js";

describe("subscribe()", () => {
  it("emits once per status transition, not once per poll", async () => {
    const { q } = setup(askThenEchoExecutor());
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    const seen: TaskState[] = [];
    const unsub = handle.subscribe((task) => {
      const s = task.status?.state;
      if (s !== undefined && seen.at(-1) !== s) seen.push(s);
    });
    const emits: number[] = [];
    const countEmits = handle.subscribe(() => emits.push(Date.now()));

    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED);
    const emitsWhilePaused = emits.length;
    await until(() => emits.length > emitsWhilePaused + 2, 200); // idle polls…
    expect(emits.length).toBeLessThanOrEqual(emitsWhilePaused + 2); // …don't emit

    await handle.respond(msg("the answer"));
    const task = await handle.result();

    expect(artifactText(task)).toBe("got: the answer");
    expect(seen).toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(seen.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    unsub();
    countEmits();
  });

  it("unsubscribe stops delivery", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    let calls = 0;
    const unsub = handle.subscribe(() => calls++);
    unsub();
    await handle.result();
    expect(calls).toBe(0);
  });
});

describe("manual respond() without a broker", () => {
  it("the app observes the pause via task() and resumes it directly", async () => {
    const { q } = setup(askThenEchoExecutor()); // no interactions broker at all
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    const resultP = handle.result();

    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(handle.task()?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);

    await handle.respond(msg("42"));
    const task = await resultP;
    expect(artifactText(task)).toBe("got: 42");
  });
});
