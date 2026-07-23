// @johnhenry/a2aq/react — thin React hooks over the a2aq store.
//
// Built on agent-query-core's react bindings (useCacheEntry /
// useInteractions), which ride useSyncExternalStore — so the hooks inherit
// the store's guarantees: no resubscribe churn on inline keys, no re-render
// on structurally-equal rewrites, SSR-deterministic first paint.
//
// React is an OPTIONAL peer dependency: importing the root entrypoint never
// touches it; only this subpath does.

import { useEffect, useMemo } from "react";
import { useCacheEntry, useInteractions } from "@johnhenry/agent-query-core/react";
import type { Interaction } from "@johnhenry/agent-query-core";
import { TaskState, type AgentCard, type Artifact, type Message, type Task } from "@a2a-js/sdk";
import type { A2AQuery, InputDecision, TaskHandle } from "../client.js";

/**
 * How hooks name a task: a plain `{ agent, taskId }` pair (cache-only
 * observation — something else drives the snapshot: another handle, a
 * webhook, a poll loop elsewhere) or a live `TaskHandle` (the hook ALSO
 * starts the handle's driver loop, so mounting the component is enough to
 * keep the snapshot moving). `undefined` is allowed so callers can render
 * before a task exists (e.g. before the first send).
 */
export type TaskRef = { agent: string; taskId: string } | TaskHandle;

const isHandle = (ref: TaskRef): ref is TaskHandle => typeof (ref as TaskHandle).subscribe === "function";

/** The `{agent, taskId}` identity of a ref (dummy key when absent — never written). */
const refIds = (ref: TaskRef | undefined): { agent: string; taskId: string } =>
  ref ? { agent: ref.agent, taskId: ref.taskId } : { agent: "", taskId: "" };

/**
 * The agent's card, reactively and cached. Renders `undefined` until the
 * first fetch lands; refetches (via `q.card()`, i.e. under the retry policy
 * and `cardStaleTime`) whenever the observed entry is stale on mount or
 * after a write. Fetch failures leave the last snapshot in place — the
 * StatusStore (usePeerStatus) is the error surface.
 */
export function useAgentCard(q: A2AQuery, agent: string): AgentCard | undefined {
  const entry = useCacheEntry(q.cache, { kind: "card", agent });
  useEffect(() => {
    if (q.cache.isStale({ kind: "card", agent })) void q.card(agent).catch(() => {});
  }, [q, agent, entry]);
  return entry?.data as AgentCard | undefined;
}

/**
 * One task's cached snapshot, reactively. Given a `TaskHandle`, mounting the
 * hook also starts (and keeps) the handle's driver loop — the component IS
 * the observer; given a plain `{ agent, taskId }` ref it observes the cache
 * only (webhooks, other handles, or other components drive it).
 */
export function useTask(q: A2AQuery, ref: TaskRef | undefined): Task | undefined {
  useEffect(() => {
    if (ref && isHandle(ref)) return ref.subscribe(() => {});
    return undefined;
  }, [ref]);
  const { agent, taskId } = refIds(ref);
  const entry = useCacheEntry(q.cache, { kind: "task", agent, taskId });
  return ref ? (entry?.data as Task | undefined) : undefined;
}

/**
 * The task's state as its enum NAME (`"TASK_STATE_WORKING"`), reactively —
 * the same vocabulary the devtools events use. `undefined` before the first
 * snapshot.
 */
export function useTaskStatus(q: A2AQuery, ref: TaskRef | undefined): string | undefined {
  const task = useTask(q, ref);
  const state = task?.status?.state;
  return state === undefined ? undefined : (TaskState[state] ?? String(state));
}

const NO_ARTIFACTS: Artifact[] = [];

/**
 * The task's artifacts from their own cache entries (insertion order, works
 * under `detachArtifacts`), reactively. Every artifact mirror is written
 * alongside a task write, so observing the task entry is sufficient; the
 * array identity is memoized per snapshot (safe in dependency lists).
 */
export function useTaskArtifacts(q: A2AQuery, ref: TaskRef | undefined): Artifact[] {
  useEffect(() => {
    if (ref && isHandle(ref)) return ref.subscribe(() => {});
    return undefined;
  }, [ref]);
  const { agent, taskId } = refIds(ref);
  const entry = useCacheEntry(q.cache, { kind: "task", agent, taskId });
  // Entries are stable objects mutated in place — memo on the version counter,
  // not the entry identity, so each write recomputes the (then-stable) array.
  const version = entry?.version ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the entry's change signal
  return useMemo(() => (ref ? q.artifacts(agent, taskId) : NO_ARTIFACTS), [q, agent, taskId, version, ref]);
}

/** What `usePendingInput` returns: the paused-task queue + typed resolvers. */
export interface UsePendingInputResult {
  /** Pending broker interactions of the paused-state kinds (`input-required` / `auth-required`). */
  pending: Interaction[];
  /** Resolve one by id — typed over a2aq's InputDecision. */
  resolve: (id: number, decision: InputDecision) => void;
  /** Sugar: approve with the follow-up message that resumes the task. */
  approve: (id: number, message: Message) => void;
  /** Sugar: deny (the task stays parked; respond via the handle later if you change your mind). */
  deny: (id: number) => void;
}

/**
 * The approval inbox, reactively: the broker's pending queue filtered to the
 * A2A paused-state kinds (`input-required` / `auth-required` — `interaction.type`
 * distinguishes them for the UI), plus typed resolvers. Approving with a
 * message routes through the owning TaskHandle's `respond()`, resuming the
 * task. With no broker configured the queue is empty and resolvers are no-ops.
 *
 * ```tsx
 * const { pending, approve } = usePendingInput(q);
 * return pending.map((p) => (
 *   <button key={p.id} onClick={() => approve(p.id, msg("here you go"))}>answer</button>
 * ));
 * ```
 */
export function usePendingInput(q: A2AQuery): UsePendingInputResult {
  const { interactions, resolve } = useInteractions<InputDecision>(q.interactions);
  return useMemo(() => {
    const pending = interactions.filter((i) => i.type === "input-required" || i.type === "auth-required");
    return {
      pending,
      resolve,
      approve: (id: number, message: Message) => resolve(id, { action: "approve", message }),
      deny: (id: number) => resolve(id, { action: "deny" }),
    };
  }, [interactions, resolve]);
}

// The core hooks compose with a2aq directly (useAuditLog(q.interactions),
// usePeerStatus(q.status), useCacheEntry(q.cache, key)) — re-exported so a
// React app needs a single import.
export {
  useAuditLog,
  useCacheEntry,
  useInteractions,
  usePeerStatus,
  useVersioned,
  AgentQueryDevtools,
} from "@johnhenry/agent-query-core/react";
