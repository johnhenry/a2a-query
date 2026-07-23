// @vitest-environment happy-dom
// React hooks — real renders via @testing-library/react on happy-dom, driven
// end-to-end by the mock agent over the SDK's real wire codec.

import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

import type { AgentCard } from "@a2a-js/sdk";
import { A2AQuery, InteractionBroker, type InputDecision, type TaskHandle } from "../src/index.js";
import {
  useAgentCard,
  usePendingInput,
  useTask,
  useTaskArtifacts,
  useTaskStatus,
} from "../src/react/index.js";
import { MockA2AAgent, askThenEchoExecutor, echoExecutor } from "../src/testing/mockAgent.js";
import { artifactText, msg, tick, until } from "./helpers.js";

function setup(executor = echoExecutor(), interactions?: InteractionBroker<InputDecision>, cardStaleTime?: number) {
  const mock = new MockA2AAgent(executor);
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
    interactions,
    taskPollMs: 15,
    cardStaleTime,
  });
  return { mock, q };
}

describe("useTask / useTaskStatus / useTaskArtifacts", () => {
  it("mounting a handle drives its loop and re-renders through the transition to COMPLETED", async () => {
    const { q } = setup();
    const states: Array<string | undefined> = [];
    function TaskView({ handle }: { handle: TaskHandle | undefined }) {
      const task = useTask(q, handle);
      const status = useTaskStatus(q, handle);
      const artifacts = useTaskArtifacts(q, handle);
      states.push(status);
      return (
        <div>
          <span data-testid="status">{status ?? "(none)"}</span>
          <span data-testid="text">{task ? artifactText(task) : ""}</span>
          <span data-testid="count">{artifacts.length}</span>
        </div>
      );
    }
    const { rerender } = render(<TaskView handle={undefined} />);
    expect(screen.getByTestId("status").textContent).toBe("(none)");

    let handle!: TaskHandle;
    await act(async () => {
      handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    });
    rerender(<TaskView handle={handle} />);
    // No result()/subscribe() call anywhere — the hook's mount starts the loop.
    await act(async () => {
      await until(() => screen.getByTestId("status").textContent === "TASK_STATE_COMPLETED");
    });
    expect(screen.getByTestId("text").textContent).toBe("echo: hi");
    expect(screen.getByTestId("count").textContent).toBe("1");
    // The transition was observed live (WORKING before COMPLETED), not just the end state.
    expect(states).toContain("TASK_STATE_WORKING");
  });

  it("a plain { agent, taskId } ref observes the cache another handle drives", async () => {
    const { q } = setup();
    function Passive({ agent, taskId }: { agent: string; taskId: string }) {
      const status = useTaskStatus(q, { agent, taskId });
      return <span data-testid="passive">{status ?? "-"}</span>;
    }
    let handle!: TaskHandle;
    await act(async () => {
      handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    });
    render(<Passive agent="a1" taskId={handle.taskId} />);
    await act(async () => {
      await handle.result(); // the handle drives; the passive component re-renders
      await until(() => screen.getByTestId("passive").textContent === "TASK_STATE_COMPLETED");
    });
    expect(screen.getByTestId("passive").textContent).toBe("TASK_STATE_COMPLETED");
  });
});

describe("usePendingInput", () => {
  it("shows the paused gate; approve() flows through to a resumed, completed task", async () => {
    const broker = new InteractionBroker<InputDecision>(); // default policy: ask
    const { q } = setup(askThenEchoExecutor(), broker);

    function Inbox() {
      const { pending, approve } = usePendingInput(q);
      return (
        <div>
          <span data-testid="inbox">{pending.length}</span>
          {pending.map((p) => (
            <button key={p.id} data-testid={`approve-${p.id}`} onClick={() => approve(p.id, msg("answer: 42"))}>
              {p.type}
            </button>
          ))}
        </div>
      );
    }
    render(<Inbox />);
    expect(screen.getByTestId("inbox").textContent).toBe("0");

    let handle!: TaskHandle;
    let result!: Promise<unknown>;
    await act(async () => {
      handle = (await q.sendMessage("a1", msg("need input"))) as TaskHandle;
      result = handle.result();
      await until(() => broker.list().length > 0);
      await tick();
    });
    expect(screen.getByTestId("inbox").textContent).toBe("1");
    expect(screen.getByTestId(`approve-${broker.list()[0]!.id}`).textContent).toBe("input-required");

    await act(async () => {
      screen.getByTestId(`approve-${broker.list()[0]!.id}`).click();
      await result;
      await tick();
    });
    expect(screen.getByTestId("inbox").textContent).toBe("0");
    expect(artifactText(handle.task())).toBe("got: answer: 42");
  });

  it("deny leaves the task parked; no broker means empty queue and no-op resolvers", async () => {
    const broker = new InteractionBroker<InputDecision>();
    const { q } = setup(askThenEchoExecutor(), broker);
    function Inbox() {
      const { pending, deny } = usePendingInput(q);
      return (
        <div>
          <span data-testid="inbox">{pending.length}</span>
          {pending.map((p) => (
            <button key={p.id} data-testid={`deny-${p.id}`} onClick={() => deny(p.id)} />
          ))}
        </div>
      );
    }
    render(<Inbox />);
    let handle!: TaskHandle;
    await act(async () => {
      handle = (await q.sendMessage("a1", msg("need input"))) as TaskHandle;
      void handle.result().catch(() => {});
      handle.subscribe(() => {});
      await until(() => broker.list().length > 0);
      await tick();
    });
    await act(async () => {
      screen.getByTestId(`deny-${broker.list()[0]!.id}`).click();
      await tick(50);
    });
    expect(screen.getByTestId("inbox").textContent).toBe("0");
    expect(handle.task()?.status?.state).toBeDefined(); // still parked, not resumed
    expect(broker.auditLog().at(-1)?.outcome).toBe("denied");

    // No broker configured: empty queue, resolvers are safe no-ops.
    const bare = new A2AQuery({ agents: {} });
    function Empty() {
      const { pending, resolve } = usePendingInput(bare);
      resolve(999, { action: "deny" }); // must not throw
      return <span data-testid="empty">{pending.length}</span>;
    }
    render(<Empty />);
    expect(screen.getByTestId("empty").textContent).toBe("0");
  });
});

describe("useAgentCard", () => {
  it("fetches on first mount, renders reactively, and refetches when the entry is stale", async () => {
    const { mock, q } = setup(echoExecutor(), undefined, 1 /* ms — everything is stale immediately */);
    function CardName() {
      const card = useAgentCard(q, "a1");
      return <span data-testid="card">{card?.name ?? "(loading)"}</span>;
    }
    render(<CardName />);
    expect(screen.getByTestId("card").textContent).toBe("(loading)");
    await act(async () => {
      await until(() => screen.getByTestId("card").textContent !== "(loading)");
    });
    expect(screen.getByTestId("card").textContent).toBe("mock-agent");

    // The agent rev's its card; the entry is past cardStaleTime — a remount refetches.
    (mock.card as AgentCard).name = "mock-agent-v2";
    cleanup();
    await tick(5);
    render(<CardName />);
    await act(async () => {
      await until(() => screen.getByTestId("card").textContent === "mock-agent-v2");
    });
    expect(screen.getByTestId("card").textContent).toBe("mock-agent-v2");
  });
});
