// Agent fleet: card metadata via useAgentCard (mounting triggers the cached,
// retry-policied fetch), live connectivity chips via usePeerStatus.

import { useAgentCard, usePeerStatus } from "@johnhenry/a2aq/react";
import { AGENTS, q } from "../hub";

function AgentEntry({ agent }: { agent: string }) {
  const card = useAgentCard(q, agent);
  const status = usePeerStatus(q.status, agent);
  const state = status?.state ?? "idle";
  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-name">{agent}</span>
        <span className={`chip chip-${state}`} title={status?.lastError ? String(status.lastError) : state}>
          {state}
          {state === "degraded" && status?.attempt ? ` · retry #${status.attempt}` : ""}
        </span>
      </div>
      <div className="agent-card-title">{card?.name ?? "resolving card…"}</div>
      <div className="agent-card-desc">{card?.description ?? ""}</div>
      {card?.capabilities?.streaming ? <span className="tag">SSE streaming</span> : null}
      {(card?.skills ?? []).map((s) => (
        <span key={s.id} className="tag">
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function FleetSidebar() {
  return (
    <aside className="pane fleet">
      <h2>Agent fleet</h2>
      {AGENTS.map((a) => (
        <AgentEntry key={a} agent={a} />
      ))}
    </aside>
  );
}
