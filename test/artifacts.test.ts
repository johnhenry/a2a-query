// Artifact-kind cache entries: their own keys/tags, accessors on client and
// handle, text extraction from Part oneofs, detachArtifacts (task snapshots
// without inline outputs), and eviction of large outputs.

import { describe, it, expect } from "vitest";
import type { AgentCard, Artifact } from "@a2a-js/sdk";
import {
  A2AQuery,
  artifactTag,
  artifactText,
  artifactsText,
  partText,
  serializeA2AKey,
  taskTag,
  type TaskHandle,
} from "../src/index.js";
import { MockA2AAgent, echoExecutor, pacedStreamingExecutor, type AgentExecutor } from "../src/testing/mockAgent.js";
import { msg, setup, until } from "./helpers.js";

const textPart = (value: string) => ({ content: { $case: "text", value } }) as never;

describe("keys & tags", () => {
  it("serializes artifact keys canonically and mints artifact tags", () => {
    expect(serializeA2AKey({ kind: "artifact", agent: "a1", taskId: "t1", artifactId: "out" })).toBe(
      JSON.stringify(["artifact", "a1", "t1", "out", ""]),
    );
    expect(serializeA2AKey({ kind: "artifact", agent: "a1", taskId: "t1", artifactId: "out", partition: "p" })).toBe(
      JSON.stringify(["artifact", "a1", "t1", "out", "p"]),
    );
    expect(artifactTag("a1", "t1", "out")).toBe("artifact:a1:t1:out");
  });
});

describe("text extraction", () => {
  const artifact: Artifact = {
    artifactId: "out",
    name: "out",
    description: "",
    parts: [textPart("hello "), { content: { $case: "data", value: { a: 1 } } } as never, textPart("world")],
    metadata: undefined,
    extensions: [],
  };

  it("partText reads the text oneof and skips others", () => {
    expect(partText(artifact.parts[0]!)).toBe("hello ");
    expect(partText(artifact.parts[1]!)).toBeUndefined();
  });

  it("artifactText concatenates text parts; artifactsText joins artifacts", () => {
    expect(artifactText(artifact)).toBe("hello world");
    expect(artifactsText([artifact, artifact], " | ")).toBe("hello world | hello world");
  });
});

describe("artifact entries + accessors (poll mode)", () => {
  it("mirrors artifacts into their own tagged entries and serves the accessors", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();

    // Client accessors.
    const artifacts = q.artifacts("a1", handle.taskId);
    expect(artifacts.map((a) => a.artifactId)).toEqual(["out"]);
    expect(q.artifact("a1", handle.taskId, "out")?.artifactId).toBe("out");
    expect(q.artifact("a1", handle.taskId, "nope")).toBeUndefined();

    // Handle accessors + text convenience.
    expect(handle.artifacts()).toEqual(artifacts);
    expect(handle.artifact("out")?.artifactId).toBe("out");
    expect(handle.artifactText()).toBe("echo: hi");
    expect(handle.artifactText("out")).toBe("echo: hi");
    expect(handle.artifactText("nope")).toBe("");

    // The raw entry carries the structured key and the tag vocabulary.
    const entry = q.artifactSnapshot("a1", handle.taskId, "out");
    expect(entry?.cacheKey).toEqual({ kind: "artifact", agent: "a1", taskId: handle.taskId, artifactId: "out" });
    expect(entry?.tags.has(artifactTag("a1", handle.taskId, "out"))).toBe(true);
    expect(entry?.tags.has(taskTag("a1", handle.taskId))).toBe(true);
  });

  it("artifact entries are individually subscribable (reactive via cache.subscribe)", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    let fired = 0;
    const unsub = q.cache.subscribe({ kind: "artifact", agent: "a1", taskId: handle.taskId, artifactId: "out" }, () => fired++);
    // A fresh write with different content emits; structural sharing suppresses no-ops.
    const current = q.artifact("a1", handle.taskId, "out")!;
    q.cache.write(
      { kind: "artifact", agent: "a1", taskId: handle.taskId, artifactId: "out" },
      { ...current, parts: [...current.parts, textPart("more")] },
    );
    expect(fired).toBe(1);
    unsub();
  });
});

describe("streaming append chunks accumulate in the artifact entry", () => {
  function streamQ(executor: AgentExecutor, extra?: { detachArtifacts?: boolean }) {
    const mock = new MockA2AAgent(executor, { card: { capabilities: { streaming: true } } as Partial<AgentCard> });
    const q = new A2AQuery({
      agents: { a1: { url: mock.url, fetchImpl: mock.fetchImpl } },
      taskPollMs: 15,
      ...extra,
    });
    return { mock, q };
  }

  it("append chunks merge into one artifact entry as they stream", async () => {
    const { q } = streamQ(pacedStreamingExecutor({ chunks: ["a", "b", "c"], stepMs: 20 }));
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const growth: string[] = [];
    handle.subscribe(() => growth.push(handle.artifactText("out")));
    await handle.result();
    expect(handle.artifactText("out")).toBe("abc");
    expect(growth.some((s) => s.length > 0 && s !== "abc")).toBe(true); // grew incrementally
  });

  it("detachArtifacts keeps task snapshots lean while accessors stay whole", async () => {
    const { q } = streamQ(pacedStreamingExecutor({ chunks: ["a", "b", "c"], stepMs: 20 }), {
      detachArtifacts: true,
    });
    const handle = (await q.sendMessage("a1", msg("go"))) as TaskHandle;
    const task = await handle.result();
    expect(task.artifacts).toEqual([]); // detached from the task entry
    expect(handle.task()?.artifacts).toEqual([]);
    expect(handle.artifactText()).toBe("abc"); // whole via the artifact entry
    expect(q.artifacts("a1", handle.taskId)).toHaveLength(1);
  });
});

describe("eviction", () => {
  it("evictArtifacts reclaims outputs without touching the task entry", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    expect(handle.artifacts()).toHaveLength(1);

    q.evictArtifacts("a1", handle.taskId);
    expect(handle.artifacts()).toEqual([]);
    expect(q.artifact("a1", handle.taskId, "out")).toBeUndefined();
    expect(handle.artifactText()).toBe("");
    expect(handle.task()).toBeDefined(); // the task snapshot survives

    q.evictArtifacts("a1", handle.taskId); // idempotent on an empty index
  });

  it("evicts a single artifact by id", async () => {
    const { q } = setup(echoExecutor());
    const handle = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await handle.result();
    q.evictArtifacts("a1", handle.taskId, "out");
    expect(q.artifacts("a1", handle.taskId)).toEqual([]);
  });
});

describe("out-of-band pause + artifacts stay coherent", () => {
  it("re-opened handles list artifacts from the cache once observed", async () => {
    const { q } = setup(echoExecutor());
    const first = (await q.sendMessage("a1", msg("hi"))) as TaskHandle;
    await first.result();
    const reopened = await q.task("a1", first.taskId);
    await until(() => reopened.artifacts().length > 0);
    expect(reopened.artifactText()).toBe("echo: hi");
  });
});
