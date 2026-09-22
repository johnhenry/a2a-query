# @johnhenry/a2a-query — a2a-query

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fa2a-query.svg)](https://www.npmjs.com/package/@johnhenry/a2a-query)
[![CI](https://github.com/johnhenry/a2a-query/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/a2a-query/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fa2a-query.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/agent-query/a2a-query](https://opensource.johnhenry.me/agent-query/a2a-query/)

**A reactive, cached, embeddable A2A client for non-agentic applications.**

The official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) gives you transports,
wire codecs, and a single-endpoint `Client`. `a2a-query` adds the stratum apps need on top —
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
- **In-process mock agent** (`@johnhenry/a2a-query/testing`) — the SDK's own server stack
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
- **React hooks** (`@johnhenry/a2a-query/react`, React an optional peer) — `useAgentCard`,
  `useTask`/`useTaskStatus`/`useTaskArtifacts`, `usePendingInput`, `useSkillTask`, plus
  the re-exported core hooks (`useAuditLog`, `usePeerStatus`, `useCacheEntry`, …).
- **Skill codegen** — the `a2a-query-codegen` CLI (and `generateSkillModule`) turn an
  `AgentCard`'s skills into a typed `sendX(...)` module, with `useX(...)` hooks via `--hooks`.
- **Webhook push adapter** — `createWebhookHandler` turns an agent's push notifications
  into the same cache folds the poll/stream drivers write, followed by a reconcile read.

```ts
import { A2AQuery, InteractionBroker } from "@johnhenry/a2a-query";

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

## Contents

- [Install](#install)
- [Demo](#demo)
- [Docs & examples](#docs--examples)
- [Supported protocol versions](#supported-protocol-versions)
- [Security model](#security-model)
- [Family](#family)

## Install

```bash
npm install @johnhenry/a2a-query
```

Previously published as `@johnhenry/a2aq`; the version line restarted at
`0.0.0` on the 2026-08 rename to this npm scope (see
[CHANGELOG.md](./CHANGELOG.md)).

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
- **[docs/design.md](./docs/design.md)** — how a2a-query maps A2A onto the shared
  agent-query core: keys/tags vocabulary, the task-handle lifecycle state machine
  (incl. paused-state broker mechanics), what the SDK provides vs what a2a-query adds,
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
| `npm run example:11` | Skill codegen — `AgentCard` skills → typed `sendX`/`useX` module (`a2a-query-codegen --hooks`) |
| `npm run example:12` | Push webhook — `createWebhookHandler`: a receiver driven entirely by pushes, never polls or sends |

## Supported protocol versions

`a2a-query` is built on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js),
pinned as an **exact** peer dependency — `"@a2a-js/sdk": "1.0.1"` in
[`package.json`](./package.json), not a caret or range. That's the source of
truth for what this package supports; treat any other version claim as
secondary to it. The pin is exact (rather than `^1.0.1`) because the SDK only
just reached its 1.0 general-availability release and its surface may still
shift before it settles — a caret range could silently pull in a breaking
minor before a2a-query has verified against it.

An A2A `AgentCard`'s `supportedInterfaces` array declares, per interface, the
protocol version that interface speaks (`AgentInterface.protocolVersion`,
e.g. `"1.0"` or, for peers still on the older wire format, `"0.3"`). `a2a-query`
talks to any agent whose advertised interfaces include a version the
underlying `@a2a-js/sdk` build can speak — but **a2a-query itself does not
negotiate or select protocol versions**. That matching/negotiation is the
SDK's (and the agent's) responsibility, not a2a-query's; a2a-query simply hands the SDK
client the interface URL and lets it drive the wire.

Concretely, this means:

- **No pre-1.0 / legacy A2A dialects.** The underlying SDK build a2a-query is
  pinned to is 1.0-only from a2a-query's side; interoperating with a `"0.3"`-only
  peer requires the SDK's own opt-in v0.3 compatibility layer, which a2a-query
  does not configure or expose.
- **Version compatibility is the SDK's job.** If an agent's card advertises
  only protocol versions the pinned SDK build can't speak, that's a
  client/agent mismatch a2a-query surfaces (as a connection/transport failure),
  not one it resolves.
- This section is intentionally scoped to what the SDK pin and its shipped
  types confirm (see [`node_modules/@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)
  for the authoritative `AgentCard`/`AgentInterface` shapes) rather than
  asserting spec release dates that couldn't be independently verified from
  this environment.

## Security model

`a2a-query` sits on three real trust boundaries: an inbound webhook that
accepts pushes from the outside network (`createWebhookHandler`), a broker
that gates whether a paused task may resume (`InteractionBroker`), and an
opt-in autopilot for HTTP 402 payment challenges (`x402Interceptor`). None of
these make a2a-query a security sandbox for untrusted agent code — it
mediates *who may push data in* and *who may approve a resume or a payment*,
not what an agent itself is allowed to do.

**What a2a-query guarantees:**

- **A webhook with a configured token rejects any POST that doesn't present
  it.** `createWebhookHandler` compares `X-A2A-Notification-Token` (or an
  `Authorization: Bearer` header) against `opts.token` and returns `401` on
  any mismatch, before the body is folded into the cache (`src/webhook.ts`).
- **A pushed update is never treated as authoritative on its own.** By
  default (`reconcile !== false`), every accepted push is followed by a full
  `getTask` read before anything downstream can rely on it — pushes can
  arrive out of order, duplicated, or with gaps, so the fold is provisional
  until reconciled (`src/webhook.ts`, family reconcile rule).
- **A paused task (`INPUT_REQUIRED` / `AUTH_REQUIRED`) can only resume
  through the broker's `gate()`, and at most once per handle at a time.** A
  single-flight guard (`brokerInflight`) prevents a second prompt while one
  is outstanding, and the broker is re-prompted only on an actual transition
  into a new paused state, not on every poll (`src/client.ts`, the
  `brokerInflight` guard).
- **The devtools wire tap never captures request or response bodies.**
  `tapFetch` emits only method, ids, byte counts, and HTTP status; streamed
  (SSE) response bodies are never read by the tap at all — verified directly
  against `src/wire.ts`, not just repeated from prose.
- **An x402 retry is bounded to one attempt, and only for idempotent
  operations.** `x402Interceptor` retries the original request at most once
  (`op.state.x402Retried`) and only after `op.state.idempotent === true`;
  anything else throws `X402ChallengeError` instead of retrying silently
  (`src/x402Interceptor.ts`).

**What is still yours:**

- **An unconfigured webhook token means no auth check at all.** `token` is
  optional; if you omit it, `createWebhookHandler` accepts any POST that
  parses as a valid push. The source comment is explicit that this is
  in-process/testing-only — deploying a webhook without a token is your
  mistake, not a mode a2a-query defends against.
- **The x402 autopilot never touches money.** `x402Interceptor` is
  verification/simulation only: approving a challenge marks it resolved in
  the broker and retries the request once — it never signs a payment,
  attaches a real payment proof, or holds any key custody. Wiring an actual
  payment rail (and deciding what "approve" should cost) is entirely your
  own code, driven through the `policy` function you pass to the broker.
- **The broker's correctness is whatever `policy` you inject.** A `policy`
  that returns `"allow"` unconditionally auto-clears every `INPUT_REQUIRED`,
  `AUTH_REQUIRED`, and x402 pause with no human in the loop — a2a-query
  enforces that *something* gates the resume, not that the gate is
  meaningful.
- **A failed reconcile doesn't fail the webhook receipt.** If the post-push
  `getTask` read throws, the push is still acknowledged `200`; the
  `StatusStore` carries the degradation, but nothing forces a caller to be
  watching it. We found no open GitHub issue tracking this specific gap at
  the time of writing — treat it as a documented caveat, not a promise of a
  future fix.

## Family

| Protocol | Library | Status |
|---|---|---|
| MCP | [`@johnhenry/mcp-query`](https://github.com/johnhenry/mcp-query) | published — sibling, shares `@johnhenry/agent-query-core` |
| ACP | `@johnhenry/acp-query` | published — sibling, shares `@johnhenry/agent-query-core` |
| — | [`@johnhenry/agent-query-core`](https://github.com/johnhenry/agent-query-core) | published — the shared cache/broker/interceptor engine underneath a2a-query |

MIT
