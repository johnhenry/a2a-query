// Inbound push-notification webhook — the disconnected-client story. An A2A
// agent with a registered push config POSTs task updates (the SDK server's
// sender serializes one StreamResponse per event, content type
// `application/a2a+json`, token echoed in `X-A2A-Notification-Token`).
// `createWebhookHandler` turns those POSTs into cache folds: validate the
// token, parse the event, fold via `q.ingestPush` (the SAME entries the
// poll/stream drivers write), then — family rule — follow with a full
// getTask reconcile, because pushes can arrive out of order, duplicated, or
// with gaps.
//
// Transport-agnostic by construction: `(req: Request) => Promise<Response>`
// over the web standards, mountable in anything that speaks fetch (Node
// http via adapters, Hono/Express bridges, Workers, Deno, Bun).

import { StreamResponse, Task } from "@a2a-js/sdk";
import type { A2AQuery } from "./client.js";

export interface WebhookHandlerOptions {
  /** The registry name of the agent whose pushes arrive here (one handler per agent — route by path). */
  agent: string;
  /**
   * Shared token: pushes must echo it in `X-A2A-Notification-Token` (or
   * `Authorization: Bearer …`) or they are rejected 401. Pass the same value
   * as `PushConfigInit.token` when registering. Absent ⇒ no auth check
   * (in-process/testing only — never expose an unauthenticated webhook).
   */
  token?: string;
  /**
   * Follow each fold with a full `getTask` read (default true). Turning it
   * off trades the out-of-order/duplicate safety net for zero extra wire
   * calls — only sensible when something else already reconciles (e.g. an
   * active polling handle on the same task).
   */
  reconcile?: boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bearer = (header: string | null): string | undefined =>
  header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;

/**
 * A web-standard webhook endpoint for one agent's push notifications.
 * Accepts the SDK sender's wire shape (a `StreamResponse` JSON — task /
 * statusUpdate / artifactUpdate / message) and, tolerantly, a bare Task
 * snapshot. Responses: 200 folded (+reconciled), 202 accepted-but-ignored
 * (standalone message), 400 unparseable, 401 bad token, 405 not a POST.
 */
export function createWebhookHandler(
  q: A2AQuery,
  opts: WebhookHandlerOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method.toUpperCase() !== "POST") return json({ error: "method not allowed" }, 405);
    if (opts.token !== undefined) {
      const presented = req.headers.get("x-a2a-notification-token") ?? bearer(req.headers.get("authorization"));
      if (presented !== opts.token) return json({ error: "invalid notification token" }, 401);
    }
    let ev: StreamResponse;
    try {
      const body: unknown = await req.json();
      ev = StreamResponse.fromJSON(body);
      if (!ev.payload) {
        // Tolerate a bare Task snapshot (senders outside the SDK often push
        // the task itself rather than the StreamResponse envelope).
        const task = Task.fromJSON(body);
        if (!task.id) return json({ error: "unrecognized push payload" }, 400);
        ev = { payload: { $case: "task", value: task } };
      }
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const taskId = q.ingestPush(opts.agent, ev);
    if (!taskId) return json({ ok: true, ignored: true }, 202);
    if (opts.reconcile !== false) {
      // FAMILY RULE: a push is a hint, not truth — reconverge to the server
      // with a full read. Reconcile failures don't fail the receipt (the
      // push IS accepted); the StatusStore carries the degradation.
      try {
        await q.task(opts.agent, taskId);
      } catch {
        /* acknowledged anyway — see above */
      }
    }
    return json({ ok: true, taskId });
  };
}
