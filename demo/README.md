# a2aq demo — multi-agent task dashboard / approval inbox

The flagship demo for [`@johnhenry/a2aq`](..): a dashboard that watches a
fleet of A2A agents, tracks their long-lived tasks live, and — the wedge —
routes every `INPUT_REQUIRED` / `AUTH_REQUIRED` pause into a human **approval
inbox** whose decisions visibly resume the tasks. This is the app-side use
case neither the A2A SDK (protocol plumbing) nor AG-UI/A2UI (agent-rendered
UI) serves: *your* app, observing and gating *their* agents.

Everything runs **in the browser** — the four "agents" are in-process
`MockA2AAgent`s running the SDK's real server stack (JSON-RPC codec, real SSE
responses) behind injected `fetch` implementations. No server, no sockets.

## Run it

```bash
cd demo
npm install
npm run dev        # builds the parent lib first, then serves on http://localhost:5173
```

Or from the repo root: `npm run demo:dev`. Production build: `npm run build`
(root: `npm run demo:build`). Smoke test (happy-dom, mounts the real app and
walks the approval flow): `npm test`.

## The fleet

| Agent | Behavior | What it showcases |
|---|---|---|
| `researcher` (atlas-researcher) | Streams a report as artifact `append` chunks over real SSE | Streaming driver, progressive `useTaskArtifacts` |
| `deployer` (deploy-bot) | Pauses `INPUT_REQUIRED` for a go/no-go | The approval inbox, broker gating, resume-on-approve |
| `billing` (ledger-billing) | Pauses `AUTH_REQUIRED` until credentials arrive | Auth gating as a distinct inbox kind |
| `flaky-runner` (gremlin-runner) | The network drops the **first delivery of every message** | Retry policy + fixed-messageId idempotency, `degraded` → `ready` chips |

## The panes

- **Agent fleet** (left) — `useAgentCard` cards + live connectivity chips via
  `usePeerStatus` (watch `flaky-runner` flick to `degraded · retry #1` and
  recover).
- **Task board / detail** (center) — launched tasks bucketed by live state
  (`useTaskStatus`); click one for a devtools-event timeline (sends, state
  changes, gates, stream edges) and its artifacts, streamed chunks included.
- **Approval inbox + audit trail** (right) — `usePendingInput` pending queue
  with approve (free-text respond) / deny, `useAuditLog` decision history.
- **a2aq devtools** (bottom) — the core `<AgentQueryDevtools>` panel over the
  shared `DevtoolsHub`, including the `a2a:wire` fetch log
  (`devtoolsWire: true`), the cache, the broker queue, and the status store.

## A screenshot-worthy walkthrough (the approval flow)

1. Click **Deploy (approval)**. `deploy-bot` accepts the task, works briefly,
   then pauses — the board card moves to **Needs a human** and the approval
   inbox shows an `input-required` item with the agent's prompt.
2. Read the prompt, tweak the pre-filled free-text answer if you like, and hit
   **approve**. The reply is sent as the resume message (same retried,
   idempotent send path as any other message); the task transitions back to
   working and lands in **Completed**, its artifact echoing your answer.
3. Check the **audit trail**: the approval is recorded with peer, kind, and
   outcome. Try **Billing (auth)** next — same flow, `auth-required` kind,
   credentials as the free-text respond. Deny one, too: the task stays parked
   (deny sends nothing), and the denial is audited.
4. For the full spectacle press **Fan-out burst**, then open the devtools
   panel and watch the unified timeline: wire summaries, SSE stream `open`,
   artifact chunks, gate resolutions, retries.

## How it consumes the library

The demo depends on the parent via `"@johnhenry/a2aq": "file:.."` and imports
only the public surface: the root entrypoint, `@johnhenry/a2aq/react` hooks,
and `@johnhenry/a2aq/testing` mocks. `npm run dev`/`build`/`test` first build
the parent (`pre*` scripts), so a fresh clone works with just
`npm install && npm run dev`. It is private and never published.
