// x402 pay-and-retry interceptor — request -> 402 challenge -> broker.gate() ->
// retry once. Verification/simulation only: never signs or moves money, never
// attaches a real payment proof, no key custody. Reuses the SAME
// InteractionBroker/gate() pattern as the INPUT_REQUIRED/AUTH_REQUIRED approval
// flow (see examples/06-policy-autopilot.ts) — auto-pay-under-ceiling logic
// lives entirely in the caller's own `policy` function passed to their broker,
// not hardcoded here, so this interceptor has no `ceiling`-shaped option.

import type { BaseDecision, InteractionBroker, Operation, RequestInterceptor } from "@johnhenry/agent-query-core";
import type { X402Challenge, X402PaymentRequirement } from "./x402.js";

/** The broker decision shape for an x402 challenge: approve pays (simulated), deny doesn't. */
export interface X402Decision extends BaseDecision {
  /** The payment requirement the app chose to satisfy (usually `challenge.accepts[0]`). */
  requirement?: X402PaymentRequirement;
}

export interface X402InterceptorOptions {
  /** Explicit opt-in — required, no implicit default-on. */
  enabled: boolean;
  /** The SAME broker used for INPUT_REQUIRED/AUTH_REQUIRED gives x402 one consistent audit trail. */
  broker: InteractionBroker<X402Decision>;
  /** Bounds the human "ask" wait (broker.gate()'s own contract). Absent ⇒ wait forever. */
  timeoutMs?: number;
  /**
   * Pop (and clear) the most recently captured 402 challenge for a peer. Wired
   * automatically by `A2AQuery` from its internal `x402Fetch` tap; exposed for
   * direct testing or advanced manual composition.
   */
  popChallenge: (peer: string) => X402Challenge | undefined;
}

/** Thrown on an unresolved (or denied) x402 challenge. */
export class X402ChallengeError extends Error {
  constructor(
    readonly challenge: X402Challenge,
    readonly op: Pick<Operation, "kind" | "peer" | "target">,
    readonly nonIdempotent = false,
  ) {
    super(
      nonIdempotent
        ? `x402 payment required for ${op.kind} ${op.peer}/${op.target} — not retried (non-idempotent)`
        : `x402 payment required for ${op.kind} ${op.peer}/${op.target}`,
    );
    this.name = "X402ChallengeError";
  }
}

export function x402Interceptor(opts: X402InterceptorOptions): RequestInterceptor {
  return async (op, next) => {
    if (!opts.enabled) return next(op);
    try {
      return await next(op);
    } catch (err) {
      const challenge = opts.popChallenge(op.peer);
      if (!challenge) throw err;

      const { decision } = await opts.broker.gate("x402-payment", op.peer, { challenge, op }, { timeoutMs: opts.timeoutMs });
      if (decision.action !== "approve") throw new X402ChallengeError(challenge, op);
      if (op.state.idempotent !== true) throw new X402ChallengeError(challenge, op, true);
      if (op.state.x402Retried) throw new X402ChallengeError(challenge, op);

      op.state.x402Retried = true;
      try {
        return await next(op);
      } catch {
        const retryChallenge = opts.popChallenge(op.peer) ?? challenge;
        throw new X402ChallengeError(retryChallenge, op);
      }
    }
  };
}
