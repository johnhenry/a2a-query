// THE approval inbox — the wedge. Paused tasks (INPUT_REQUIRED /
// AUTH_REQUIRED) land in the InteractionBroker's queue; usePendingInput
// exposes them with typed resolvers. Approving with a message resumes the
// task through the owning handle's respond() (same retried, idempotent send
// path); denying leaves it parked. Every decision lands in the audit trail.

import { useState } from "react";
import { useAuditLog, usePendingInput } from "@johnhenry/a2aq/react";
import { partText } from "@johnhenry/a2aq";
import type { Task } from "@a2a-js/sdk";
import type { Interaction } from "@johnhenry/a2aq";
import { broker, msg, q } from "../hub";

/** The paused task's prompt — the text of its status message, if any. */
const promptOf = (payload: unknown): string => {
  const task = payload as Task | undefined;
  const parts = task?.status?.message?.parts ?? [];
  return parts.map((p) => partText(p) ?? "").join("") || "(no prompt text)";
};

const DEFAULT_REPLY: Record<string, string> = {
  "input-required": "Approved — proceed with the rollout.",
  "auth-required": "token: demo-secret-42",
};

function PendingItem({
  p,
  approve,
  deny,
}: {
  p: Interaction;
  approve: (id: number, message: ReturnType<typeof msg>) => void;
  deny: (id: number) => void;
}) {
  const [reply, setReply] = useState(DEFAULT_REPLY[p.type] ?? "");
  const task = p.payload as Task | undefined;
  return (
    <div className={`pending pending-${p.type}`}>
      <div className="pending-head">
        <span className={`chip chip-${p.type}`}>{p.type}</span>
        <span className="pending-peer">{p.peer}</span>
        <span className="pending-task">{task?.id?.slice(0, 12)}…</span>
      </div>
      <div className="pending-prompt">{promptOf(p.payload)}</div>
      <div className="pending-actions">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={p.type === "auth-required" ? "credentials…" : "your answer…"}
          aria-label="response"
        />
        <button className="btn btn-approve" onClick={() => approve(p.id, msg(reply))}>
          approve
        </button>
        <button className="btn btn-deny" onClick={() => deny(p.id)}>
          deny
        </button>
      </div>
    </div>
  );
}

export function ApprovalInbox() {
  const { pending, approve, deny } = usePendingInput(q);
  const audit = useAuditLog(broker);
  return (
    <section className="pane inbox">
      <h2>
        Approval inbox {pending.length > 0 ? <span className="badge">{pending.length}</span> : null}
      </h2>
      {pending.length === 0 ? <p className="hint">Nothing pending — launch “Deploy” or “Billing”.</p> : null}
      {pending.map((p) => (
        <PendingItem key={p.id} p={p} approve={approve} deny={deny} />
      ))}

      <h3>Audit trail</h3>
      {audit.length === 0 ? <p className="hint">No decisions yet.</p> : null}
      <ol className="audit">
        {audit.map((e) => (
          <li key={e.id}>
            <span className="audit-time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className="audit-peer">{e.peer}</span>
            <span className="audit-type">{e.type}</span>
            <span className={`chip chip-outcome-${e.outcome}`}>{e.outcome}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
