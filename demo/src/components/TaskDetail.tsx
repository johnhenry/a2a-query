// Task detail: live status, an event timeline (filtered from the shared
// DevtoolsHub — sends, state changes, artifacts, gates, stream edges), and
// the task's artifacts read from their own cache entries.

import { useVersioned, useTaskArtifacts, useTaskStatus } from "@johnhenry/a2aq/react";
import { artifactText, type A2ADevtoolsEvent } from "@johnhenry/a2aq";
import { hub, q } from "../hub";
import type { DemoTask } from "../taskList";
import { pretty } from "./TaskBoard";

const eventLine = (e: A2ADevtoolsEvent): string => {
  switch (e.type) {
    case "a2a:send":
      return `send → messageId ${e.messageId.slice(0, 14)}…`;
    case "a2a:task-status":
      return `state → ${pretty(e.state)}`;
    case "a2a:artifact":
      return `artifact "${e.artifactId}" appeared`;
    case "a2a:gate":
      return `${e.kind === "auth" ? "AUTH" : "INPUT"} gate → ${e.outcome}`;
    case "a2a:stream":
      return `stream ${e.phase}`;
    default:
      return e.type;
  }
};

export function TaskDetail({ task }: { task: DemoTask | undefined }) {
  useVersioned(hub.subscribe.bind(hub), hub.getVersion.bind(hub));
  const state = useTaskStatus(q, task?.handle);
  const artifacts = useTaskArtifacts(q, task?.handle);
  if (!task) {
    return (
      <section className="pane detail">
        <h2>Task detail</h2>
        <p className="hint">Select a task on the board.</p>
      </section>
    );
  }
  const timeline = hub
    .events()
    .filter(
      (e): e is A2ADevtoolsEvent =>
        "taskId" in e && (e as { taskId?: string }).taskId === task.handle.taskId,
    );
  return (
    <section className="pane detail">
      <h2>Task detail</h2>
      <div className="detail-head">
        <span className="task-label">{task.label}</span>
        <span className="chip">{pretty(state)}</span>
      </div>
      <div className="detail-meta">
        {task.agent} · {task.handle.taskId.slice(0, 18)}… · started {new Date(task.startedAt).toLocaleTimeString()}
      </div>
      <button
        className="btn btn-ghost"
        onClick={() => void task.handle.cancel().catch(() => {})}
        disabled={state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED" || state === "TASK_STATE_CANCELED"}
      >
        cancel task
      </button>

      <h3>Timeline</h3>
      <ol className="timeline">
        {timeline.map((e, i) => (
          <li key={i} className={`ev ev-${e.type.replace("a2a:", "")}`}>
            <span className="ev-type">{e.type}</span> {eventLine(e)}
          </li>
        ))}
      </ol>

      <h3>Artifacts ({artifacts.length})</h3>
      {artifacts.map((a) => (
        <div key={a.artifactId} className="artifact">
          <div className="artifact-name">{a.name || a.artifactId}</div>
          <pre>{artifactText(a)}</pre>
        </div>
      ))}
    </section>
  );
}
