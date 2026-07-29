import { describe, it, expect, vi } from "vitest";
import { parseX402Challenge, x402Fetch, type X402Challenge } from "../src/x402.js";

const CHALLENGE: X402Challenge = {
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", payTo: "0xabc", asset: "0xdef" }],
};

describe("parseX402Challenge", () => {
  it("parses a well-formed challenge", () => {
    expect(parseX402Challenge(JSON.stringify(CHALLENGE))).toEqual(CHALLENGE);
  });

  it("returns undefined for a non-x402 body", () => {
    expect(parseX402Challenge(JSON.stringify({ message: "unrelated" }))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseX402Challenge("{not json")).toBeUndefined();
  });

  it("returns undefined for undefined/empty body", () => {
    expect(parseX402Challenge(undefined)).toBeUndefined();
    expect(parseX402Challenge("")).toBeUndefined();
  });
});

describe("x402Fetch", () => {
  it("is a transparent pass-through for non-402 responses (same Response, no onChallenge)", async () => {
    const onChallenge = vi.fn();
    const inner = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = x402Fetch(inner, onChallenge);
    const res = await wrapped("http://x.local");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(onChallenge).not.toHaveBeenCalled();
  });

  it("captures a genuine 402 via onChallenge without consuming the response body", async () => {
    const onChallenge = vi.fn();
    const inner = vi.fn(
      async () => new Response(JSON.stringify(CHALLENGE), { status: 402, headers: { "content-type": "application/json" } }),
    );
    const wrapped = x402Fetch(inner, onChallenge);
    const res = await wrapped("http://x.local");
    expect(res.status).toBe(402);
    expect(onChallenge).toHaveBeenCalledWith(CHALLENGE);
    // Body still readable by the caller — cloning inside x402Fetch didn't consume it.
    expect(JSON.parse(await res.text())).toEqual(CHALLENGE);
  });

  it("does not call onChallenge for a 402 body that isn't x402-shaped", async () => {
    const onChallenge = vi.fn();
    const inner = vi.fn(async () => new Response("payment required", { status: 402 }));
    const wrapped = x402Fetch(inner, onChallenge);
    await wrapped("http://x.local");
    expect(onChallenge).not.toHaveBeenCalled();
  });

  it("propagates a rejecting inner fetch unchanged", async () => {
    const err = new TypeError("fetch failed");
    const inner = vi.fn(async () => {
      throw err;
    });
    const wrapped = x402Fetch(inner, vi.fn());
    await expect(wrapped("http://x.local")).rejects.toBe(err);
  });

  it("passes the same arguments through to the inner fetch", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const wrapped = x402Fetch(inner, vi.fn());
    const init = { method: "POST", body: "{}" };
    await wrapped("http://x.local", init);
    expect(inner).toHaveBeenCalledWith("http://x.local", init);
  });
});
