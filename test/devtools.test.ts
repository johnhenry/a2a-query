// Devtools emission: compact serializable events, in order, for a full task
// lifecycle including a broker gate — and state-CHANGE semantics (idle polls
// emit nothing).

import { describe, it, expect } from "vitest";
import {
  A2AQuery,
  DevtoolsHub,
  InteractionBroker,
  type A2ADevtoolsEvent,
  type InputDecision,
  type TaskHandle,
} from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor, echoExecutor, type AgentExecutor } from "../src/testing/mockAgent.js";
import { msg, until, artifactText } from "./helpers.js";

function make(executor: AgentExecutor, interactions?: InteractionBroker<InputDecision>) {
  const mock = new MockA2AAgent(executor);
  const hub = new DevtoolsHub<A2ADevtoolsEvent>();
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
    taskPollMs: 15,
    devtools: hub,
    interactions,
  });
  return { mock, hub, q };
}

const ofType = <T extends A2ADevtoolsEvent["type"]>(hub: DevtoolsHub<A2ADevtoolsEvent>, type: T) =>
  hub.events().filter((e): e is Extract<A2ADevtoolsEvent, { type: T }> => e.type === type);

describe("devtools emission", () => {
  it("emits an ordered timeline for a full lifecycle including a gate", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { hub, q } = make(askThenEchoExecutor(), broker);

    const handle = (await q.sendMessage("a1", msg("start"))) as TaskHandle;
    const resultP = handle.result();
    await until(() => broker.list().length > 0);
    broker.resolve(broker.list()[0]!.id, { action: "approve", message: msg("blue") });
    const task = await resultP;
    expect(artifactText(task)).toContain("got: blue");

    const types = hub.events().map((e) => e.type);
    // Connectivity first: the client connects before anything hits the wire.
    expect(types.indexOf("a2a:status")).toBe(0);
    const statusStates = ofType(hub, "a2a:status").map((e) => e.state);
    expect(statusStates.slice(0, 2)).toEqual(["connecting", "ready"]);

    // Sends and the gate, in causal order: send → gate resolution → resume send.
    const sendsAndGates = hub.events().filter((e) => e.type === "a2a:send" || e.type === "a2a:gate");
    expect(sendsAndGates.map((e) => e.type)).toEqual(["a2a:send", "a2a:gate", "a2a:send"]);
    const gate = ofType(hub, "a2a:gate")[0]!;
    expect(gate).toMatchObject({ agent: "a1", taskId: handle.taskId, kind: "input", outcome: "approve" });

    // Task-status: emitted on CHANGE only — never two identical states in a row —
    // starting at the paused seed and ending COMPLETED.
    const states = ofType(hub, "a2a:task-status").map((e) => e.state);
    expect(states).toContain("TASK_STATE_INPUT_REQUIRED");
    expect(states.at(-1)).toBe("TASK_STATE_COMPLETED");
    for (let i = 1; i < states.length; i++) expect(states[i]).not.toBe(states[i - 1]);

    // Artifact arrival: exactly once, despite many polls observing it.
    const artifacts = ofType(hub, "a2a:artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ agent: "a1", taskId: handle.taskId, artifactId: "out" });

    // Everything is JSON-serializable (compact events, no live objects).
    expect(() => JSON.stringify(hub.events())).not.toThrow();
  });

  it("emits a2a:card-refresh on wire refetches and a2a:send carries the messageId", async () => {
    const { hub, q } = make(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hello"))) as TaskHandle;
    await handle.result();
    await q.card("a1", { refresh: true });

    expect(ofType(hub, "a2a:card-refresh")).toEqual([{ type: "a2a:card-refresh", agent: "a1" }]);
    const send = ofType(hub, "a2a:send")[0]!;
    expect(send.agent).toBe("a1");
    expect(send.taskId).toBe(handle.taskId);
    expect(send.messageId).toBeTruthy();
  });

  it("stays silent (and unbroken) with no devtools sink configured", async () => {
    const mock = new MockA2AAgent(echoExecutor());
    const q = new A2AQuery({ agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    const task = await handle.result();
    expect(artifactText(task)).toContain("echo: hi");
  });
});
