// Cache key vocabulary for the A2A adapter. Keys are structured; the core cache
// gets the canonical serializer. Tags are the invalidation currency.

import type { Tag } from "@johnhenry/agent-query-core";

export type A2AKey =
  | { kind: "card"; agent: string }
  | { kind: "task"; agent: string; taskId: string; partition?: string }
  | { kind: "artifact"; agent: string; taskId: string; artifactId: string; partition?: string };

export function serializeA2AKey(key: A2AKey): string {
  switch (key.kind) {
    case "card":
      return JSON.stringify(["card", key.agent]);
    case "task":
      return JSON.stringify(["task", key.agent, key.taskId, key.partition ?? ""]);
    case "artifact":
      return JSON.stringify(["artifact", key.agent, key.taskId, key.artifactId, key.partition ?? ""]);
  }
}

/** A specific agent's card. */
export const cardTag = (agent: string): Tag => `card:${agent}`;
/** A specific task. */
export const taskTag = (agent: string, taskId: string): Tag => `task:${agent}:${taskId}`;
/** A specific artifact of a task. */
export const artifactTag = (agent: string, taskId: string, artifactId: string): Tag =>
  `artifact:${agent}:${taskId}:${artifactId}`;
/** Coarse "anything from this agent" tag — blunt invalidation on reconnect/removal. */
export const agentTag = (agent: string): Tag => `agent:${agent}`;
