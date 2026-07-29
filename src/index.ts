// @johnhenry/a2aq — reactive, cached, embeddable A2A client for non-agentic apps.

export { A2AQuery } from "./client.js";
export type {
  A2ADevtoolsEvent,
  A2AQueryConfig,
  AgentConfig,
  InputDecision,
  PushConfigInit,
  SendOptions,
  TaskHandle,
} from "./client.js";
export { createWebhookHandler } from "./webhook.js";
export type { WebhookHandlerOptions } from "./webhook.js";
export { serializeA2AKey, cardTag, taskTag, artifactTag, agentTag } from "./keys.js";
export type { A2AKey } from "./keys.js";
export { partText, artifactText, artifactsText } from "./artifacts.js";
export { tapFetch } from "./wire.js";
export type { A2AWireSummary } from "./wire.js";
export { SKILL_METADATA_KEY, sendSkill, skillMessage, textPart } from "./skills.js";
export type { SkillInput, SkillSendOptions } from "./skills.js";
export { generateSkillModule } from "./codegen/generate.js";
export type { GenerateSkillModuleOptions } from "./codegen/generate.js";
export { x402Fetch, parseX402Challenge } from "./x402.js";
export type { X402Challenge, X402PaymentRequirement } from "./x402.js";
export { x402Interceptor, X402ChallengeError } from "./x402Interceptor.js";
export type { X402Decision, X402InterceptorOptions } from "./x402Interceptor.js";
// Re-export the core primitives consumers configure.
export { DevtoolsHub, InteractionBroker, QueryCache, StatusStore, runInterceptors, withRetry } from "@johnhenry/agent-query-core";
export type {
  AuditEntry,
  BaseDecision,
  ConnectivityState,
  DevtoolsSink,
  Interaction,
  Operation,
  PeerStatus,
  PolicyVerdict,
  RequestInterceptor,
  RetryPolicy,
} from "@johnhenry/agent-query-core";
