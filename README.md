# @johnhenry/a2aq — a2a-query

**A reactive, cached, embeddable A2A client for non-agentic applications.**

The official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) gives you transports,
wire codecs, and a single-endpoint `Client`. `a2aq` adds the stratum apps need on top —
the [TanStack-Query-of-A2A](https://github.com/johnhenry/mcp-query) move:

- **Multi-agent registry/router** — one `A2AQuery` over many agents; cards resolved and
  cached (`card(agent)`), SDK clients memoized per endpoint.
- **Task-handle store** — `sendMessage()` returns a poll-driven `TaskHandle` whose
  snapshots land in a reactive cache (`task()`, `subscribe()`, `result()`), so
  dashboards observe live task state without hand-rolling loops.
- **Approval broker for paused tasks** — A2A's `INPUT_REQUIRED` / `AUTH_REQUIRED` are
  first-class human-in-the-loop resume points; they route through the shared
  [`InteractionBroker`](https://github.com/johnhenry/agent-query-core) (policy
  allow/deny/ask, pending queue for UI binding, audit trail), and an approved decision's
  message resumes the task (`respond()`).
- **In-process mock agent** (`@johnhenry/a2aq/testing`) — the SDK's own server stack
  (`DefaultRequestHandler` + `JsonRpcTransportHandler` + `InMemoryTaskStore`) behind an
  injected `fetch`: tests exercise the real wire with no sockets.
- **Streaming** — `sendMessageStream`/`resubscribeTask` drive the handle over SSE, with
  drop → `degraded` → resubscribe (retried) → poll-fallback handled for you, and the
  family-rule `getTask` reconcile after every reattach.
- **Artifact accessors** — artifact-kind cache entries, reactive chunk reads
  (`partText`/`artifactText`/`artifactsText`), and `detachArtifacts` for eviction control.
- **Devtools wire tap** — `tapFetch` + `devtoolsWire` summarize every JSON-RPC exchange
  (method, ids, sizes, status — never bodies) into the same devtools timeline as task
  events; pairs with `AgentQueryDevtools` for a drop-in panel.
- **React hooks** (`@johnhenry/a2aq/react`, React an optional peer) — `useAgentCard`,
  `useTask`/`useTaskStatus`/`useTaskArtifacts`, `usePendingInput`, `useSkillTask`, plus
  the re-exported core hooks (`useAuditLog`, `usePeerStatus`, `useCacheEntry`, …).
- **Skill codegen** — the `a2aq-codegen` CLI (and `generateSkillModule`) turn an
  `AgentCard`'s skills into a typed `sendX(...)` module, with `useX(...)` hooks via `--hooks`.
- **Webhook push adapter** — `createWebhookHandler` turns an agent's push notifications
  into the same cache folds the poll/stream drivers write, followed by a reconcile read.

```ts
import { A2AQuery, InteractionBroker } from "@johnhenry/a2aq";

const broker = new InteractionBroker({ policy: () => "ask" });
const q = new A2AQuery({
  agents: { travel: { url: "https://agents.example.com/travel" } },
  interactions: broker,
});

const handle = await q.sendMessage("travel", myMessage);
if (typeof handle === "object" && "result" in handle) {
  // broker.list() surfaces INPUT_REQUIRED pauses to your approval inbox;
  // broker.resolve(id, { action: "approve", message }) resumes the task.
  const task = await handle.result();
}
```

## Install

```bash
npm install @johnhenry/a2aq@rc
```

The npm `latest` dist-tag is currently stuck at this package's first-ever
publish (`0.1.0-rc.1`) — well behind the current release. Install with the
`@rc` tag to get the current version (`0.1.0-rc.4` as of this writing).

## Demo

**[demo/](./demo)** — the flagship demo: a multi-agent task dashboard with an
approval inbox, running entirely in-browser against four in-process mock A2A
agents (streaming researcher, `INPUT_REQUIRED` deployer, `AUTH_REQUIRED`
billing, flaky-network runner). Fleet connectivity chips, a live task board,
approve/deny with free-text respond, audit trail, and the devtools panel with
the `a2a:wire` log.

```bash
npm run demo:dev   # or: cd demo && npm install && npm run dev
```

## Docs & examples

- **[docs/api.md](./docs/api.md)** — every export, with an example.
- **[docs/design.md](./docs/design.md)** — how a2aq maps A2A onto the shared
  agent-query core: keys/tags vocabulary, the task-handle lifecycle state machine
  (incl. paused-state broker mechanics), what the SDK provides vs what a2aq adds,
  positioning vs AG-UI/A2UI.
- **[examples/](./examples)** — graded, runnable, no network (in-process mock agent):

| Run | Shows |
|---|---|
| `npm run example:01` | Hello task — send → handle → `result()`, print the artifact |
| `npm run example:02` | Live status — `subscribe()` prints each status transition |
| `npm run example:03` | Approval inbox — broker `list()`/`resolve()` + audit trail |
| `npm run example:04` | Manual resume — no broker: observe the pause, `respond()` |
| `npm run example:05` | Multi-agent — tasks in flight on two agents, cache-snapshot dashboard |
| `npm run example:06` | Policy autopilot — `allow` auto-clears, `deny` blocks (task stays parked) |
| `npm run example:07` | Devtools & resilience — flaky network + retry policy, status transitions, event timeline |
| `npm run example:08` | Streaming — SSE-driven handle, mid-stream drop → degraded → resubscribe (+ family-rule reconcile) → poll fallback |
| `npm run example:09` | Artifact store — artifact-kind cache entries, reactive chunk reads, `detachArtifacts`, eviction |
| `npm run example:10` | Wire log — `devtoolsWire` fetch tap: unified timeline of task events + wire traffic |
| `npm run example:11` | Skill codegen — `AgentCard` skills → typed `sendX`/`useX` module (`a2aq-codegen --hooks`) |
| `npm run example:12` | Push webhook — `createWebhookHandler`: a receiver driven entirely by pushes, never polls or sends |

## Supported protocol versions

`a2aq` is built on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js),
pinned as an **exact** peer dependency — `"@a2a-js/sdk": "1.0.0"` in
[`package.json`](./package.json), not a caret or range. That's the source of
truth for what this package supports; treat any other version claim as
secondary to it. The pin is exact (rather than `^1.0.0`) because the SDK only
just reached its 1.0 general-availability release and its surface may still
shift before it settles — a caret range could silently pull in a breaking
minor before a2aq has verified against it.

An A2A `AgentCard`'s `supportedInterfaces` array declares, per interface, the
protocol version that interface speaks (`AgentInterface.protocolVersion`,
e.g. `"1.0"` or, for peers still on the older wire format, `"0.3"`). `a2aq`
talks to any agent whose advertised interfaces include a version the
underlying `@a2a-js/sdk` build can speak — but **a2aq itself does not
negotiate or select protocol versions**. That matching/negotiation is the
SDK's (and the agent's) responsibility, not a2aq's; a2aq simply hands the SDK
client the interface URL and lets it drive the wire.

Concretely, this means:

- **No pre-1.0 / legacy A2A dialects.** The underlying SDK build a2aq is
  pinned to is 1.0-only from a2aq's side; interoperating with a `"0.3"`-only
  peer requires the SDK's own opt-in v0.3 compatibility layer, which a2aq
  does not configure or expose.
- **Version compatibility is the SDK's job.** If an agent's card advertises
  only protocol versions the pinned SDK build can't speak, that's a
  client/agent mismatch a2aq surfaces (as a connection/transport failure),
  not one it resolves.
- This section is intentionally scoped to what the SDK pin and its shipped
  types confirm (see [`node_modules/@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)
  for the authoritative `AgentCard`/`AgentInterface` shapes) rather than
  asserting spec release dates that couldn't be independently verified from
  this environment.

Part of the [agent-query family](https://github.com/johnhenry/agent-query-core):
shared engine in `@johnhenry/agent-query-core`; siblings
[`@johnhenry/mcpq`](https://github.com/johnhenry/mcp-query) (MCP) and
`@johnhenry/acpq` (ACP).

MIT
