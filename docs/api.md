# API reference — every export, with an example

The complete public surface of `@johnhenry/a2aq`. Conceptual background lives in
[design.md](./design.md). Runnable demos are in [`examples/`](../examples)
(`npm run example:01` … `example:12`). For the SDK version this package is pinned
to and what that means for interop, see the README's
["Supported protocol versions"](../README.md#supported-protocol-versions).

- [`A2AQuery`](#a2aquery)
  - [Construction](#construction)
  - [`agents()`](#agents)
  - [`card()`](#cardagent--refresh-)
  - [`sendMessage()`](#sendmessageagent-message-opts)
  - [`task()`](#taskagent-taskid)
  - [`taskSnapshot()`](#tasksnapshotagent-taskid)
  - [`client()`](#clientagent)
  - [`cache`](#cache)
  - [`status`](#status)
- [`TaskHandle`](#taskhandle)
- [Streaming: `streaming` config + lifecycle](#streaming)
- [Artifacts: entries, accessors, text, eviction](#artifacts)
- [Human-in-the-loop: `interactions` + `InputDecision`](#human-in-the-loop)
- [Resilience: `retry` + idempotency](#resilience-retry--idempotency)
- [Devtools: `devtools` + `A2ADevtoolsEvent`](#devtools)
- [React hooks: `@johnhenry/a2aq/react`](#react-hooks-johnhenrya2aqreact)
- [Skills: `sendSkill` + `a2aq-codegen`](#skills-sendskill--a2aq-codegen)
- [Push notifications: webhooks](#push-notifications-webhooks)
- [Keys & tags](#keys--tags)
- [Re-exported core primitives](#re-exported-core-primitives)
- [Testing: the in-process mock agent](#testing-the-in-process-mock-agent)

---

## A2AQuery

### Construction

```ts
import { A2AQuery, InteractionBroker } from "@johnhenry/a2aq";

const q = new A2AQuery({
  agents: {
    travel: { url: "https://agents.example.com/travel" },
    hr: { url: "https://agents.example.com/hr", cardPath: "/cards/hr.json" },
  },
  interactions: new InteractionBroker(),  // optional HITL broker (see below)
  taskPollMs: 150,                        // poll cadence for task handles (default 150)
  cardStaleTime: 5 * 60_000,              // card cache freshness (default 5 min)
  status: sharedStatusStore,              // optional shared StatusStore (default: fresh)
  retry: { retries: 3 },                  // optional RetryPolicy (absent = single attempt)
  devtools: new DevtoolsHub(),            // optional DevtoolsSink (absent = zero emission)
  streaming: "auto",                      // "auto" (default) | true | false — see Streaming
  detachArtifacts: false,                 // true = task snapshots without inline outputs — see Artifacts
  devtoolsWire: false,                    // true = a2a:wire fetch summaries into the sink — see Devtools
});
```

`AgentConfig` per agent: `{ url, cardPath?, fetchImpl? }`. `fetchImpl` is the
in-process/testing escape hatch — it is used for **both** card resolution and the
JSON-RPC transport, which is how the mock agent plugs in with no sockets.

SDK clients are created lazily (card resolved on first use) and memoized per
agent. A failed connect is **not** cached — the next call retries with a fresh
factory.

### `agents()`

The configured agent names, in declaration order.

```ts
q.agents(); // ["travel", "hr"]
```

### `card(agent, { refresh? })`

The agent's `AgentCard`, cached under `{ kind: "card", agent }` with
`cardStaleTime` freshness. A stale or `refresh: true` read goes back to the
well-known endpoint via the SDK's `DefaultAgentCardResolver` (the SDK `Client`'s
own `getAgentCard()` only returns its in-memory copy).

```ts
const card = await q.card("travel");            // AgentCard — typed, cached
console.log(card.name, card.skills.map((s) => s.name));
await q.card("travel", { refresh: true });      // force a wire refetch
```

### `sendMessage(agent, message, opts?)`

Send a `Message` (the SDK's ts-proto shape — note the `Part` oneof encoding).
An A2A agent may answer with a direct `Message` (returned as-is) or a `Task`
(cached and wrapped in a [`TaskHandle`](#taskhandle)). `opts.push` registers
a push-notification webhook on the send itself — see
[Push notifications](#push-notifications-webhooks).

```ts
import type { Message } from "@a2a-js/sdk";

const message: Message = {
  messageId: "m-1",
  role: "user",
  parts: [{ content: { $case: "text", value: "book a flight to LIS" } }],
} as never;

const reply = await q.sendMessage("travel", message);
if (typeof reply === "object" && "result" in reply) {
  const task = await reply.result();   // TaskHandle → terminal COMPLETED task
} else {
  console.log("direct reply:", reply); // plain Message
}
```

Against a non-streaming agent (or with `streaming: false`), sends run in the
SDK's `polling: true` client mode: they return promptly with a possibly-non-
terminal task, and the `TaskHandle` owns the poll loop. Against a streaming
agent, the send goes out as `sendMessageStream` and the handle is driven by the
stream instead — same return shape, same handle surface (see
[Streaming](#streaming)).

### `task(agent, taskId)`

Re-open a handle for an existing task — e.g. resumed from a stored id after a
restart. Fetches the current state, caches it, returns a handle. A handle seeded
from an already-terminal task settles immediately.

```ts
const handle = await q.task("travel", storedTaskId);
const current = handle.task(); // latest snapshot
```

### `taskSnapshot(agent, taskId)`

The raw cache entry for a task — status, staleness, tags, subscriber count.
This is the read a hooks layer / devtools panel makes; it never touches the wire.

```ts
const entry = q.taskSnapshot("travel", taskId);
entry?.data;      // Task | undefined
entry?.updatedAt; // last write time
```

### `client(agent)`

The underlying SDK `Client` for an agent (lazy, memoized). Use it for anything
a2aq doesn't wrap yet — it shares the same transport and card.

```ts
const sdkClient = await q.client("travel");
```

### `cache`

The shared `QueryCache<A2AKey>` from `@johnhenry/agent-query-core`. Everything
a2aq knows lives here; invalidation is tag-driven (see [Keys & tags](#keys--tags)).

```ts
import { agentTag } from "@johnhenry/a2aq";

q.cache.invalidateTags([agentTag("travel")]); // blunt: everything from one agent
q.cache.clear((k) => k.agent === "travel");   // evict instead of staling
```

### `status`

Per-agent connectivity as a core `StatusStore` (versioned, subscribable —
`idle | connecting | ready | degraded | closed`). Keyed by agent name.
Transitions a2aq drives:

- `connecting` while the SDK client + card are being created; `ready` on success.
- `degraded` on transient send/poll/card errors (with `lastError`; under a
  [`retry` policy](#resilience-retry--idempotency) also `attempt` and `retryAt`
  per scheduled retry); back to `ready` on the next success (`attempt` resets).
- `closed` when a failed connect evicts the client from the registry.

```ts
q.status.subscribe(() => {
  const s = q.status.get("travel");
  render(s?.state, s?.state === "degraded" ? `retry #${s.attempt}` : "");
});
```

Inject a shared store to aggregate several clients (e.g. a2aq + mcpq peers in
one dashboard): `new A2AQuery({ agents, status: sharedStore })` — `q.status`
then *is* that store.

---

## TaskHandle

Returned by `sendMessage()` (task replies) and `task()`. Poll-driven: the loop
starts on the first `result()` or `subscribe()` call and writes every observed
state into the cache.

```ts
interface TaskHandle {
  taskId: string;
  agent: string;
  task(): Task | undefined;                       // latest cached snapshot
  subscribe(fn: (task: Task) => void): () => void; // live updates; returns unsubscribe
  result(): Promise<Task>;                        // resolves on COMPLETED; rejects on FAILED/REJECTED/CANCELED
  respond(message: Message): Promise<void>;       // resume a paused task
  cancel(): Promise<void>;                        // ask the agent to cancel
  artifacts(): Artifact[];                        // from the artifact entries (see Artifacts)
  artifact(artifactId: string): Artifact | undefined;
  artifactText(artifactId?: string): string;      // text-part convenience
}
```

**`task()`** — synchronous cache read, no wire call.

**`subscribe(fn)`** — cache-backed. Structural sharing means idle polls (same
state, same data) emit nothing; `fn` fires once per real change.

```ts
const unsub = handle.subscribe((task) => render(task.status?.state));
```

**`result()`** — the terminal promise. `FAILED` rejections carry the server's
error detail (the status message text) when present:

```ts
await handle.result();
// Error: task 7f3a… failed: disk quota exceeded
// Error: task 7f3a… was rejected: not in scope
// Error: task 7f3a… was canceled
```

**`respond(message)`** — resume a paused (`INPUT_REQUIRED` / `AUTH_REQUIRED`)
task; the `taskId` is attached automatically. Responding to a terminal task
rejects with `task <id> is already terminal (<STATE>); cannot respond`.

**`cancel()`** — cancels via the SDK. If the task is already terminal (the
server refuses), the handle refreshes the snapshot instead of throwing.

---

## Streaming

`streaming` config: `"auto"` (default) streams task observation when the agent
card advertises `capabilities.streaming` and polls otherwise; `false` forces
polling everywhere; `true` behaves like `"auto"` (the capability is still
required — the wire method is rejected without it).

When a handle streams:

- The initial send goes out as **`sendMessageStream`** (SSE); handles re-opened
  with `q.task()` attach with **`resubscribeTask`**. `TaskStatusUpdateEvent` /
  `TaskArtifactUpdateEvent` are folded into the SAME cache entry the poll loop
  writes (artifact `append` chunks are concatenated), through the same
  application step — status transitions, artifacts, broker gating and devtools
  emission behave identically to polling.
- A handle born with a live stream starts its loop **eagerly** (the stream is
  already consuming server resources); poll-mode handles stay lazy.
- **Family rule — reconcile on resume.** Every resubscribe is bracketed by full
  `getTask` reads (before attaching: the task may have settled during the gap;
  after attaching: never assume the gap was empty). A stream that ends
  gracefully without a terminal state reconciles, waits `taskPollMs`, and
  resubscribes.
- **Drop ladder.** A mid-stream drop sets the agent's status to `degraded` and
  emits `a2a:stream {phase:"drop"}`; resubscribe attempts run under the `retry`
  policy; when they fail, the handle emits `{phase:"fallback"}` and finishes
  the task on the poll loop. Polling is always the reconnect path.
- `respond()` resumes stay unary sends (same messageId idempotency contract);
  the stream picks up the resulting execution.

```ts
const q = new A2AQuery({ agents, streaming: "auto", retry: { retries: 3 } });
const handle = (await q.sendMessage("streamer", message)) as TaskHandle;
handle.subscribe((task) => render(task));   // chunks arrive as the agent emits them
await handle.result();                      // same terminal semantics as polling
```

See `examples/08-streaming.ts` for the full drop → resubscribe → reconcile run.

---

## Artifacts

Every observed task write mirrors its artifacts into their own cache entries —
`{ kind: "artifact", agent, taskId, artifactId }`, tagged
`[artifactTag, taskTag, agentTag]` — so large outputs are individually
readable, subscribable, and evictable.

**Accessors** (all synchronous cache reads, no wire calls):

```ts
q.artifacts(agent, taskId);                     // Artifact[] — arrival order
q.artifact(agent, taskId, artifactId);          // Artifact | undefined
q.artifactSnapshot(agent, taskId, artifactId);  // raw CacheEntry (subscribe-ready)

handle.artifacts();                             // same, scoped to the handle's task
handle.artifact("out");
handle.artifactText();                          // all artifacts' text, newline-joined
handle.artifactText("out");                     // one artifact's text parts, concatenated
```

**Reactive reads** — artifact entries are ordinary cache entries; subscribe to
the structured key (streamed `append` chunks emit once per merge):

```ts
const key = { kind: "artifact", agent, taskId, artifactId: "out" } as const;
const unsub = q.cache.subscribe(key, () => render(q.artifact(agent, taskId, "out")));
```

**Text extraction** — standalone helpers over the ts-proto `Part` oneofs
(`content: { $case: "text", value }`), exported from the package root:

```ts
import { partText, artifactText, artifactsText } from "@johnhenry/a2aq";
partText(part);                 // string | undefined (non-text parts → undefined)
artifactText(artifact);         // text parts concatenated
artifactsText(artifacts, "\n"); // across artifacts, separator configurable
```

**`detachArtifacts: true`** stores task snapshots WITHOUT the inline
`artifacts` list (empty array) — outputs live only in the artifact entries and
`handle.artifacts()` / `artifactText()` reassemble them. Task entries stay
lean no matter how big the outputs get; note `result()`/`task()` then return
artifact-less tasks by design.

**Eviction** — reclaim consumed outputs; the task snapshot survives:

```ts
q.evictArtifacts(agent, taskId);          // all of a task's artifact entries
q.evictArtifacts(agent, taskId, "out");   // one
```

A still-observed task re-mirrors artifacts on its next write; evict after
settling (or pair with `detachArtifacts` for one-copy storage). See
`examples/09-artifact-store.ts`.

---

## Human-in-the-loop

Pass an `InteractionBroker<InputDecision>` as `interactions` and every paused
task state routes through it as type `"input-required"` or `"auth-required"`,
with the agent name as the peer and the `Task` as the payload:

```ts
import { A2AQuery, InteractionBroker, type InputDecision } from "@johnhenry/a2aq";

const broker = new InteractionBroker<InputDecision>({
  policy: ({ type }) => (type === "auth-required" ? "ask" : "allow"),
});
const q = new A2AQuery({ agents, interactions: broker });

// Approval-inbox UI:
broker.subscribe(renderInbox);
for (const pending of broker.list()) {
  broker.resolve(pending.id, {
    action: "approve",
    message: followUpMessage, // sent as the resume — taskId attached automatically
  });
}
broker.auditLog(); // every decision: auto-allow / auto-deny / approved / denied
```

`InputDecision` extends the core `BaseDecision`:

```ts
interface InputDecision extends BaseDecision {
  // "approve" | "deny", optional reason — plus:
  message?: Message; // the resume message; omit to approve without auto-resuming
}
```

Broker mechanics (details in [design.md](./design.md#the-paused-state-broker)):

- The broker is prompted **once per pause** — on the transition *into* a paused
  state — and re-arms only after the task observably leaves it. A resume the
  agent is slow to process cannot cause a second prompt or a duplicate resume.
- At most one `gate()` is in flight per handle (single-flight).
- A **deny** sends nothing: the task stays parked in its paused state; drive it
  later with `respond()` or `cancel()`.
- An **approve without a `message`** clears the gate but sends nothing — the
  app supplies the answer via `respond()` (see `examples/06-policy-autopilot.ts`).
- With **no broker configured**, pauses simply appear in the cache and the app
  drives `respond()` manually (see `examples/04-manual-resume.ts`).

---

## Resilience: `retry` + idempotency

Pass a core `RetryPolicy` as `retry` and transient wire failures are retried
with exponential backoff (full jitter, injectable `random` for determinism).
**Absent, behavior is exactly as before: one attempt, first failure rejects.**

```ts
const q = new A2AQuery({
  agents,
  retry: { retries: 3, baseDelayMs: 200, factor: 2 }, // random: () => 0.5 for deterministic tests
});
```

What retries, and why it is safe:

- **Sends** (`sendMessage()` and paused-task resumes via `respond()`/broker
  approvals). a2aq fixes the A2A `messageId` **before the first attempt** —
  generating one client-side if the caller's `Message` has none — and reuses
  the SAME id on every retry. The messageId IS the idempotency key: an agent
  that already processed it can dedupe the duplicate delivery. This is what
  lets a2aq pass `idempotent: true` to the core's `withRetry` (which otherwise
  refuses to retry at all).
- **Task polls** (`getTask`) — natural reads. A transient poll failure retries
  per policy instead of settling the handle; `result()` rejects only on
  exhaustion. Retries happen *inside* one poll step, so pause tracking still
  sees each observed state once — a retried poll cannot double-prompt the broker.
- **Card refetches** — natural reads.

Each scheduled retry updates [`status`](#status): `degraded` with the attempt
count, `retryAt`, and the error. `cancel()` is not retried.

---

## Devtools

Pass any core `DevtoolsSink` (e.g. a `DevtoolsHub` ring buffer) as `devtools`
and a2aq emits compact, JSON-serializable events. **No sink, zero emission.**

```ts
import { A2AQuery, DevtoolsHub, type A2ADevtoolsEvent } from "@johnhenry/a2aq";

const hub = new DevtoolsHub<A2ADevtoolsEvent>();
const q = new A2AQuery({ agents, devtools: hub });
// later: hub.events() — the timeline; hub.subscribe()/getVersion() for panels
```

| Event | Payload | Emitted on |
|---|---|---|
| `a2a:send` | `{ agent, taskId?, messageId }` | send success (initial + resume) |
| `a2a:task-status` | `{ agent, taskId, state }` | observed task state **change** (not every poll) |
| `a2a:artifact` | `{ agent, taskId, artifactId }` | a new artifact appears on an observed task |
| `a2a:gate` | `{ agent, taskId, kind: "input" \| "auth", outcome }` | broker gate resolution |
| `a2a:card-refresh` | `{ agent }` | card refetched from the wire |
| `a2a:push` | `{ agent, taskId, payload: "task" \| "statusUpdate" \| "artifactUpdate" }` | a pushed (webhook) event folded into the cache |
| `a2a:stream` | `{ agent, taskId, phase }` | stream lifecycle edge: `open` \| `resubscribe` \| `drop` \| `fallback` |
| `a2a:status` | `{ agent, state }` | connectivity state change |
| `a2a:wire` | `{ agent, dir, method, taskId?, id?, bytes?, status?, streaming?, error? }` | wire exchange summary (opt-in: `devtoolsWire: true`) |

Task states are emitted as enum names (`"TASK_STATE_WORKING"`). See
`examples/07-devtools-and-resilience.ts` for a full printed timeline.

### Wire log: `devtoolsWire` + `tapFetch`

`devtoolsWire: true` (requires `devtools`) taps each agent's fetch — the
configured `fetchImpl` or the global fetch — and emits one `a2a:wire` event per
direction: `dir: "out"` with the JSON-RPC method, request id, the taskId the
call concerns, and the body size; `dir: "in"` with the HTTP status and a
`streaming` flag for SSE responses (whose bodies the tap never consumes); a
rejected fetch emits `error` instead. **Summaries, never body dumps.**

The tap is a2aq's analog of the core's `instrumentTransport` (which wraps
`send`/`onmessage` transports — a2aq's wire surface is fetch). The wrapper is
also exported standalone for composing outside a2aq:

```ts
import { tapFetch, type A2AWireSummary } from "@johnhenry/a2aq";
const fetchImpl = tapFetch(fetch, (e: A2AWireSummary) => console.log(e));
```

### The full stack in React

One `DevtoolsHub` carries both altitudes (task events + wire log); the core's
`<AgentQueryDevtools>` panel renders it alongside the cache, broker queue, and
status store:

```tsx
import { A2AQuery, DevtoolsHub, type A2ADevtoolsEvent } from "@johnhenry/a2aq";
import { AgentQueryDevtools } from "@johnhenry/agent-query-core/react";

const hub = new DevtoolsHub<A2ADevtoolsEvent>();
const q = new A2AQuery({ agents, devtools: hub, devtoolsWire: true });

export function App() {
  return (
    <>
      {/* …your app… */}
      <AgentQueryDevtools hub={hub} cache={q.cache} broker={q.interactions} status={q.status} />
    </>
  );
}
```

See `examples/10-wire-log.ts` for a printed unified timeline (wire + task
events over a flaky network).

---

## React hooks: `@johnhenry/a2aq/react`

Thin hooks over the store, built on the core's `useSyncExternalStore`
bindings (no resubscribe churn on inline keys, no re-render on
structurally-equal rewrites, SSR-deterministic first paint). React is an
**optional** peer dependency — only this subpath touches it; the root
entrypoint stays framework-free.

### `useAgentCard(q, agent)`

The agent's card, reactively and cached: renders `undefined` until the first
fetch lands, and refetches through `q.card()` (retry policy, `cardStaleTime`)
whenever the observed entry is stale. Fetch failures keep the last snapshot —
`usePeerStatus(q.status, agent)` is the error surface.

```tsx
function Header({ agent }: { agent: string }) {
  const card = useAgentCard(q, agent);
  return <h1>{card?.name ?? "…"}</h1>;
}
```

### `useTask(q, ref)` / `useTaskStatus(q, ref)` / `useTaskArtifacts(q, ref)`

`ref` is a `TaskRef`: either a live `TaskHandle` — mounting the hook **starts
the handle's driver loop** (poll or stream), so the component is the observer
and no `result()`/`subscribe()` call is needed — or a plain
`{ agent, taskId }` pair, which observes the cache only (something else
drives the snapshot: another handle, a webhook, another component).
`undefined` is accepted so you can render before the first send.

- `useTask` → the cached `Task` snapshot (or `undefined`).
- `useTaskStatus` → the state's enum *name* (`"TASK_STATE_WORKING"`), the
  same vocabulary the devtools events use.
- `useTaskArtifacts` → the artifact entries (insertion order, works under
  `detachArtifacts`); array identity is memoized per cache write, so it is
  safe in dependency lists.

```tsx
function TaskView({ handle }: { handle: TaskHandle }) {
  const status = useTaskStatus(q, handle);
  const artifacts = useTaskArtifacts(q, handle);
  return <div>{status} — {artifacts.length} artifacts</div>;
}
```

### `usePendingInput(q)`

The approval inbox: the broker's pending queue filtered to the A2A
paused-state kinds (`"input-required"` / `"auth-required"` — `interaction.type`
distinguishes them for the UI), plus typed resolvers. `approve(id, message)`
resumes the task through the owning handle's `respond()`; `deny(id)` leaves
it parked. With no broker configured the queue is empty and the resolvers are
no-ops.

```tsx
function Inbox() {
  const { pending, approve, deny } = usePendingInput(q);
  return pending.map((p) => (
    <div key={p.id}>
      {p.type} from {p.peer}
      <button onClick={() => approve(p.id, msg("here you go"))}>answer</button>
      <button onClick={() => deny(p.id)}>not now</button>
    </div>
  ));
}
```

### Re-exports

The core hooks compose with a2aq directly and are re-exported for a
one-stop import: `useCacheEntry(q.cache, key)`, `useInteractions`,
`useAuditLog(q.interactions)`, `usePeerStatus(q.status)`, `useVersioned`,
and the `<AgentQueryDevtools>` panel.

### `useSkillTask(q, agent, skillId)`

A skill as a mutation-shaped hook (the orval / connect-query pattern):
`send(input)` invokes the skill via `sendSkill`, and the hook exposes the
resulting handle's reactive state — `{ send, sending, error, handle, reply,
task, status, artifacts, skillId }`. The mounted hook drives the handle's
loop. Generated per-skill hooks (`a2aq-codegen --hooks`) are one-line
wrappers over this.

```tsx
function Booker() {
  const { send, status, artifacts } = useSkillTask(q, "travel", "book-flight");
  return (
    <>
      <button onClick={() => void send("SFO to JFK tomorrow")}>book</button>
      <div>{status}</div>
    </>
  );
}
```

---

## Skills: `sendSkill` + `a2aq-codegen`

**What the card actually provides.** A2A's `AgentSkill` is discovery data:
`id`, `name`, `description`, `tags`, `examples`, and media modes
(`inputModes`/`outputModes`). It does **not** carry parameter schemas —
there is no JSON Schema to derive typed params from — and A2A Messages have
no first-class skill field. a2aq is honest about both: skill invocation
takes `SkillInput` (`string | Part[]`), and the skill id travels in message
metadata under `SKILL_METADATA_KEY` (`"a2aq/skillId"`). Agents that ignore
the key lose nothing; the message is a plain A2A message either way.

### The runtime layer

```ts
import { sendSkill, skillMessage, textPart, SKILL_METADATA_KEY } from "@johnhenry/a2aq";

// Exactly the sendMessage contract (retry under a fixed messageId,
// task-shaped replies come back as a TaskHandle):
const handle = await sendSkill(q, "travel", "book-flight", "SFO to JFK tomorrow");

// Or build the message yourself (metadata is merged; the skill id key wins):
skillMessage("book-flight", [textPart("SFO to JFK")], { contextId: ctx });
```

### The generator

`generateSkillModule(card, opts?)` returns deterministic TypeScript source:
a `skills` record + `SkillId` union (UI listings), one `sendX(q, agent,
input, opts?)` per skill, and — with `{ hooks: true }` — one `useX(q, agent)`
hook over `useSkillTask`. Hooks are behind the flag so non-React consumers
get output with no react import. Skill ids become PascalCase identifiers
(`book-flight` → `sendBookFlight`; collisions get numeric suffixes,
first-come keeps the clean name). The card's modes and examples land in the
JSDoc where a schema would otherwise inform the types, and the generated
header restates the no-schema limitation.

### The CLI

```
a2aq-codegen <card-url-or-file> [-o out.ts] [--hooks]
             [--import-from spec] [--react-import-from spec]
```

Accepts a card JSON file, a direct card URL, or an agent base URL (the
well-known `/.well-known/agent-card.json` path is tried as a fallback).
Without `-o` the module goes to stdout. `--import-from` /
`--react-import-from` retarget the imports (defaults:
`@johnhenry/a2aq` and `@johnhenry/a2aq/react`) — useful for monorepos and
golden-file tests. Generated output is check-in friendly: regenerate and
diff, like any orval-style client.

See `examples/11-skill-codegen.ts`.

---

## Push notifications: webhooks

A2A's disconnected-client story: instead of holding a poll loop or a stream
open, register a webhook and let the agent POST task updates to you. a2aq
wires both halves.

### Registering (client side)

```ts
// On the send itself — rides configuration.taskPushNotificationConfig,
// no second round-trip (spec: taskId stays empty on this path):
const handle = await q.sendMessage("worker", message, {
  push: { url: "https://app.example/hooks/worker", token: SECRET },
});

// For an EXISTING task — the CreateTaskPushNotificationConfig RPC:
await q.registerPush("worker", taskId, { url, token: SECRET, id: "cfg-1" });
```

Both require the agent card to advertise `capabilities.pushNotifications`
(the SDK server drops on-send configs and rejects the RPC without it) —
treat pushes as an *addition* to polling/streaming, not a replacement.
`registerPush` retries under the `retry` policy only when you pass a fixed
`id` (an empty id would mint a duplicate config per attempt).

### Receiving: `createWebhookHandler(q, { agent, token?, reconcile? })`

A transport-agnostic `(req: Request) => Promise<Response>` over the web
standards — mount it in anything that speaks fetch (Node adapters, Hono,
Workers, Deno, Bun). One handler per agent; route by path.

```ts
const handler = createWebhookHandler(q, { agent: "worker", token: SECRET });
// e.g. Bun/Deno/Workers:  serve({ "/hooks/worker": handler })
```

Per POST it: validates the token (`X-A2A-Notification-Token` or
`Authorization: Bearer`; 401 on mismatch — always set one outside tests),
parses the SDK sender's wire shape (a `StreamResponse` JSON: task /
statusUpdate / artifactUpdate / message; a bare Task snapshot is tolerated),
folds it via `q.ingestPush` into the **same cache entries** the poll/stream
drivers write (task snapshots, artifact mirror entries, `a2a:push` devtools
events), and then — **family rule** — follows with a full `getTask`
reconcile, because pushes can arrive out of order, duplicated, or with gaps.
A stale `WORKING` arriving after `COMPLETED` is healed by that read.
Responses: `200` folded, `202` accepted-but-ignored (standalone message),
`400` unparseable, `401` bad token, `405` not a POST. Set
`reconcile: false` only when something else already reconciles the task.

`q.ingestPush(agent, streamResponse)` is exported on its own for custom
receivers (queues, batched deliveries): it is the raw fold — no auth, no
reconcile — returning the touched taskId.

### Testing / honesty

The SDK's server stack really does send pushes (`DefaultRequestHandler` +
`InMemoryPushNotificationStore` + `DefaultPushNotificationSender`), but its
sender dispatches with **global fetch** — no injection seam. The mock agent
therefore takes `pushDelivery: (req: Request) => Response | Promise<Response>`
and dispatches through an in-process sender that reuses the SDK's own
`V1PushNotificationSerializer` (`application/a2a+json`, token in
`X-A2A-Notification-Token`) — identical wire shape, injected transport. Hand
it your handler and the loop closes with no sockets:

```ts
let handler!: (req: Request) => Promise<Response>;
const mock = new MockA2AAgent(echoExecutor(), { pushDelivery: (req) => handler(req) });
const q = new A2AQuery({ agents: { worker: { url: mock.url, fetchImpl: mock.fetchImpl } } });
handler = createWebhookHandler(q, { agent: "worker", token: "t" });
mock.pushStore; // inspect registered configs
```

See `examples/12-push-webhook.ts` — a receiver that never sends or polls,
converging to the completed task purely from pushes.

---

## Keys & tags

Structured cache keys, serialized canonically:

```ts
type A2AKey =
  | { kind: "card"; agent: string }
  | { kind: "task"; agent: string; taskId: string; partition?: string }
  | { kind: "artifact"; agent: string; taskId: string; artifactId: string; partition?: string };

serializeA2AKey({ kind: "card", agent: "travel" }); // '["card","travel"]'
```

Tags are the invalidation currency:

```ts
cardTag("travel");                    // "card:travel"             — one agent's card
taskTag("travel", taskId);            // "task:travel:<id>"        — one task
artifactTag("travel", taskId, "out"); // "artifact:travel:<id>:out" — one artifact
agentTag("travel");                   // "agent:travel"            — everything from one agent
```

Every card write carries `[cardTag, agentTag]`; every task write carries
`[taskTag, agentTag]`; every artifact write carries
`[artifactTag, taskTag, agentTag]`. So `invalidateTags([agentTag(name)])` is
the blunt "reconnect/removed this agent" hammer, and the finer tags are
surgical (a task's tag reaches its artifacts too).

---

## Re-exported core primitives

For convenience, the pieces of `@johnhenry/agent-query-core` consumers configure
are re-exported: `InteractionBroker`, `QueryCache`, `StatusStore`, `DevtoolsHub`,
`withRetry`, and the types `AuditEntry`, `BaseDecision`, `ConnectivityState`,
`DevtoolsSink`, `Interaction`, `PeerStatus`, `PolicyVerdict`, `RetryPolicy`.
Import them from either package — they are the same objects.

---

## Testing: the in-process mock agent

`@johnhenry/a2aq/testing` runs the **SDK's own server stack**
(`DefaultRequestHandler` + `JsonRpcTransportHandler` + `InMemoryTaskStore`)
behind an injected `fetch`, so tests exercise the real wire codec with no
sockets.

```ts
import { MockA2AAgent, echoExecutor } from "@johnhenry/a2aq/testing";

const mock = new MockA2AAgent(echoExecutor(), { name: "echo-agent" });
const q = new A2AQuery({
  agents: { echo: { url: mock.url, fetchImpl: mock.fetchImpl } },
});
```

**`MockA2AAgent`**

- `new MockA2AAgent(executor, { name?, url?, card? })` — any SDK `AgentExecutor`.
- `fetchImpl` — inject as `AgentConfig.fetchImpl`; serves the card (GET) and
  JSON-RPC (POST).
- `callLog` — every wire call: `{ method: "GetAgentCard" | "SendMessage" |
  "GetTask" | "CancelTask", params }`. Assert on it to prove what did (or did
  not) hit the wire.
- `store` — the server's `InMemoryTaskStore`.
- `setTaskState(taskId, state)` — force a task into a state out-of-band; the
  deterministic way to drive transitions (leave / re-enter a pause) that a
  polling client observes.

Streaming requests (the SDK's JSON-RPC transport sends
`Accept: text/event-stream` for `SendStreamingMessage` / `SubscribeToTask`) are
served as a REAL SSE response — one JSON-RPC envelope per `data:` event,
flushed as the server's generator yields. The pump keeps draining (persisting
execution events) after a client disconnect, like a real agent that does not
stop executing when a subscriber goes away. Non-streaming clients keep the
drain-to-last-envelope JSON behavior. Advertise the capability to stream:

```ts
const mock = new MockA2AAgent(pacedStreamingExecutor(), {
  card: { capabilities: { streaming: true } } as Partial<AgentCard>,
});
```

**`droppingStreamFetchImpl(mock, { dropAfterEvents, streams?, thenFailStreams?, error? })`** —
wrap the mock's fetch so SSE responses DROP mid-stream: the first `streams`
(default 1) streaming responses error after `dropAfterEvents` events (the
server keeps executing — only the client's connection dies), and with
`thenFailStreams` later streaming requests fail at connect time, forcing the
poll fallback. Non-streaming traffic always passes through.

**`flakyFetchImpl(mock, { failFirst, methods?, error? })`** — wrap the mock's
fetch in transient network failure: the first `failFirst` matching requests
throw a network-ish `TypeError` *before* reaching the server, then delegate.
Failed attempts are still recorded in `mock.callLog`, so tests can assert what
every attempt carried (e.g. that retries reuse the identical messageId).
`methods` restricts failures to specific wire methods (`"SendMessage"`,
`"GetTask"`, `"CancelTask"`, `"GetAgentCard"` for card GETs).

```ts
import { MockA2AAgent, echoExecutor, flakyFetchImpl } from "@johnhenry/a2aq/testing";

const mock = new MockA2AAgent(echoExecutor());
const fetchImpl = flakyFetchImpl(mock, { failFirst: 2, methods: ["SendMessage"] });
// inject fetchImpl into AgentConfig; pair with a retry policy to see recovery
```

**Executor helpers** — each a complete task lifecycle:

| Helper | Behavior |
|---|---|
| `echoExecutor()` | Completes immediately with a text artifact `echo: <input>` |
| `askThenEchoExecutor()` | Pauses `INPUT_REQUIRED` first turn; completes with `got: <resume text>` |
| `askAuthThenEchoExecutor()` | Pauses `AUTH_REQUIRED` first turn; completes with `authed: <resume text>` |
| `failingExecutor(detail?)` | Fails immediately, `detail` as the status-message error detail |
| `rejectingExecutor(detail?)` | Rejects the task outright |
| `pacedStreamingExecutor({ chunks?, stepMs? })` | Streams WORKING → appended artifact chunks (spaced `stepMs`) → COMPLETED; keeps the execution alive for mid-stream drops/resubscribes |

```ts
import { failingExecutor } from "@johnhenry/a2aq/testing";

const mock = new MockA2AAgent(failingExecutor("disk quota exceeded"));
// … handle.result() rejects: "task <id> failed: disk quota exceeded"
```

The SDK server contract types (`AgentExecutor`, `ExecutionEventBus`,
`RequestContext`) are re-exported for writing custom executors. Remember the
server enforces that the first published event is a task (or message).
