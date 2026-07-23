// @johnhenry/a2aq — reactive, cached, embeddable A2A client for non-agentic apps.

export { A2AQuery } from "./client.js";
export type { A2ADevtoolsEvent, A2AQueryConfig, AgentConfig, InputDecision, TaskHandle } from "./client.js";
export { serializeA2AKey, cardTag, taskTag, artifactTag, agentTag } from "./keys.js";
export type { A2AKey } from "./keys.js";
export { partText, artifactText, artifactsText } from "./artifacts.js";
export { tapFetch } from "./wire.js";
export type { A2AWireSummary } from "./wire.js";
export { SKILL_METADATA_KEY, sendSkill, skillMessage, textPart } from "./skills.js";
export type { SkillInput, SkillSendOptions } from "./skills.js";
export { generateSkillModule } from "./codegen/generate.js";
export type { GenerateSkillModuleOptions } from "./codegen/generate.js";
// Re-export the core primitives consumers configure.
export { DevtoolsHub, InteractionBroker, QueryCache, StatusStore, withRetry } from "@johnhenry/agent-query-core";
export type {
  AuditEntry,
  BaseDecision,
  ConnectivityState,
  DevtoolsSink,
  Interaction,
  PeerStatus,
  PolicyVerdict,
  RetryPolicy,
} from "@johnhenry/agent-query-core";
