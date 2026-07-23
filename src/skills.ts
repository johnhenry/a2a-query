// Skill invocation — the framework-free layer under a2aq-codegen's generated
// helpers (and the react useSkillTask hook). A2A's AgentSkill is a DISCOVERY
// shape: it declares media modes (inputModes/outputModes), tags and examples —
// NOT parameter schemas, and A2A Messages carry no first-class skill field.
// So invoking a skill is: build a normal Message and tag the skill id into
// `message.metadata` (under SKILL_METADATA_KEY) where cooperating agents and
// middlemen can read it.

import { Role, type Message, type Part } from "@a2a-js/sdk";
import type { A2AQuery, TaskHandle } from "./client.js";

/**
 * The metadata key the skill id travels under. A2A has no first-class
 * "skill" field on Message — the card's `skills` are discovery data — so
 * a2aq uses a namespaced metadata key, mirroring how other A2A clients pass
 * routing hints. Agents that ignore it lose nothing: the message is a plain
 * A2A message either way.
 */
export const SKILL_METADATA_KEY = "a2aq/skillId";

/**
 * What a skill invocation accepts: plain text (wrapped into a `text/plain`
 * Part) or fully-formed Parts for skills whose `inputModes` want files or
 * structured data. There is no per-skill param TYPE because the card
 * doesn't declare one — see the module header.
 */
export type SkillInput = string | Part[];

export interface SkillSendOptions {
  /**
   * Merged over the built message (`metadata` is merged key-wise; the skill
   * id key always wins). Use it for contextId/taskId/extensions.
   */
  message?: Partial<Message>;
}

/** A `text/plain` text Part. */
export function textPart(value: string): Part {
  return { content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

/** The Message a skill invocation sends: input as parts + the skill id in metadata. */
export function skillMessage(skillId: string, input: SkillInput, overrides?: Partial<Message>): Message {
  const parts = typeof input === "string" ? [textPart(input)] : input;
  return {
    messageId: "", // empty ⇒ sendMessage fixes one client-side before the first attempt (the idempotency key)
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts,
    extensions: [],
    referenceTaskIds: [],
    ...overrides,
    metadata: { ...(overrides?.metadata ?? {}), [SKILL_METADATA_KEY]: skillId },
  };
}

/**
 * Invoke a skill: `sendMessage` with a skill-tagged message. Exactly the
 * send contract (retry under the fixed messageId, task-shaped replies come
 * back as a TaskHandle) — generated `sendX` helpers are thin wrappers over
 * this.
 */
export function sendSkill(
  q: A2AQuery,
  agent: string,
  skillId: string,
  input: SkillInput,
  opts?: SkillSendOptions,
): Promise<Message | TaskHandle> {
  return q.sendMessage(agent, skillMessage(skillId, input, opts?.message));
}
