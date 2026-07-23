// A tiny app-level registry of launched demo tasks. a2aq's cache holds the
// task SNAPSHOTS; this store just remembers which handles the user launched
// (and in what order) so the board can render them.

import type { TaskHandle } from "@johnhenry/a2aq";

export interface DemoTask {
  key: number;
  label: string;
  agent: string;
  handle: TaskHandle;
  startedAt: number;
}

type Listener = () => void;

class TaskListStore {
  private tasks: DemoTask[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  add(t: Omit<DemoTask, "key" | "startedAt">): DemoTask {
    const task: DemoTask = { ...t, key: ++this.seq, startedAt: Date.now() };
    this.tasks = [...this.tasks, task];
    for (const fn of this.listeners) fn();
    return task;
  }

  /** Immutable snapshot (identity changes only on add). */
  list = (): DemoTask[] => this.tasks;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export const taskList = new TaskListStore();
