# Why a2aq looks the way it does

How `@johnhenry/a2aq` maps A2A onto `@johnhenry/agent-query-core` — the shared
engine behind the [agent-query family](https://github.com/johnhenry/agent-query-core)
(sibling: [`@johnhenry/mcpq`](https://github.com/johnhenry/mcp-query) for MCP).

## The reframe

The official `@a2a-js/sdk` is deliberately thin on the client side: transports,
wire codecs, card resolution, a single-endpoint `Client`. That is the right
scope for a protocol SDK — and exactly the wrong stopping point for an
application. An app that talks to agents needs the same things a GraphQL app
needed beyond a raw HTTP client: a **declarative, cached, reactive data layer**.

a2aq is that layer for A2A. It treats remote agents as a capability surface a
*non-agentic* app consumes — a dashboard, an approval inbox, a form — with
TanStack-Query ergonomics: a cache, snapshots, subscriptions, tag invalidation.

## What the SDK provides vs what a2aq adds

| Concern | `@a2a-js/sdk` | `@johnhenry/a2aq` |
|---|---|---|
| Wire codec, transports (JSON-RPC/…) | ✅ | uses as-is |
| Agent card resolution | ✅ (`DefaultAgentCardResolver`) | cached with `cardStaleTime`, tag-invalidatable |
| Single-endpoint `Client` | ✅ | memoized per agent, failure-evicting registry over many |
| Send / get / cancel task | ✅ | `sendMessage()` routing + typed wrappers |
| Task lifecycle observation | polling flag (`polling: true`) | poll-driven `TaskHandle` writing into a reactive cache |
| Paused states (`INPUT_REQUIRED`/`AUTH_REQUIRED`) | states on the wire | first-class **resume points**: broker gating, `respond()` |
| Human-in-the-loop | — | `InteractionBroker` (policy, pending queue, audit trail) |
| Multi-agent | — (one endpoint per `Client`) | registry/router, per-agent cache isolation |
| Testing | server stack | in-process mock agent behind injected `fetch` |

Nothing is forked: a2aq holds real SDK `Client`s and the escape hatch
(`q.client(agent)`) hands you one.

a2aq is pinned to an exact `@a2a-js/sdk` version and leaves protocol-version
matching to the SDK/agent entirely — see the README's
["Supported protocol versions"](../README.md#supported-protocol-versions) for
the canonical statement of what that means for interop.

## Keys & tags: the cache vocabulary

Three kinds of entries, structured keys, canonical serialization:

```
{ kind: "card", agent }                                  tags: card:<agent>, agent:<agent>
{ kind: "task", agent, taskId, partition? }              tags: task:<agent>:<id>, agent:<agent>
{ kind: "artifact", agent, taskId, artifactId, partition? }
                                 tags: artifact:<agent>:<task>:<id>, task:<agent>:<task>, agent:<agent>
```

Artifacts get their own entries (mirrored on every task write; the ONLY copy
under `detachArtifacts`) because task outputs and task state have different
lifecycles: outputs can be huge, are consumed rather than watched, and want
individual eviction — while the task snapshot stays small and long-lived. The
artifact entry carries its task's tag, so task-level invalidation reaches the
outputs for free.

Design rules, inherited from the family:

- **Keys are structured, never string-concatenated by consumers.** The cache
  gets one canonical serializer (`serializeA2AKey`); snapshots carry the
  structured key back so nobody parses strings.
- **Tags are the invalidation currency.** Fine tags (`card:`, `task:`) for
  surgical staleness; the coarse `agent:` tag for blunt "this agent
  reconnected / was removed" invalidation. Every write carries both.
- **Never mutate a cached object.** The cache uses structural sharing to
  suppress no-op emits; mutating in place would make a change invisible. a2aq
  only ever writes fresh objects from the wire.
- `partition` is reserved for multi-tenant isolation (same task id, different
  authorization context) — present in the key shape now so it is not a
  breaking change later.

## The task-handle lifecycle

A `TaskHandle` is a state machine driven by an observation loop — polling by
default, streaming when the card advertises it (see
[Polling and streaming](#polling-and-streaming-two-drivers-one-surface)). A
poll-mode loop is lazy — it starts on the first `result()` or `subscribe()`
call; a handle born with a live send stream drives it eagerly (the stream is
already consuming server resources). Every observed state is written to the
cache, so `task()` snapshots and subscriptions are always consistent with what
the loop last saw.

```
                    ┌──────────────── poll ────────────────┐
                    ▼                                      │
   seed ──▶ SUBMITTED / WORKING ──▶ INPUT_REQUIRED ──┐     │
                    │                AUTH_REQUIRED ◀─┼─────┤   paused: broker
                    │                     │ respond() │     │   prompt on ENTRY
                    ▼                     ▼           │     │
              COMPLETED ──▶ resolve   WORKING ────────┘─────┘
              FAILED    ──▶ reject (with server detail)
              REJECTED  ──▶ reject          } terminal: settle,
              CANCELED  ──▶ reject          } loop exits
```

- **Settling.** `COMPLETED` resolves `result()` with the task; the other
  terminal states reject. A `FAILED`/`REJECTED` rejection appends the server's
  status-message text — the error detail an operator actually needs.
- **Seed-terminal.** A handle opened on an already-finished task settles from
  the seed without polling.
- **Poll errors** (agent unreachable mid-task) reject `result()` and stop the
  loop; the last good snapshot stays in the cache.
- **Terminal guards.** `respond()` on a terminal task rejects clearly;
  `cancel()` on a task the server refuses to cancel (already terminal)
  refreshes the snapshot instead of throwing.

### The paused-state broker

A2A's `INPUT_REQUIRED` and `AUTH_REQUIRED` are the protocol's human-in-the-loop
seams: the agent is parked until someone sends a follow-up message. a2aq routes
them through the shared `InteractionBroker` with three invariants:

1. **Prompt on entry, not on presence.** Polling shows the *same* paused state
   many times; the handle tracks the last-seen state and prompts only on a
   transition *into* a pause. After a resume is sent, the agent may take
   several polls to leave the state — the broker must not be re-prompted and a
   second resume must not be sent. Re-arming happens only after the task
   observably leaves the paused state (and a switch between paused states —
   `INPUT_REQUIRED → AUTH_REQUIRED` — is a new pause).
2. **Single-flight.** At most one `gate()` per handle is in flight. A human can
   take minutes to decide; polls keep running (the cache stays live for
   dashboards) but never stack a second prompt behind the first.
3. **Deny is inert.** A denied (or policy-auto-denied) pause sends nothing.
   The task stays parked; the audit trail records the denial; the app can
   still `respond()` or `cancel()` later. Approving *with* a `message` resumes
   the task; approving *without* one clears the gate and leaves the answer to
   the app.

The broker itself (policy → pending queue → audit) is protocol-agnostic core;
a2aq's contribution is the mapping: pause type → interaction type, agent →
peer, `Task` → payload, decision `message` → resume.

### Polling and streaming: two drivers, one surface

Polling (`taskPollMs`, SDK `polling: true` mode) is the baseline because it
works against every A2A server with zero capability negotiation, and because
the cache turns polling's weakness (redundant reads) into a non-event:
structurally equal writes emit nothing.

Streaming (`sendMessageStream` / `resubscribeTask`) slots in *behind* the same
`TaskHandle` surface — it changes how snapshots arrive, not what consumers see.
With `streaming: "auto"` (the default), a handle streams when the agent card
advertises `capabilities.streaming` and polls otherwise; `streaming: false`
forces polling everywhere. The design rule is **one application step**: every
observation — a polled `getTask`, a streamed full task, a `TaskStatusUpdateEvent`
folded into the current snapshot, a `TaskArtifactUpdateEvent` upserted into the
artifact list (`append` respected) — funnels through the same
write → devtools-observe → settle → broker-gate sequence. Streaming therefore
cannot diverge from polling on any lifecycle behavior: pause gating, terminal
settlement, artifact/devtools emission are literally the same code path.

The failure ladder for a live stream:

1. **Drop** (the SSE connection dies mid-task): the agent's status goes
   `degraded` (honest: the client object is fine, the wire hurt) and a
   `a2a:stream {phase:"drop"}` devtools event marks the timeline.
2. **Resubscribe**: `resubscribeTask`, attempted under the configured `retry`
   policy. Every successful (re)attach is followed by the family-rule
   reconcile (below). A stream that ends *gracefully* without a terminal state
   (an executor turn ending on a pause) reconciles and resubscribes on the
   poll cadence — a parked task costs no more than polling would.
3. **Fallback**: when resubscription fails even under the retry policy, the
   handle emits `a2a:stream {phase:"fallback"}` and drops to the poll loop for
   the rest of its life. Polling is the reconnect path, not an apology.

The initial send stream is opened inside the same retried closure as a unary
send — a failed open is re-attempted whole (fresh generator, same `messageId`,
the idempotency key). Resumes (`respond()`) stay unary sends; the stream picks
up the resulting execution.

Webhook push notifications are covered separately below, in "Pushes are hints; reads are truth."

## The resilience model

Three additive layers from the core, all off by default and all truthful.

### Status semantics

`q.status` is a core `StatusStore` — the gRPC channel-state vocabulary
(`idle | connecting | ready | degraded | closed`), keyed by agent name. The
rule is honesty about what each state *means* for the client object:

- **`connecting` → `ready`** brackets SDK client + card creation.
- **`degraded`** means "the client is intact; a wire call failed transiently" —
  send, poll, or card errors. Under a retry policy, every scheduled retry
  merges `attempt` + `retryAt` + `lastError` (the "retrying in Ns" UI). The
  next successful call returns the agent to `ready` (attempt resets to 0).
- **`closed`** means "the client object is gone": a failed connect evicts the
  memoized client from the registry, and eviction — not a transient error —
  is what sets `closed`. A later call re-creates the client (`connecting` again).

Inject one `StatusStore` into several clients (`status` config) to aggregate a
multi-protocol dashboard; a2aq contributes its agents as peers.

### Retry & idempotency: the messageId contract

The core's `withRetry` refuses to retry anything not explicitly declared
`idempotent: true` — the caller must point at the mechanism that makes a
duplicate delivery safe. a2aq's mechanism is the protocol's own: **the A2A
`messageId` is the idempotency key.** a2aq fixes it client-side *before the
first attempt* (generating one when the caller's `Message` has none) and
reuses the identical id on every retry, so an agent that already processed
the message can dedupe the duplicate. Without that fixed id, a retried send
would be a double-send — which is exactly why no `retry` config means strict
single-attempt behavior.

Polls and card fetches are reads — naturally idempotent. A transient poll
failure retries *inside* one poll step (the handle settles rejected only on
exhaustion), which composes with the pause-broker invariants for free: the
broker sees each successfully observed state exactly once, so a retried poll
can never double-prompt or double-resume.

### Devtools event vocabulary

With a `devtools` sink configured, a2aq narrates itself in compact,
JSON-serializable events (no live objects; task states as enum names):

| Event | Meaning |
|---|---|
| `a2a:send` | a message landed (initial send or paused-task resume) — carries the messageId |
| `a2a:task-status` | an observed task changed state (change-detected, not per-poll) |
| `a2a:artifact` | a new artifact appeared on an observed task |
| `a2a:gate` | the broker resolved a pause gate (`kind` input/auth, `outcome` approve/deny) |
| `a2a:card-refresh` | the agent card was refetched from the wire |
| `a2a:push` | a pushed (webhook) event was folded into the cache |
| `a2a:stream` | a stream lifecycle edge (open / resubscribe / drop / fallback) |
| `a2a:status` | connectivity changed (mirrors the StatusStore) |
| `a2a:wire` | a wire exchange summary (opt-in `devtoolsWire`) |

The emission points are deliberately the *change* points — the same edges the
cache's structural sharing and the broker's entry-tracking already compute —
so a timeline reads as a causal story, not a poll log.

The wire log is the exception, and that is why it is opt-in: it narrates
*traffic*, not change (a poll log is exactly what it is). a2aq's wire surface
is an injected `fetch`, not a `send`/`onmessage` transport, so the core's
`instrumentTransport` does not apply — `tapFetch` is the fetch-shaped analog,
emitting per-direction summaries (method, taskId, sizes, status, SSE flag,
error). Bodies are never dumped and SSE bodies never consumed: the tap must be
safe to leave on against a live stream. One hub carries both altitudes, so the
core's `<AgentQueryDevtools>` panel shows intent (task events) and traffic
(wire) on one timeline.

## Family rules

a2aq honors the cross-cutting contracts in the core's
[design doc — Family rules](https://github.com/johnhenry/agent-query-core/blob/main/docs/design.md#family-rules).
The load-bearing one is **reconcile on stream resume**: a stream is an
optimization over periodic relisting, never a replacement — after any resume,
do a full read and reconcile the cache. In poll mode reconciliation is
inherent — **every poll IS a full read** of the task, and the cache reconverges
to server truth each cycle by construction. In stream mode a2aq implements the
rule literally: every `resubscribeTask` is bracketed by full `getTask` reads —
one *before* attaching (the task may have settled during the gap; servers
reject resubscription to terminal tasks) and one *after* (never assume the gap
was empty), and a stream that ends gracefully without a terminal state
reconciles before resubscribing. An out-of-band transition the stream never
delivered — a task completed while no subscriber was attached — is caught by
reconcile, not lost.

## The React subpath

`@johnhenry/a2aq/react` is deliberately thin: every hook is a *view* over
state the store already maintains, never a second source of truth. The
core's `useSyncExternalStore` bindings do the subscription work (version
counters, canonical key identity), and the a2aq layer only adds the A2A
vocabulary: `useAgentCard` reads the card entry and refetches on staleness;
`useTask`/`useTaskStatus`/`useTaskArtifacts` read the task/artifact entries;
`usePendingInput` filters the broker queue to the two paused-state kinds and
types the resolver over `InputDecision`.

Two deliberate choices:

- **A `TaskRef` is either a handle or a name.** Handed a `TaskHandle`, the
  hook starts the handle's driver loop on mount — the component IS the
  observer, no `result()`/`subscribe()` call needed. Handed
  `{ agent, taskId }`, the hook observes the cache only; this is the
  disconnected-viewer shape (webhook-fed dashboards, secondary components)
  where some other driver owns the wire traffic.
- **React is an optional peer.** The root entrypoint never imports it; only
  the `/react` subpath does. Non-React consumers keep a react-free module
  graph, and the hooks live in the same package so they can never drift from
  the store's semantics.

## Pushes are hints; reads are truth

The webhook adapter extends the reconcile rule to a third driver. Poll,
stream, push — three transports, ONE application step: everything funnels
into the same task snapshot + artifact mirror writes (`ingestPush` mirrors
the stream driver's fold exactly: status over the snapshot with artifacts
reassembled from their entries; artifact chunks merged against the mirror
entry). What pushes add is a delivery channel a2aq doesn't control: HTTP
POSTs with no ordering guarantee, retried by senders, dropped by networks.
So the handler treats every push as a *hint* — fold it for latency, then do
a full `getTask` and let server truth win. The out-of-order case (a stale
`WORKING` landing after `COMPLETED`) is the canonical test: the fold briefly
regresses the snapshot, the reconcile immediately heals it, and subscribers
see truth.

Two boundary decisions worth noting. The handler is `(Request) => Response`
over web standards rather than an Express/Hono/Node binding — the narrowest
interface every runtime already speaks, so a2aq takes no server-framework
dependency for one endpoint. And in-process testing swaps the SDK sender's
*transport*, not its *payloads*: the mock's push path reuses the SDK's own
`V1PushNotificationSerializer`, so what the tests parse is byte-for-byte
what a production `DefaultPushNotificationSender` would POST (its only
unmockable choice is dispatching via global fetch).

## Skill codegen: honest about what the card declares

The mcpq codegen pattern — machine-readable capability descriptions become
typed client code — meets a protocol reality in A2A: `AgentSkill` is
*discovery* data (id, name, description, tags, examples, media modes), not a
parameter schema. There is nothing to derive typed params from, and Messages
carry no first-class skill field. Pretending otherwise (inventing schemas
from examples, or emitting `any`-typed param bags) would manufacture a type
safety the wire doesn't have.

So the generated unit is shaped by what IS there. Per skill: a
`sendX(q, agent, input: SkillInput, opts?)` helper (`SkillInput` =
`string | Part[]` — text for the common case, Parts when `inputModes` wants
files or data) that tags the skill id into message metadata under
`"a2aq/skillId"`, and — behind `--hooks`, per the orval / connect-query
precedent that developers want the *hook* as the generated unit — a
`useX(q, agent)` wrapper over `useSkillTask`. The card's modes and examples
land in JSDoc, where a schema would otherwise inform the types; the
generated header restates the limitation. Should a future A2A revision (or
an extension) add parameter schemas to skills, typed params slot into this
same surface without breaking it.

Everything generated is a thin wrapper over exported runtime
(`sendSkill`, `useSkillTask`) — the generator emits *names*, not logic, so
generated modules never drift from library semantics and golden-file tests
stay trivial.

## Positioning: A2A vs AG-UI / A2UI

Adjacent protocols answer different questions:

- **A2A** — agent ↔ agent (and app ↔ agent) *task* protocol: send work,
  observe lifecycle, resume pauses. No opinion about rendering.
- **AG-UI** — agent ↔ *frontend* event-stream protocol: token streams, state
  patches, generative-UI events for chat-shaped surfaces.
- **A2UI** — agents *describe UI* declaratively for a host app to render.

a2aq deliberately stays on the A2A side of that line: it makes task state and
pauses **available to any UI** (cache snapshots, subscriptions, an approval
queue) without prescribing one. If you are building a chat surface that renders
an agent's stream, AG-UI/A2UI address that; if you are embedding agent *work* —
tasks, approvals, dashboards — into an existing product, that is a2aq's lane.
The mcp-query analog of this argument (non-agentic apps as first-class protocol
consumers) is developed at length in its
[design doc](https://github.com/johnhenry/mcp-query).

## The mock is the SDK's own server

`MockA2AAgent` is not a stub of a2aq — it is the SDK's `DefaultRequestHandler`
+ `JsonRpcTransportHandler` + `InMemoryTaskStore` served through an injected
`fetch`. Tests and examples exercise the real wire codec, the real first-event
rules, the real task store — with no sockets and no timers beyond the poll
cadence. `callLog` proves what hit the wire; `setTaskState()` drives the state
transitions (leave/re-enter a pause) that transition-sensitive logic must be
tested against.

Streaming requests (`Accept: text/event-stream`) get a REAL SSE response — one
JSON-RPC envelope per `data:` event, flushed as the server's own async
generator yields, so the SDK client's SSE parser runs for real. The generator
is pumped eagerly and keeps draining (persisting execution events to the task
store) after a client disconnect, because a real agent does not stop executing
when a subscriber goes away. `droppingStreamFetchImpl` sabotages exactly that
seam: streams that die mid-flight, resubscribes that fail at connect — the
partial failures the drop → resubscribe → poll-fallback ladder must survive.
