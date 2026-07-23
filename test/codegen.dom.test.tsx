// @vitest-environment happy-dom
// Generated hooks (a2aq-codegen --hooks) — the useX layer rendered for real,
// against the mock agent, through useSkillTask.

import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

import { A2AQuery } from "../src/index.js";
import { MockA2AAgent, echoExecutor, failingExecutor } from "../src/testing/mockAgent.js";
import { demoSkills, until } from "./helpers.js";
import { useBookFlight } from "./generated/demo-skills-hooks.js";

function setup(executor = echoExecutor()) {
  const mock = new MockA2AAgent(executor, { card: { skills: demoSkills } });
  const q = new A2AQuery({ agents: { demo: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 15 });
  return { mock, q };
}

function BookFlight({ q, input }: { q: A2AQuery; input: string }) {
  const { send, sending, status, artifacts, error } = useBookFlight(q, "demo");
  const text = artifacts
    .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
    .join("");
  return (
    <div>
      <button data-testid="go" onClick={() => void send(input).catch(() => {})}>
        book
      </button>
      <span data-testid="state">{sending ? "(sending)" : (status ?? "(idle)")}</span>
      <span data-testid="out">{text}</span>
      <span data-testid="err">{error ? "error" : ""}</span>
    </div>
  );
}

describe("generated useBookFlight", () => {
  it("send → live status → artifacts, all from the mounted hook", async () => {
    const { mock, q } = setup();
    render(<BookFlight q={q} input="SFO to JFK" />);
    expect(screen.getByTestId("state").textContent).toBe("(idle)");
    await act(async () => {
      screen.getByTestId("go").click();
      await until(() => screen.getByTestId("state").textContent === "TASK_STATE_COMPLETED");
    });
    expect(screen.getByTestId("out").textContent).toBe("echo: SFO to JFK");
    // The wire saw a skill-tagged message.
    const params = mock.callLog.find((c) => c.method === "SendMessage")?.params as {
      message: { metadata: Record<string, unknown> };
    };
    expect(params.message.metadata["a2aq/skillId"]).toBe("book-flight");
  });

  it("a failing task surfaces through status (send itself resolved — the task failed)", async () => {
    const { q } = setup(failingExecutor("no seats left"));
    render(<BookFlight q={q} input="MARS to VENUS" />);
    await act(async () => {
      screen.getByTestId("go").click();
      await until(() => screen.getByTestId("state").textContent === "TASK_STATE_FAILED");
    });
    expect(screen.getByTestId("state").textContent).toBe("TASK_STATE_FAILED");
    expect(screen.getByTestId("err").textContent).toBe(""); // wire send succeeded
  });
});
