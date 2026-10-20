// Node-only helpers for exercising the BROWSER path of an A2A client against a
// real local HTTP server. Import from "@johnhenry/a2a-query/testing/http" (not
// the browser-safe "/testing" entry — this one needs node:http).
//
//  - serveMockAgent(mock, opts): the mock agent behind a real socket — agent card,
//    JSON-RPC, real SSE framing — with configurable CORS, an optional bearer
//    requirement, and a one-shot mid-stream connection cut.
//  - browserLikeFetch({ origin }): a fetch that applies the browser's CORS rules
//    (preflight for non-simple requests, Access-Control-Allow-* checks, and
//    response-header filtering). Node's own fetch does not enforce CORS, so without
//    this a test cannot tell whether a server config would work from a page.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MockA2AAgent } from "./mockAgent.js";

export interface MockAgentCors {
  /** Allowed page origins, or "*". Requests from other origins get no CORS headers. */
  origins: string[] | "*";
  /** Access-Control-Allow-Headers (lower-case). Default: content-type only. */
  headers?: string[];
  /** Access-Control-Allow-Methods. Default: GET, POST, OPTIONS. */
  methods?: string[];
  /** Access-Control-Expose-Headers: response headers a page may read. */
  expose?: string[];
}

export interface MockAgentServerOptions {
  /** Omit for no CORS headers at all (a same-origin-only agent). */
  cors?: MockAgentCors;
  /** Require `Authorization: Bearer <token>` on every non-preflight request (401 otherwise). */
  requireBearer?: string;
  /** Cut the first SSE response's connection after this many events (a mid-stream drop). */
  dropFirstStreamAfterEvents?: number;
  /** Extra headers set on every non-preflight response. */
  responseHeaders?: Record<string, string>;
}

export interface LoggedRequest {
  method: string;
  path: string;
  origin?: string;
  authorization?: string;
  accept?: string;
}

export interface MockAgentServer {
  /** Base URL, e.g. http://127.0.0.1:41234 — also the JSON-RPC endpoint; the card is patched to point here. */
  url: string;
  requests: LoggedRequest[];
  close(): Promise<void>;
}

export async function serveMockAgent(mock: MockA2AAgent, opts: MockAgentServerOptions = {}): Promise<MockAgentServer> {
  const requests: LoggedRequest[] = [];
  let streamsServed = 0;
  let baseUrl = "";

  const allowedOrigin = (origin: string | undefined): string | undefined => {
    const o = opts.cors?.origins;
    if (!o || !origin) return undefined;
    if (o === "*") return "*";
    return o.includes(origin) ? origin : undefined;
  };

  const corsHeaders = (origin: string | undefined): Record<string, string> => {
    const allow = allowedOrigin(origin);
    if (!allow) return {};
    const h: Record<string, string> = { "access-control-allow-origin": allow, vary: "Origin" };
    if (opts.cors!.expose?.length) h["access-control-expose-headers"] = opts.cors!.expose.join(", ");
    return h;
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const method = (req.method ?? "GET").toUpperCase();
    requests.push({
      method,
      path: req.url ?? "/",
      origin,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
    });

    if (method === "OPTIONS") {
      const h = corsHeaders(origin);
      if (h["access-control-allow-origin"]) {
        h["access-control-allow-methods"] = (opts.cors!.methods ?? ["GET", "POST", "OPTIONS"]).join(", ");
        h["access-control-allow-headers"] = (opts.cors!.headers ?? ["content-type"]).join(", ");
        h["access-control-max-age"] = "600";
      }
      res.writeHead(204, h).end();
      return;
    }

    const cors = corsHeaders(origin);
    if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      res.writeHead(401, { ...cors, ...(opts.responseHeaders ?? {}), "www-authenticate": "Bearer", "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const out = await mock.fetchImpl(baseUrl + (req.url ?? "/"), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks).toString("utf8"),
    });

    const resHeaders: Record<string, string> = { ...cors, ...(opts.responseHeaders ?? {}) };
    out.headers.forEach((v, k) => (resHeaders[k] = v));
    const isSse = (out.headers.get("content-type") ?? "").includes("text/event-stream");

    if (method === "GET" && !isSse) {
      const text = await out.text();
      let body = text;
      try {
        // The mock's card advertises a placeholder URL; point it at this server.
        const card = JSON.parse(text) as { url?: string; supportedInterfaces?: Array<{ url: string }> };
        if (card.url) card.url = baseUrl;
        for (const i of card.supportedInterfaces ?? []) i.url = baseUrl;
        body = JSON.stringify(card);
      } catch {
        /* not JSON: pass through */
      }
      res.writeHead(out.status, resHeaders).end(body);
      return;
    }

    res.writeHead(out.status, resHeaders);
    if (!out.body) {
      res.end();
      return;
    }
    const dropAfter = isSse && streamsServed++ === 0 ? opts.dropFirstStreamAfterEvents : undefined;
    const reader = out.body.getReader();
    res.on("close", () => void reader.cancel().catch(() => {}));
    const dec = new TextDecoder();
    let events = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      if (dropAfter !== undefined) {
        events += (dec.decode(value, { stream: true }).match(/\n\n/g) ?? []).length;
        if (events >= dropAfter) {
          await reader.cancel().catch(() => {});
          res.destroy(); // abrupt: the client sees a network error mid-stream
          return;
        }
      }
    }
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── browser-faithful fetch ──────────────────────────────────────────────────

const SAFE_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-language"]);
const SAFE_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];
const SAFE_RESPONSE_HEADERS = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);

export interface BrowserLikeFetchOptions {
  /** The page's origin, e.g. "https://app.example". */
  origin: string;
  /** The underlying fetch. Default: global fetch. */
  fetch?: typeof fetch;
}

/**
 * A fetch that behaves like a browser page on `origin` talking cross-origin:
 * non-simple requests (any non-safelisted header such as `Authorization`, or a
 * `Content-Type` of `application/json`) are preceded by an OPTIONS preflight that
 * must be answered with matching Access-Control-Allow-* headers; the real
 * response must carry a matching Access-Control-Allow-Origin; and only
 * safelisted + Access-Control-Expose-Headers response headers survive.
 * Failures throw `TypeError`, as a browser's fetch does.
 */
export function browserLikeFetch(opts: BrowserLikeFetchOptions): typeof fetch {
  const real = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (new URL(url).origin === opts.origin) return real(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

    const nonSafe: string[] = [];
    headers.forEach((v, k) => {
      if (SAFE_REQUEST_HEADERS.has(k)) return;
      if (k === "content-type" && SAFE_CONTENT_TYPES.some((t) => v.toLowerCase().startsWith(t))) return;
      nonSafe.push(k);
    });
    const needsPreflight = !["GET", "HEAD", "POST"].includes(method) || nonSafe.length > 0;

    if (needsPreflight) {
      const pre = await real(url, {
        method: "OPTIONS",
        headers: {
          origin: opts.origin,
          "access-control-request-method": method,
          ...(nonSafe.length ? { "access-control-request-headers": nonSafe.sort().join(",") } : {}),
        },
      });
      if (pre.status < 200 || pre.status > 299) throw new TypeError(`CORS preflight failed: HTTP ${pre.status}`);
      const ao = pre.headers.get("access-control-allow-origin");
      if (ao !== "*" && ao !== opts.origin) {
        throw new TypeError(`CORS preflight failed: Access-Control-Allow-Origin is ${ao ?? "missing"} for page origin ${opts.origin}`);
      }
      const methods = (pre.headers.get("access-control-allow-methods") ?? "").split(",").map((s) => s.trim().toUpperCase());
      if (!["GET", "HEAD", "POST"].includes(method) && !methods.includes(method) && !methods.includes("*")) {
        throw new TypeError(`CORS preflight failed: method ${method} not in Access-Control-Allow-Methods`);
      }
      const allowed = (pre.headers.get("access-control-allow-headers") ?? "").split(",").map((s) => s.trim().toLowerCase());
      for (const h of nonSafe) {
        if (!allowed.includes(h) && !(allowed.includes("*") && h !== "authorization")) {
          throw new TypeError(`CORS preflight failed: request header "${h}" is not in Access-Control-Allow-Headers`);
        }
      }
    }

    headers.set("origin", opts.origin);
    const res = await real(input, { ...init, headers });
    const ao = res.headers.get("access-control-allow-origin");
    if (ao !== "*" && ao !== opts.origin) {
      throw new TypeError(`CORS: response lacks a matching Access-Control-Allow-Origin (got ${ao ?? "none"}) for page origin ${opts.origin}`);
    }
    const exposed = new Set((res.headers.get("access-control-expose-headers") ?? "").split(",").map((s) => s.trim().toLowerCase()));
    const visible = new Headers();
    res.headers.forEach((v, k) => {
      if (SAFE_RESPONSE_HEADERS.has(k) || exposed.has(k) || exposed.has("*")) visible.set(k, v);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: visible });
  };
}
