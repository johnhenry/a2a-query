// @johnhenry/a2aq — reactive, cached, embeddable A2A client for non-agentic apps.

export { A2AQuery } from "./client.js";
export type { A2AQueryConfig, AgentConfig, InputDecision, TaskHandle } from "./client.js";
export { serializeA2AKey, cardTag, taskTag, agentTag } from "./keys.js";
export type { A2AKey } from "./keys.js";
// Re-export the core primitives consumers configure.
export { InteractionBroker, QueryCache } from "@johnhenry/agent-query-core";
export type { AuditEntry, BaseDecision, Interaction, PolicyVerdict } from "@johnhenry/agent-query-core";
