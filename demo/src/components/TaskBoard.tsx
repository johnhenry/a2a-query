// Task board: launched tasks grouped by live state. The grouping re-renders
// on any cache write (subscribeAll); each card's chip is driven by
// useTaskStatus, which — given a TaskHandle — also starts the handle's
// driver loop (poll or SSE stream). Mounting IS observing.

import { useEffect, useReducer, useSyncExternalStore } from "react";
import { TaskState } from "@a2a-js/sdk";
import { useTaskStatus } from "@johnhenry/a2aq/react";

const nameOf = (state: number): string => TaskState[state] ?? String(state);
import { q } from "../hub";
import { taskList, type DemoTask } from "../taskList";

/** "TASK_STATE_INPUT_REQUIRED" → "input required" */
export const pretty = (state: string | undefined): string =>
  (state ?? "sending").replace(/^TASK_STATE_/, "").replaceAll("_", " ").toLowerCase();

const bucketOf = (state: string | undefined): keyof typeof BUCKETS => {
  switch (state) {
    case "TASK_STATE_INPUT_REQUIRED":
    case "TASK_STATE_AUTH_REQUIRED":
      return "paused";
    case "TASK_STATE_COMPLETED":
      return "done";
    case "TASK_STATE_FAILED":
    case "TASK_STATE_REJECTED":
    case "TASK_STATE_CANCELED":
      return "stopped";
    default:
      return "active";
  }
};

const BUCKETS = {
  active: "Active",
  paused: "Needs a human",
  done: "Completed",
  stopped: "Failed / canceled",
} as const;

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: DemoTask;
  selected: boolean;
  onSelect: (t: DemoTask) => void;
}) {
  const state = useTaskStatus(q, task.handle);
  return (
    <button className={`task-card${selected ? " selected" : ""}`} onClick={() => onSelect(task)}>
      <span className={`chip chip-task-${bucketOf(state)}`}>{pretty(state)}</span>
      <span className="task-label">{task.label}</span>
      <span className="task-agent">{task.agent}</span>
    </button>
  );
}

export function TaskBoard({
  selectedKey,
  onSelect,
}: {
  selectedKey: number | undefined;
  onSelect: (t: DemoTask) => void;
}) {
  const tasks = useSyncExternalStore(taskList.subscribe, taskList.list, taskList.list);
  // Re-bucket on ANY cache write (state transitions move cards between groups).
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => q.cache.subscribeAll(force), []);

  const grouped = new Map<keyof typeof BUCKETS, DemoTask[]>();
  for (const t of tasks) {
    const snap = q.taskSnapshot(t.agent, t.handle.taskId)?.data as
      | { status?: { state?: number } }
      | undefined;
    const stateName = snap?.status?.state === undefined ? undefined : nameOf(snap.status.state);
    const b = bucketOf(stateName);
    grouped.set(b, [...(grouped.get(b) ?? []), t]);
  }

  return (
    <section className="pane board">
      <h2>Task board</h2>
      {tasks.length === 0 ? <p className="hint">No tasks yet — launch a scenario above.</p> : null}
      {(Object.keys(BUCKETS) as Array<keyof typeof BUCKETS>).map((b) =>
        grouped.has(b) ? (
          <div key={b} className="bucket">
            <h3>
              {BUCKETS[b]} <span className="count">{grouped.get(b)!.length}</span>
            </h3>
            {grouped
              .get(b)!
              .map((t) => (
                <TaskCard key={t.key} task={t} selected={t.key === selectedKey} onSelect={onSelect} />
              ))}
          </div>
        ) : null,
      )}
    </section>
  );
}
