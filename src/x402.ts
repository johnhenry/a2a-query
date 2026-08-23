// x402 wire format — the HTTP 402 machine-native payments challenge body. Same
// shape as mcp-query's own src/server/x402.ts (the two repos share the parsing
// logic conceptually, not as a shared package — see the design notes on
// agent-query-core#3 for why a 3rd package isn't warranted yet).

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402Challenge {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  error?: string;
}

function isPaymentRequirement(v: unknown): v is X402PaymentRequirement {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.scheme === "string" && typeof r.network === "string" && typeof r.maxAmountRequired === "string" && typeof r.payTo === "string" && typeof r.asset === "string";
}

/** Parse a 402 response body as an x402 challenge. Returns undefined on any shape mismatch — never throws. */
export function parseX402Challenge(body?: string): X402Challenge | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (typeof p.x402Version !== "number" || !Array.isArray(p.accepts) || !p.accepts.every(isPaymentRequirement)) return undefined;
  return { x402Version: p.x402Version, accepts: p.accepts as X402PaymentRequirement[], ...(typeof p.error === "string" ? { error: p.error } : {}) };
}

/**
 * Wrap a fetch so a genuine 402 response is captured (via `onChallenge`) without
 * consuming or altering the response — a2a-js/sdk's transport throws only a
 * plain `Error` with status/body baked into a message string (no structured
 * `.status`), so detection can't happen at the interceptor's catch the way
 * mcp-query's SdkHttpError-based one does; this fetch-layer tap is the reliable seam.
 * Same transparent pass-through contract as `tapFetch`: same args, same
 * Response object, same rejection.
 */
export function x402Fetch(inner: typeof fetch, onChallenge: (challenge: X402Challenge) => void): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (response.status === 402) {
      const challenge = parseX402Challenge(await response.clone().text().catch(() => undefined));
      if (challenge) onChallenge(challenge);
    }
    return response;
  };
}
