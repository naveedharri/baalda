import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
import { handleMcpMessage, type JsonRpcRequest } from "../../mcp/protocol.js";
import type { McpContext } from "../../mcp/service.js";
import { resolveOAuthMcpAuth } from "../../mcp/oauth.js";
import {
  bumpMcpTokenUsage,
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  verifyMcpToken,
} from "../../mcp/tokens.js";
import { TOOLS } from "../../mcp/tools.js";

/**
 * The tool catalog every connection can reach (identical for all tokens; the
 * per-file ACL gates what each call actually touches). Surfaced to the desktop
 * so a connection card can show "which tools it has access to" without the UI
 * hard-coding the list. `access` classifies each tool for a compact badge.
 */
const TOOL_CATALOG = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  access: t.annotations?.destructiveHint
    ? ("destructive" as const)
    : t.annotations?.readOnlyHint
      ? ("read" as const)
      : ("write" as const),
}));

/**
 * Sent on every 401 from the MCP endpoint. Per the MCP auth spec (RFC 9728),
 * this points OAuth-capable clients (e.g. a Claude custom connector) at our
 * protected-resource metadata so they can discover the auth server and start
 * the OAuth flow instead of expecting a hand-pasted token.
 */
const WWW_AUTHENTICATE = `Bearer resource_metadata="${config.betterAuthUrl}/.well-known/oauth-protected-resource"`;

/**
 * The Model Context Protocol surface, part of the same server as everything
 * else (spec: MCP integration):
 *
 *   POST   /api/mcp          → the MCP endpoint AI clients connect to. Auth is a
 *                              minted MCP token (Bearer header or ?key=…). Speaks
 *                              JSON-RPC 2.0 / Streamable-HTTP (single JSON reply).
 *   GET/DELETE /api/mcp       → 405 (we don't offer a server→client SSE stream).
 *
 *   GET    /api/mcp/tokens        → list the caller's tokens for the active vault
 *   POST   /api/mcp/tokens {name} → mint a token (plaintext returned once)
 *   DELETE /api/mcp/tokens/:id    → revoke a token
 *
 * The token endpoints are session-authenticated (the desktop Settings page);
 * the /api/mcp endpoint is token-authenticated (the AI client).
 */

export interface McpDeps {
  docWriter: DocWriter;
  disconnectDoc: (vaultId: string, docId: string) => void;
  /** Broadcast a folder/note create/delete to connected apps. Same callback the
   *  registry routes use, so an AI's structural edit lands live exactly like a
   *  teammate's. */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
}

/** Pull the MCP token from an Authorization: Bearer header or a ?key=/?token= query. */
function extractToken(c: {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return c.req.query("key") ?? c.req.query("token") ?? null;
}

/** Active vault: the session's active org, else the user's sole membership. */
async function resolveActiveOrg(
  userId: string,
  activeOrganizationId: string | null,
): Promise<string | null> {
  if (activeOrganizationId) return activeOrganizationId;
  const { rows } = await pool.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

export function createMcpRoutes(deps: McpDeps): Hono {
  const app = new Hono();

  // ── The MCP endpoint (token- OR OAuth-authenticated) ──────────────────────
  // Two ways in, both resolving to the SAME (user, vault) McpAuth:
  //   1. a minted `mcp_` token (Bearer header or ?key=) — desktop power users;
  //   2. an OAuth 2.1 access token (Bearer header) from the custom-connector
  //      flow — the vault comes from the user's consent-screen choice.
  app.post("/mcp", async (c) => {
    const token = extractToken(c);
    const client = c.req.header("user-agent") ?? c.req.header("User-Agent") ?? null;
    let auth = token ? await verifyMcpToken(token, undefined, { client }) : null;
    if (!auth) auth = await resolveOAuthMcpAuth(c.req.raw.headers);
    if (!auth) {
      c.header("WWW-Authenticate", WWW_AUTHENTICATE);
      c.header("Access-Control-Expose-Headers", "WWW-Authenticate");
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "Unauthorized: authentication required" },
        },
        401,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const ctx: McpContext = {
      auth,
      docWriter: deps.docWriter,
      disconnectDoc: deps.disconnectDoc,
      // No origin to skip: an MCP client isn't a vault-channel subscriber, so
      // every connected app should hear about this write.
      onRegistryChanged: (vaultId) => deps.onRegistryChanged?.(vaultId, null),
    };

    // A batch (array) or a single message. Notifications yield no response.
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    let toolCalls = 0;
    for (const m of messages) {
      if ((m as JsonRpcRequest)?.method === "tools/call") toolCalls++;
      const res = await handleMcpMessage(m as JsonRpcRequest, ctx);
      if (res) responses.push(res);
    }

    // Attribute real tool work to the connection (token-auth only; OAuth has no row).
    if (auth.tokenId) bumpMcpTokenUsage(auth.tokenId, toolCalls);

    if (responses.length === 0) return c.body(null, 202); // notifications only
    return c.json(Array.isArray(body) ? responses : responses[0]);
  });

  // No server-initiated stream; be explicit so clients fall back to POST-only.
  const noStream = (c: { text: (t: string, s: 405) => Response }) =>
    c.text("Method Not Allowed", 405);
  app.get("/mcp", noStream);
  app.delete("/mcp", noStream);

  // ── Token management (session-authenticated; used by desktop Settings) ─────
  app.get("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active vault" }, 400);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const tokens = await listMcpTokens({ userId: session.userId, organizationId: org });
    // `tools` is the catalog every connection can reach — the desktop shows it
    // as "tools it has access to" per connection.
    return c.json({ tokens, tools: TOOL_CATALOG });
  });

  app.post("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active vault" }, 400);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : "MCP token";
    const { token, row } = await createMcpToken(
      { userId: session.userId, organizationId: org },
      name,
    );
    // The plaintext token is returned exactly once.
    return c.json({ token, ...row }, 201);
  });

  app.delete("/mcp/tokens/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const revoked = await revokeMcpToken(session.userId, c.req.param("id"));
    if (!revoked) return c.json({ error: "Token not found" }, 404);
    return c.json({ revoked: c.req.param("id") });
  });

  return app;
}
