// 02 · Live status — subscribe() to a task's cache entry and print each status
// transition as the poll loop observes it. Structural sharing means idle polls
// (same state, same data) emit nothing: you only see real changes.
// Run: npx tsx examples/02-live-status.ts

import { TaskState } from "@a2a-js/sdk";
import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, askThenEchoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const mock = new MockA2AAgent(askThenEchoExecutor());
const q = new A2AQuery({ agents: { a: { url: mock.url, fetchImpl: mock.fetchImpl } }, taskPollMs: 25 });

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const handle = (await q.sendMessage("a", msg("kick off"))) as TaskHandle;

let transitions = 0;
const unsubscribe = handle.subscribe((task) => {
  const state = task.status?.state;
  if (state === undefined) return;
  transitions++;
  console.log(`[${transitions}] ${TaskState[state]}`);
  // When the agent pauses for input, resume it (a real app would ask a human).
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    void handle.respond(msg("here you go"));
  }
});

const task = await handle.result();
unsubscribe();
console.log("final state:", TaskState[task.status!.state], "after", transitions, "observed transition(s)");
