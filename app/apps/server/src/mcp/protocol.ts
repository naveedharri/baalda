import { inc } from "../metrics/sync-metrics.js";
import { McpToolError, type McpContext } from "./service.js";
import { TOOLS, TOOLS_BY_NAME } from "./tools.js";

/**
 * A minimal, spec-compliant MCP server over JSON-RPC 2.0, transport-agnostic.
 * The HTTP route (routes/mcp.ts) feeds us one parsed JSON-RPC message plus the
 * caller's McpContext; we return the JSON-RPC response object, or null for a
 * notification (which gets an HTTP 202 with no body).
 *
 * We implement the Streamable-HTTP request/response shape: a single JSON reply
 * per request, no SSE stream. That covers every CRUD interaction — the server
 * never needs to push unsolicited messages.
 */

const SERVER_INFO = { name: "context", version: "0.1.0" } as const;
/** The protocol revision we implement; we echo a client's version when sane. */
const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function fail(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** A tool result: text (always) + structuredContent (when the payload is data). */
function toolResult(data: unknown): Record<string, unknown> {
  const structured = Array.isArray(data) ? { results: data } : data;
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function toolError(message: string, code?: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: code ? `${code}: ${message}` : message }],
    isError: true,
    ...(code ? { structuredContent: { code, error: message } } : {}),
  };
}

/**
 * Handle one JSON-RPC message. Returns null for notifications (no id / methods
 * under `notifications/`). Never throws — protocol errors come back as JSON-RPC
 * error objects; tool failures come back as `isError` results.
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  ctx: McpContext,
): Promise<JsonRpcResponse | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(msg?.id ?? null, ERR.invalidRequest, "Invalid JSON-RPC request");
  }

  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: unknown })?.protocolVersion;
      return ok(msg.id, {
        protocolVersion:
          typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return ok(msg.id, {});

    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.annotations.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });

    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") {
        return fail(msg.id, ERR.invalidParams, "tools/call requires a string `name`");
      }
      const tool = TOOLS_BY_NAME.get(params.name);
      if (!tool) {
        return ok(msg.id, toolError(`Unknown tool: ${params.name}`));
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      // Outcome counters per tool — names and codes only, never arguments —
      // so an error rate seen in a client's dashboard can be split into
      // refusals (by code) and crashes from the `[sync-metrics]` lines.
      try {
        const data = await tool.handler(ctx, args);
        inc(`mcp.tool.${tool.name}.ok`);
        return ok(msg.id, toolResult(data));
      } catch (err) {
        // Expected, user-facing failures (bad args, no access) → isError result.
        if (err instanceof McpToolError) {
          inc(`mcp.tool.${tool.name}.refused`);
          if (err.code) inc(`mcp.tool.${tool.name}.refused.${err.code}`);
          return ok(msg.id, toolError(err.message, err.code));
        }
        // Anything else is a bug on our side — log it, don't leak internals.
        inc(`mcp.tool.${tool.name}.internal`);
        console.error(`[mcp] tool ${params.name} failed:`, err);
        return ok(msg.id, toolError("Internal error running the tool"));
      }
    }

    default:
      // Unknown notifications (e.g. notifications/initialized, cancelled) are
      // silently accepted; unknown requests get a proper method-not-found.
      if (isNotification) return null;
      return fail(msg.id, ERR.methodNotFound, `Unknown method: ${msg.method}`);
  }
}
