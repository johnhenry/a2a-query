// Shared test plumbing: message builder, poll-friendly waiters, wired-up fixtures.

import type { AgentSkill, Message } from "@a2a-js/sdk";
import { A2AQuery, type InteractionBroker, type InputDecision } from "../src/index.js";
import { MockA2AAgent, type AgentExecutor } from "../src/testing/mockAgent.js";

/** Card skills used by the codegen tests/fixtures (regenerate goldens when these change). */
export const demoSkills: AgentSkill[] = [
  {
    id: "book-flight",
    name: "Book flight",
    description: "Books a flight from a natural-language request.",
    tags: ["travel", "booking"],
    examples: ["book SFO to JFK tomorrow morning"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: [],
  },
  {
    id: "2fa.reset",
    name: "Reset 2FA",
    description: "Resets a user's two-factor authentication.",
    tags: [],
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  },
];

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` is truthy (or ~2s elapse — callers assert afterwards). */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await tick(10);
}

export const msg = (text: string): Message =>
  ({
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ content: { $case: "text", value: text } }],
  }) as never;

/** Flatten a task's artifact text parts. */
export function artifactText(task: unknown): string {
  const t = task as { artifacts?: Array<{ parts: Array<{ content?: { $case: string; value?: unknown } }> }> };
  return (t.artifacts ?? [])
    .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
    .filter(Boolean)
    .join(" ");
}

export function countCalls(mock: MockA2AAgent, method: string): number {
  return mock.callLog.filter((c) => c.method === method).length;
}

export function setup(executor: AgentExecutor, interactions?: InteractionBroker<InputDecision>) {
  const mock = new MockA2AAgent(executor);
  const q = new A2AQuery({
    agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
    interactions,
    taskPollMs: 15,
  });
  return { mock, q };
}
