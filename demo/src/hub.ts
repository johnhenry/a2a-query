// The demo's shared hub: four themed in-process mock A2A agents behind one
// A2AQuery instance — no server, no sockets. Each mock runs the SDK's REAL
// server stack (DefaultRequestHandler + JsonRpcTransportHandler) behind an
// injected fetch, so everything on screen exercised the actual wire codec.

import {
  A2AQuery,
  DevtoolsHub,
  InteractionBroker,
  type A2ADevtoolsEvent,
  type InputDecision,
} from "@johnhenry/a2aq";
import {
  MockA2AAgent,
  askAuthThenEchoExecutor,
  askThenEchoExecutor,
  echoExecutor,
  pacedStreamingExecutor,
} from "@johnhenry/a2aq/testing";
import type { AgentCard, Message } from "@a2a-js/sdk";

/** Build a user text Message in the SDK's ts-proto shape. */
export const msg = (text: string): Message =>
  ({
    messageId: `m-${crypto.randomUUID()}`,
    role: "user",
    parts: [{ content: { $case: "text", value: text } }],
  }) as never;

const card = (c: {
  description: string;
  streaming?: boolean;
  skills?: Array<{ id: string; name: string; description: string; tags?: string[] }>;
}): Partial<AgentCard> =>
  ({
    description: c.description,
    capabilities: { streaming: c.streaming ?? false },
    skills: (c.skills ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
      examples: [],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    })),
  }) as never;

// ── the fleet ────────────────────────────────────────────────────────────────

/** Streams a research report progressively — SSE driver, artifact `append` chunks. */
export const researcherMock = new MockA2AAgent(
  pacedStreamingExecutor({
    stepMs: 900,
    chunks: [
      "## Field report: agent-to-agent protocols\n\n",
      "1. A2A tasks are long-lived and pausable — the client is a STATE observer, not an RPC caller.\n",
      "2. INPUT_REQUIRED / AUTH_REQUIRED are first-class states, so approval belongs in the client.\n",
      "3. Streaming and polling must converge on the same snapshot (reconcile on resume).\n\n",
      "Conclusion: the app-side gap is a reactive task store with a human-in-the-loop broker.\n",
    ],
  }),
  {
    name: "atlas-researcher",
    url: "http://researcher.mock/a2a",
    card: card({
      description: "Deep-research agent — streams findings as artifact chunks over SSE.",
      streaming: true,
      skills: [{ id: "research", name: "Deep research", description: "Survey a topic, stream a report.", tags: ["research"] }],
    }),
  },
);

/** Pauses INPUT_REQUIRED before acting — the approval-inbox star. */
export const deployerMock = new MockA2AAgent(askThenEchoExecutor(), {
  name: "deploy-bot",
  url: "http://deployer.mock/a2a",
  card: card({
    description: "Deployment agent — always pauses INPUT_REQUIRED for a human go/no-go.",
    skills: [{ id: "deploy", name: "Deploy release", description: "Ship a release after human approval.", tags: ["ops"] }],
  }),
});

/** Pauses AUTH_REQUIRED — credentials must be supplied by a human. */
export const billingMock = new MockA2AAgent(askAuthThenEchoExecutor(), {
  name: "ledger-billing",
  url: "http://billing.mock/a2a",
  card: card({
    description: "Billing agent — pauses AUTH_REQUIRED until credentials are provided.",
    skills: [{ id: "refund", name: "Issue refund", description: "Refund an invoice (needs auth).", tags: ["finance"] }],
  }),
});

/** A healthy agent behind an unreliable network (see flakyOnce below). */
export const flakyMock = new MockA2AAgent(echoExecutor(), {
  name: "gremlin-runner",
  url: "http://flaky.mock/a2a",
  card: card({
    description: "Job runner behind a flaky network — the FIRST delivery of every message drops.",
    skills: [{ id: "run", name: "Run job", description: "Run a job; the network eats first attempts.", tags: ["ci"] }],
  }),
});

/**
 * Network sabotage for the flaky agent: the first delivery of every
 * SendMessage drops with a network-ish TypeError BEFORE reaching the server.
 * Because a2aq fixes the A2A messageId before the first attempt and reuses it
 * on retries, the retried delivery (same messageId) passes — watch the fleet
 * chip go `degraded` (attempt #1) and recover to `ready`.
 */
const flakyOnce = (mock: MockA2AAgent): typeof fetch => {
  const seen = new Set<string>();
  return async (input, init) => {
    if (init?.method?.toUpperCase() === "POST" && typeof init.body === "string") {
      let body: { method?: string; params?: { message?: { messageId?: string } } } | undefined;
      try {
        body = JSON.parse(init.body) as typeof body;
      } catch {
        body = undefined;
      }
      const mid = body?.method === "SendMessage" ? body.params?.message?.messageId : undefined;
      if (mid && !seen.has(mid)) {
        seen.add(mid);
        throw new TypeError("fetch failed (synthetic flake: first delivery dropped)");
      }
    }
    return mock.fetchImpl(input as never, init);
  };
};

// ── the hub ──────────────────────────────────────────────────────────────────

/** One DevtoolsHub carries both altitudes: task events + the a2a:wire log. */
export const hub = new DevtoolsHub<A2ADevtoolsEvent>();

/** Default policy is "ask" — every pause lands in the approval inbox. */
export const broker = new InteractionBroker<InputDecision>();

export const q = new A2AQuery({
  agents: {
    researcher: { url: researcherMock.url, fetchImpl: researcherMock.fetchImpl },
    deployer: { url: deployerMock.url, fetchImpl: deployerMock.fetchImpl },
    billing: { url: billingMock.url, fetchImpl: billingMock.fetchImpl },
    "flaky-runner": { url: flakyMock.url, fetchImpl: flakyOnce(flakyMock) },
  },
  interactions: broker,
  retry: { retries: 3, baseDelayMs: 400, factor: 2 },
  devtools: hub,
  devtoolsWire: true,
  taskPollMs: 250,
  streaming: "auto",
});

export const AGENTS = q.agents();
