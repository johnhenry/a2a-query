// 09 · Artifact store — artifacts live under their own cache keys
// ({ kind: "artifact" }), so large outputs are individually readable,
// subscribable, and evictable. With detachArtifacts the task snapshot stays
// lean (no inline outputs) while handle.artifacts()/artifactText() reassemble
// from the artifact entries. partText/artifactText hide the Part-oneof encoding.
// Run: npm run example:09   (in-process mock agent — no network)

import { A2AQuery, artifactTag, type TaskHandle } from "../src/index.js";
import { MockA2AAgent, pacedStreamingExecutor } from "../src/testing/mockAgent.js";
import type { AgentCard, Message } from "@a2a-js/sdk";

const msg = (id: string, text: string): Message =>
  ({ messageId: id, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

// A streaming agent that emits its report in chunks.
const mock = new MockA2AAgent(
  pacedStreamingExecutor({ chunks: ["# Report\n", "- finding one\n", "- finding two\n"], stepMs: 30 }),
  { name: "report-agent", card: { capabilities: { streaming: true } } as Partial<AgentCard> },
);

const q = new A2AQuery({
  agents: { reporter: { url: mock.url, fetchImpl: mock.fetchImpl } },
  taskPollMs: 25,
  detachArtifacts: true, // task snapshots stay lean; outputs live in artifact entries
});

console.log("── streaming a chunked artifact into its own cache entry ──");
const handle = (await q.sendMessage("reporter", msg("m-1", "write the report"))) as TaskHandle;

// React to the artifact ENTRY, not the task: subscribe to its structured key.
const artifactKey = { kind: "artifact", agent: "reporter", taskId: handle.taskId, artifactId: "out" } as const;
const unsub = q.cache.subscribe(artifactKey, () => {
  console.log(`[chunk]   ${JSON.stringify(handle.artifactText("out"))}`);
});

const task = await handle.result();
unsub();

console.log(`\ntask snapshot artifacts (detached): ${JSON.stringify(task.artifacts)}`);
console.log(`handle.artifacts():                 ${handle.artifacts().length} artifact(s)`);
console.log(`handle.artifactText():\n${handle.artifactText()}`);

const entry = q.artifactSnapshot("reporter", handle.taskId, "out");
console.log(`\nentry key:  ${JSON.stringify(entry?.cacheKey)}`);
console.log(`entry tags: ${[...(entry?.tags ?? [])].join(", ")}`);
console.log(`(tag helper: ${artifactTag("reporter", handle.taskId, "out")})`);

// Consumed? Reclaim the bytes — the task snapshot survives.
q.evictArtifacts("reporter", handle.taskId);
console.log(`\nafter evictArtifacts: ${handle.artifacts().length} artifact(s), task still cached: ${!!handle.task()}`);
