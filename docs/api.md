# API reference — every export, with an example

The complete public surface of `@johnhenry/a2aq`. Conceptual background lives in
[design.md](./design.md). Runnable demos are in [`examples/`](../examples)
(`npm run example:01` … `example:06`).

- [`A2AQuery`](#a2aquery)
  - [Construction](#construction)
  - [`agents()`](#agents)
  - [`card()`](#cardagent--refresh-)
  - [`sendMessage()`](#sendmessageagent-message)
  - [`task()`](#taskagent-taskid)
  - [`taskSnapshot()`](#tasksnapshotagent-taskid)
  - [`client()`](#clientagent)
  - [`cache`](#cache)
- [`TaskHandle`](#taskhandle)
- [Human-in-the-loop: `interactions` + `InputDecision`](#human-in-the-loop)
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

### `sendMessage(agent, message)`

Send a `Message` (the SDK's ts-proto shape — note the `Part` oneof encoding).
An A2A agent may answer with a direct `Message` (returned as-is) or a `Task`
(cached and wrapped in a [`TaskHandle`](#taskhandle)).

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

Sends run in the SDK's `polling: true` client mode: they return promptly with a
possibly-non-terminal task, and the `TaskHandle` owns the poll loop.

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

## Keys & tags

Structured cache keys, serialized canonically:

```ts
type A2AKey =
  | { kind: "card"; agent: string }
  | { kind: "task"; agent: string; taskId: string; partition?: string };

serializeA2AKey({ kind: "card", agent: "travel" }); // '["card","travel"]'
```

Tags are the invalidation currency:

```ts
cardTag("travel");          // "card:travel"        — one agent's card
taskTag("travel", taskId);  // "task:travel:<id>"   — one task
agentTag("travel");         // "agent:travel"       — everything from one agent
```

Every card write carries `[cardTag, agentTag]`; every task write carries
`[taskTag, agentTag]`. So `invalidateTags([agentTag(name)])` is the blunt
"reconnect/removed this agent" hammer, and the finer tags are surgical.

---

## Re-exported core primitives

For convenience, the pieces of `@johnhenry/agent-query-core` consumers configure
are re-exported: `InteractionBroker`, `QueryCache`, and the types `AuditEntry`,
`BaseDecision`, `Interaction`, `PolicyVerdict`. Import them from either package —
they are the same objects.

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

**Executor helpers** — each a complete task lifecycle:

| Helper | Behavior |
|---|---|
| `echoExecutor()` | Completes immediately with a text artifact `echo: <input>` |
| `askThenEchoExecutor()` | Pauses `INPUT_REQUIRED` first turn; completes with `got: <resume text>` |
| `askAuthThenEchoExecutor()` | Pauses `AUTH_REQUIRED` first turn; completes with `authed: <resume text>` |
| `failingExecutor(detail?)` | Fails immediately, `detail` as the status-message error detail |
| `rejectingExecutor(detail?)` | Rejects the task outright |

```ts
import { failingExecutor } from "@johnhenry/a2aq/testing";

const mock = new MockA2AAgent(failingExecutor("disk quota exceeded"));
// … handle.result() rejects: "task <id> failed: disk quota exceeded"
```

The SDK server contract types (`AgentExecutor`, `ExecutionEventBus`,
`RequestContext`) are re-exported for writing custom executors. Remember the
server enforces that the first published event is a task (or message).
