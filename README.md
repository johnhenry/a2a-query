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

Status: post-1.0 A2A, `@a2a-js/sdk@1.0.0` pinned exact. Streaming
(`sendMessageStream`/`resubscribeTask`) is in. Webhook push notifications,
skill codegen, and React hooks are tracked in the issues. Part of the
[agent-query family](https://github.com/johnhenry/agent-query-core): shared engine in
`@johnhenry/agent-query-core`; siblings `@johnhenry/mcpq` (MCP) and `acpq` (ACP, planned).

MIT
