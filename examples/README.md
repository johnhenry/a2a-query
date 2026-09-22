# a2a-query examples

Granular → complex: each step adds one capability. Every example is
**runnable** with no network and no transport — the agent side is the SDK's
own server stack (`DefaultRequestHandler` + `JsonRpcTransportHandler` +
`InMemoryTaskStore`) behind an in-process `fetch`, connected straight to
`A2AQuery` over the real wire. Run any with `npx tsx examples/<file>` (or
`npm run example:NN`).

| # | File | Demonstrates | Run |
|---|------|------|-----|
| 01 | [`01-hello-task.ts`](./01-hello-task.ts) | Smallest useful program: send a message → `TaskHandle` → await result → print artifact text | `npm run example:01` |
| 02 | [`02-live-status.ts`](./02-live-status.ts) | `subscribe()` to a task's cache entry prints each status transition as the poll loop observes it | `npm run example:02` |
| 03 | [`03-approval-inbox.ts`](./03-approval-inbox.ts) | An `INPUT_REQUIRED` pause routes through the `InteractionBroker` queue, is not auto-resolved, and only resumes after a simulated human approval, with an audit trail left behind | `npm run example:03` |
| 04 | [`04-manual-resume.ts`](./04-manual-resume.ts) | Without a broker, an app can watch the cached snapshot itself, notice the pause, and resume with `handle.respond()` directly | `npm run example:04` |
| 05 | [`05-multi-agent.ts`](./05-multi-agent.ts) | One `A2AQuery` instance drives tasks in flight on two agents at once; a mini dashboard renders purely from cache snapshots, no manual bookkeeping | `npm run example:05` |
| 06 | [`06-policy-autopilot.ts`](./06-policy-autopilot.ts) | A broker trust policy decides without a human: `"allow"` auto-approves a pause, `"deny"` auto-blocks it (the task stays parked) | `npm run example:06` |
| 07 | [`07-devtools-and-resilience.ts`](./07-devtools-and-resilience.ts) | A flaky network under a retry policy still converges: connectivity status flips `degraded` → `ready`, and the devtools timeline records every attempt | `npm run example:07` |
| 08 | [`08-streaming.ts`](./08-streaming.ts) | An SSE-driven handle (`sendMessageStream`/`resubscribeTask`) survives a mid-stream drop: `degraded` → resubscribe → family-rule reconcile → poll fallback, in that order | `npm run example:08` |
| 09 | [`09-artifact-store.ts`](./09-artifact-store.ts) | Artifacts live under their own cache keys — individually readable, subscribable, and evictable via `detachArtifacts` — without bloating the task snapshot | `npm run example:09` |
| 10 | [`10-wire-log.ts`](./10-wire-log.ts) | `devtoolsWire: true` taps the injected fetch and emits wire summaries into the same `DevtoolsHub` timeline as task-level events, with bodies never included | `npm run example:10` |
| 11 | [`11-skill-codegen.ts`](./11-skill-codegen.ts) | An `AgentCard`'s skills turn into a typed invocation module: framework-free `sendX` helpers plus `useX` hooks, generated, not hand-written | `npm run example:11` |
| 12 | [`12-push-webhook.ts`](./12-push-webhook.ts) | A receiver driven entirely by pushes: `createWebhookHandler` folds pushed updates into the same cache the poll/stream drivers write, never polling or sending itself | `npm run example:12` |
| 13 | [`13-x402-autopilot.ts`](./13-x402-autopilot.ts) | The same `InteractionBroker`/policy pattern as 06, applied to x402 (HTTP 402) payment challenges — the interceptor retries once and only simulates payment, it never signs or moves money | `npm run example:13` |

To point any of these at a **real** agent, replace the in-process mock server stack
with a live endpoint URL — everything else is identical; that's the point.
