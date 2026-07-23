// Broker mechanics around paused tasks: AUTH_REQUIRED routing, deny leaving the
// task parked, single prompt per pause (the re-prompt/double-resume regression),
// and re-arming only after the task observably leaves the paused state.

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { InteractionBroker, type InputDecision, type TaskHandle } from "../src/index.js";
import {
  askAuthThenEchoExecutor,
  askThenEchoExecutor,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "../src/testing/mockAgent.js";
import { AgentEvent } from "@a2a-js/sdk/server";
import { setup, msg, tick, until, countCalls, artifactText } from "./helpers.js";

describe("AUTH_REQUIRED", () => {
  it("routes through the broker as auth-required and resumes on approval", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askAuthThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("book the room"))) as TaskHandle;
    const resultP = handle.result();

    await until(() => broker.list().length > 0);
    const pending = broker.list()[0];
    expect(pending?.type).toBe("auth-required");
    broker.resolve(pending!.id, { action: "approve", message: msg("token-abc") });

    const task = await resultP;
    expect(artifactText(task)).toContain("authed: token-abc");
    expect(broker.auditLog().at(-1)?.outcome).toBe("approved");
  });
});

describe("deny", () => {
  it("leaves the task paused and sends no resume", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { mock, q } = setup(askThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});

    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "deny", reason: "not now" });
    await tick(120); // several poll cycles

    expect(handle.task()?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(countCalls(mock, "SendMessage")).toBe(1); // only the original send
    expect(broker.auditLog().at(-1)?.outcome).toBe("denied");
    expect(broker.list()).toHaveLength(0); // and no re-prompt while still parked

    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_CANCELED); // stop the loop
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_CANCELED);
  });
});

/** Pauses INPUT_REQUIRED on the first turn AND on every follow-up (a "stubborn"
 * agent that never observably leaves the pause from the client's viewpoint). */
function stubbornExecutor(): AgentExecutor {
  return {
    async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      bus.publish(
        AgentEvent.task({
          id: ctx.taskId,
          contextId: ctx.contextId,
          status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, timestamp: undefined } as never,
          history: [],
          artifacts: [],
          metadata: undefined,
        }),
      );
    },
    async cancelTask(): Promise<void> {},
  };
}

describe("re-prompt regression", () => {
  it("prompts once per pause: no second resume while the task never leaves the paused state", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { mock, q } = setup(stubbornExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});

    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "approve", message: msg("answer 1") });
    await until(() => countCalls(mock, "SendMessage") >= 2);
    await tick(150); // many more polls, all observing the same INPUT_REQUIRED

    // The buggy behavior re-prompted the broker each poll and sent a 2nd resume.
    expect(countCalls(mock, "SendMessage")).toBe(2); // original + one resume
    expect(broker.list()).toHaveLength(0);
    expect(broker.auditLog()).toHaveLength(1);

    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_CANCELED);
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_CANCELED);
  });

  it("re-arms after the task observably leaves and re-enters a paused state", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { mock, q } = setup(stubbornExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});

    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "deny" });
    await tick(60);
    expect(broker.list()).toHaveLength(0);

    // Drive the transition the polling client must observe: leave → re-enter.
    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_WORKING);
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_WORKING);
    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_INPUT_REQUIRED);

    await until(() => broker.list().length > 0);
    expect(broker.list()[0]?.type).toBe("input-required"); // a fresh prompt for the new pause

    broker.resolve(broker.list()[0]!.id, { action: "deny" });
    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_CANCELED);
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_CANCELED);
  });

  it("a switch between paused states (INPUT_REQUIRED → AUTH_REQUIRED) is a new pause", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { mock, q } = setup(stubbornExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});

    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "deny" });
    await tick(60);

    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_AUTH_REQUIRED);
    await until(() => broker.list().length > 0);
    expect(broker.list()[0]?.type).toBe("auth-required");

    broker.resolve(broker.list()[0]!.id, { action: "deny" });
    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_CANCELED);
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_CANCELED);
  });
});

describe("policy autopilot", () => {
  it("policy deny auto-blocks without queueing a prompt", async () => {
    const broker = new InteractionBroker<InputDecision>({ policy: () => "deny" });
    const { mock, q } = setup(askThenEchoExecutor(), broker);
    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    handle.result().catch(() => {});

    await until(() => broker.auditLog().length > 0);
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
    expect(broker.list()).toHaveLength(0);
    expect(countCalls(mock, "SendMessage")).toBe(1);

    await mock.setTaskState(handle.taskId, TaskState.TASK_STATE_CANCELED);
    await until(() => handle.task()?.status?.state === TaskState.TASK_STATE_CANCELED);
  });
});
