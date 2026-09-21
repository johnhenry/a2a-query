# Examples — granular → complex

A progression: each step adds one capability. Every example is **runnable** with no
network and no transport — the agent side is the SDK's own server stack
(`DefaultRequestHandler` + `JsonRpcTransportHandler` + `InMemoryTaskStore`) behind an
in-process `fetch`, connected straight to `A2AQuery` over the real wire. Run any with
`npx tsx examples/<file>` (or `npm run example:NN`).

| # | File | Adds | Run |
|---|------|------|-----|
| 01 | [`01-hello-task.ts`](./01-hello-task.ts) | smallest useful program: send a message → `TaskHandle` → await result → print artifact text | `npm run example:01` |
| 02 | [`02-live-status.ts`](./02-live-status.ts) | `subscribe()` to a task's cache entry, printing each status transition as the poll loop observes it | `npm run example:02` |
| 03 | [`03-approval-inbox.ts`](./03-approval-inbox.ts) | human-in-the-loop: `INPUT_REQUIRED` pause → `InteractionBroker` queue → simulated human approval → resume → audit trail | `npm run example:03` |
| 04 | [`04-manual-resume.ts`](./04-manual-resume.ts) | no broker: app watches the cached snapshot itself, notices the pause, resumes with `handle.respond()` | `npm run example:04` |
| 05 | [`05-multi-agent.ts`](./05-multi-agent.ts) | one `A2AQuery` over several agents, tasks in flight on both, a mini dashboard rendered purely from cache snapshots | `npm run example:05` |
| 06 | [`06-policy-autopilot.ts`](./06-policy-autopilot.ts) | broker trust policy decides without a human: "allow" auto-approves, "deny" auto-blocks | `npm run example:06` |
| 07 | [`07-devtools-and-resilience.ts`](./07-devtools-and-resilience.ts) | flaky network + retry policy + live connectivity status + devtools timeline of everything that happened | `npm run example:07` |
| 08 | [`08-streaming.ts`](./08-streaming.ts) | SSE-driven handle via `sendMessageStream`/`resubscribeTask`: mid-stream drop → degraded → resubscribe (+ family-rule reconcile) → poll fallback | `npm run example:08` |
| 09 | [`09-artifact-store.ts`](./09-artifact-store.ts) | artifacts under their own cache keys, individually readable/subscribable/evictable, with `detachArtifacts` keeping task snapshots lean | `npm run example:09` |
| 10 | [`10-wire-log.ts`](./10-wire-log.ts) | `devtoolsWire: true` taps the injected fetch, emitting wire summaries into the same `DevtoolsHub` timeline as task-level events | `npm run example:10` |
| 11 | [`11-skill-codegen.ts`](./11-skill-codegen.ts) | an `AgentCard`'s skills turned into a typed invocation module: framework-free `sendX` helpers plus `useX` hooks | `npm run example:11` |
| 12 | [`12-push-webhook.ts`](./12-push-webhook.ts) | disconnected-client story: register a webhook instead of polling, `createWebhookHandler` folds pushed updates into the same cache | `npm run example:12` |
| 13 | [`13-x402-autopilot.ts`](./13-x402-autopilot.ts) | the same `InteractionBroker`/policy pattern as 06, applied to x402 (HTTP 402) payment challenges | `npm run example:13` |

To point any of these at a **real** agent, replace the in-process mock server stack
with a live endpoint URL — everything else is identical; that's the point.
