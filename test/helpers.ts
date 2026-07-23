// Shared test plumbing: message builder, poll-friendly waiters, wired-up fixtures.

import type { Message } from "@a2a-js/sdk";
import { A2AQuery, type InteractionBroker, type InputDecision } from "../src/index.js";
import { MockA2AAgent, type AgentExecutor } from "../src/testing/mockAgent.js";

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
