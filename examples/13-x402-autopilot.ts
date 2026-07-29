// 13 · x402 autopilot — the SAME InteractionBroker/policy pattern as 06's
// policy autopilot, applied to x402 (HTTP 402 machine-native) payment
// challenges: "allow" auto-pays (simulated — no real settlement, no key
// custody) and transparently retries; "deny" blocks and the app sees the
// challenge via X402ChallengeError. A verdict of "ask" queues for a human
// exactly like any other broker interaction — resolve() approves or denies.
// Run: npx tsx examples/13-x402-autopilot.ts

import { InteractionBroker, type X402Decision } from "../src/index.js";
import { A2AQuery } from "../src/index.js";
import { X402ChallengeError } from "../src/x402Interceptor.js";
import { MockA2AAgent, echoExecutor } from "../src/testing/mockAgent.js";
import type { Message } from "@a2a-js/sdk";

const msg = (text: string): Message =>
  ({ messageId: `m-${Math.random()}`, role: "user", parts: [{ content: { $case: "text", value: text } }] }) as never;

const CHALLENGE = {
  x402Version: 1,
  accepts: [
    { scheme: "exact", network: "base-sepolia", maxAmountRequired: "50", payTo: "0xabc", asset: "0xusdc" },
  ],
};

/** Serve one fabricated 402 for the first SendMessage, then delegate normally. */
function payWallFetchImpl(mock: MockA2AAgent): typeof fetch {
  let served = false;
  return async (input, init) => {
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const body = isGet ? undefined : (JSON.parse(String(init!.body)) as { method?: string });
    if (!served && body?.method === "SendMessage") {
      served = true;
      return new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } });
    }
    return mock.fetchImpl(input, init);
  };
}

// Policy: pay anything under $1.00 (maxAmountRequired is in the asset's smallest
// unit — here treated as cents for the example); anything larger needs a human.
const CEILING_CENTS = 100;
const broker = new InteractionBroker<X402Decision>({
  policy: ({ payload }) => {
    const amount = Number(((payload as { challenge: typeof CHALLENGE }).challenge.accepts[0]?.maxAmountRequired ?? "0"));
    return amount <= CEILING_CENTS ? "allow" : "ask";
  },
});

// ── under ceiling: auto-paid (simulated) and retried transparently ───────────
const cheapAgent = new MockA2AAgent(echoExecutor(), { name: "cheap-api" });
const qCheap = new A2AQuery({
  agents: { cheap: { url: cheapAgent.url, fetchImpl: payWallFetchImpl(cheapAgent) } },
  x402: { enabled: true, broker },
  taskPollMs: 25,
});
const cheapResult = await qCheap.sendMessage("cheap", msg("give me the cheap thing"));
console.log("cheap request: paid under ceiling, resolved without any app intervention:", "artifacts" in cheapResult ? "(task)" : "(message)");

// ── over ceiling: queued for a human via the SAME broker as input-required/auth ──
const CHALLENGE_EXPENSIVE = { x402Version: 1, accepts: [{ ...CHALLENGE.accepts[0]!, maxAmountRequired: "500000" }] };
function expensivePayWallFetchImpl(mock: MockA2AAgent): typeof fetch {
  let served = false;
  return async (input, init) => {
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const body = isGet ? undefined : (JSON.parse(String(init!.body)) as { method?: string });
    if (!served && body?.method === "SendMessage") {
      served = true;
      return new Response(JSON.stringify(CHALLENGE_EXPENSIVE), { status: 402, headers: { "content-type": "application/json" } });
    }
    return mock.fetchImpl(input, init);
  };
}
const pricyAgent = new MockA2AAgent(echoExecutor(), { name: "pricy-api" });
const qPricy = new A2AQuery({
  agents: { pricy: { url: pricyAgent.url, fetchImpl: expensivePayWallFetchImpl(pricyAgent) } },
  x402: { enabled: true, broker, timeoutMs: 200 },
  taskPollMs: 25,
});
try {
  await qPricy.sendMessage("pricy", msg("give me the expensive thing"));
} catch (err) {
  console.log(
    "pricy request: queued for a human, timed out unresolved →",
    err instanceof X402ChallengeError ? "X402ChallengeError (safe default: denied)" : err,
  );
}

console.log("\naudit:");
for (const e of broker.auditLog()) console.log(`  ${e.peer.padEnd(6)} ${e.type.padEnd(14)} → ${e.outcome}`);
