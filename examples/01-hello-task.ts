// 01 · Hello task — the smallest useful program: send a message, get a
// TaskHandle, await the result, print the artifact text.
// Run: npx tsx examples/01-hello-task.ts   (in-process mock agent — no network)

import { A2AQuery, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const mock = new MockA2AAgent(echoExecutor(), { name: "echo-agent" });

const q = new A2AQuery({
  agents: { echo: { url: mock.url, fetchImpl: mock.fetchImpl } },
  taskPollMs: 25,
});

const message: Message = {
  messageId: "m-1",
  role: "user",
  parts: [{ content: { $case: "text", value: "hello, agent" } }],
} as never;

const card = await q.card("echo");
console.log("agent:", card.name);

const reply = await q.sendMessage("echo", message);
// A2A agents may answer with a direct Message or a long-running Task.
if (typeof reply === "object" && "result" in reply) {
  const handle = reply as TaskHandle;
  const task = await handle.result(); // resolves when the task COMPLETES
  const text = (task.artifacts ?? [])
    .flatMap((a) => a.parts.map((p) => (p.content?.$case === "text" ? String(p.content.value) : "")))
    .join("");
  console.log("artifact:", text); // → echo: hello, agent
} else {
  console.log("direct message reply:", reply);
}
