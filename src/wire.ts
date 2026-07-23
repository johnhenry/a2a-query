// Wire-level devtools tap. The core's instrumentTransport() wraps TransportLike
// objects (send/onmessage — MCP-shaped); a2aq's wire surface is an injected
// fetch, so this is the fetch-shaped analog: wrap a fetchImpl, emit compact
// summaries of every JSON-RPC exchange. Summaries, not dumps — method, ids,
// sizes, status; request/response BODIES are never included, and streaming
// (SSE) response bodies are never consumed by the tap.

/** A summarized wire exchange (one event per direction). A type alias (not an
 * interface) so it keeps the implicit index signature `DevtoolsEventBase` needs. */
export type A2AWireSummary = {
  /** `"out"` = request left the client; `"in"` = response (or failure) came back. */
  dir: "out" | "in";
  /** Wire method: `"SendMessage"`, `"GetTask"`, `"SendStreamingMessage"`, … or `"GetAgentCard"` for card GETs. */
  method: string;
  /** The task the exchange concerns, when the request names one. */
  taskId?: string;
  /** JSON-RPC request id (absent for card GETs). */
  id?: string | number;
  /** Request body size in bytes (`dir: "out"` only). */
  bytes?: number;
  /** HTTP status (`dir: "in"` only). */
  status?: number;
  /** True when the response is an SSE stream (`dir: "in"` only). */
  streaming?: boolean;
  /** Present when the fetch itself rejected (network failure). */
  error?: string;
};

interface RpcRequestShape {
  method?: string;
  id?: string | number;
  params?: {
    id?: string;
    taskId?: string;
    message?: { taskId?: string };
  };
}

/** Extract the taskId a request concerns, across the A2A method shapes. */
function taskIdOf(params: RpcRequestShape["params"]): string | undefined {
  return params?.message?.taskId || params?.taskId || params?.id || undefined;
}

/**
 * Wrap a fetch so every request/response pair is summarized to `onEvent`.
 * Pass-through otherwise: same arguments, same Response object (bodies
 * untouched), same rejection — after an `error` summary is emitted.
 */
export function tapFetch(inner: typeof fetch, onEvent: (e: A2AWireSummary) => void): typeof fetch {
  return async (input, init) => {
    let method = "GetAgentCard";
    let taskId: string | undefined;
    let id: string | number | undefined;
    let bytes: number | undefined;
    if (init?.method && init.method.toUpperCase() !== "GET" && typeof init.body === "string") {
      bytes = init.body.length;
      try {
        const rpc = JSON.parse(init.body) as RpcRequestShape;
        method = String(rpc.method ?? "unknown");
        id = rpc.id;
        taskId = taskIdOf(rpc.params);
      } catch {
        method = "unknown";
      }
    }
    const base = { method, ...(taskId ? { taskId } : {}), ...(id !== undefined ? { id } : {}) };
    onEvent({ dir: "out", ...base, ...(bytes !== undefined ? { bytes } : {}) });
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      onEvent({ dir: "in", ...base, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    onEvent({
      dir: "in",
      ...base,
      status: response.status,
      streaming: (response.headers.get("content-type") ?? "").startsWith("text/event-stream"),
    });
    return response;
  };
}
