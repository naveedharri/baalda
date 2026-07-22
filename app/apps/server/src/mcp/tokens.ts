import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";

/**
 * MCP access tokens (migration 006).
 *
 * A token authenticates an AI client to POST /api/mcp AS one user WITHIN one
 * vault. We persist only sha256(token) so a DB leak can't reveal live
 * tokens; the plaintext is shown to the human exactly once, at creation.
 */

type Queryable = Pick<pg.Pool, "query">;

const PREFIX = "mcp_";
/** How many leading chars we keep for display (prefix + a short peek). */
const DISPLAY_LEN = PREFIX.length + 6;

export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** How many tool calls this connection has made (bumped per tools/call). */
  useCount: number;
  /** The last client's User-Agent, so the UI can name the connection. */
  lastClient: string | null;
}

export interface McpAuth {
  userId: string;
  organizationId: string;
  /**
   * The mcp_tokens row id when auth came from a minted token, so the request
   * handler can attribute tool-call usage back to the connection. Absent for
   * OAuth-authenticated requests (no token row exists for those).
   */
  tokenId?: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A URL-safe opaque token: `mcp_` + 24 random bytes (base64url ≈ 32 chars). */
function generateToken(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

/**
 * Mint a token for (userId, organizationId). Returns the PLAINTEXT token (shown
 * once) plus the stored row. Caller must have verified the user's role in the org.
 */
export async function createMcpToken(
  auth: McpAuth,
  name: string,
  db: Queryable = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  const token = generateToken();
  const id = randomUUID();
  const tokenPrefix = token.slice(0, DISPLAY_LEN) + "…";
  const { rows } = await db.query<{ created_at: string }>(
    `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING created_at`,
    [id, auth.userId, auth.organizationId, name, hashToken(token), tokenPrefix],
  );
  return {
    token,
    row: {
      id,
      name,
      tokenPrefix,
      createdAt: rows[0].created_at,
      lastUsedAt: null,
      useCount: 0,
      lastClient: null,
    },
  };
}

/** List a user's tokens for one vault (never returns hashes). */
export async function listMcpTokens(
  auth: McpAuth,
  db: Queryable = defaultPool,
): Promise<McpTokenRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
    use_count: number;
    last_client: string | null;
  }>(
    `SELECT id, name, token_prefix, created_at, last_used_at, use_count, last_client
       FROM mcp_tokens
      WHERE user_id = $1 AND organization_id = $2
      ORDER BY created_at DESC`,
    [auth.userId, auth.organizationId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    // pg returns INTEGER as a JS number, but coerce defensively.
    useCount: Number(r.use_count ?? 0),
    lastClient: r.last_client,
  }));
}

/** Revoke a token the caller owns. Returns true if a row was deleted. */
export async function revokeMcpToken(
  userId: string,
  tokenId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM mcp_tokens WHERE id = $1 AND user_id = $2",
    [tokenId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Longest client string we retain — a User-Agent, trimmed so it can't bloat the row. */
const CLIENT_MAX = 200;

/**
 * Resolve a presented token to its auth context. Returns null when the token is
 * unknown OR the user is no longer a member of the vault it was scoped to
 * (membership can be revoked out from under a live token). Stamps last_used_at
 * (and the client, when given) best-effort — this drives the desktop's "active"
 * indicator. This is the single gate every MCP request passes through.
 */
export async function verifyMcpToken(
  token: string,
  db: Queryable = defaultPool,
  meta?: { client?: string | null },
): Promise<McpAuth | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    organization_id: string;
  }>(
    "SELECT id, user_id, organization_id FROM mcp_tokens WHERE token_hash = $1",
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Membership can be revoked after the token was minted — re-check every time.
  const role = await orgRole(row.organization_id, row.user_id, db);
  if (!role) return null;

  // Best-effort activity stamp; never block the request on it. use_count is NOT
  // bumped here — that happens per tools/call via bumpMcpTokenUsage so the count
  // reflects real work, not initialize/tools-list handshakes.
  const client = meta?.client ? meta.client.slice(0, CLIENT_MAX) : null;
  db.query(
    "UPDATE mcp_tokens SET last_used_at = now(), last_client = COALESCE($2, last_client) WHERE id = $1",
    [row.id, client],
  ).catch(() => {});

  return { userId: row.user_id, organizationId: row.organization_id, tokenId: row.id };
}

/**
 * Attribute `count` tool calls to a token (best-effort; never blocks the reply).
 * Called by the MCP route after a request so the desktop's usage figure tracks
 * actual tool invocations rather than every JSON-RPC handshake message.
 */
export function bumpMcpTokenUsage(
  tokenId: string,
  count: number,
  db: Queryable = defaultPool,
): void {
  if (count <= 0) return;
  db.query("UPDATE mcp_tokens SET use_count = use_count + $2 WHERE id = $1", [
    tokenId,
    count,
  ]).catch(() => {});
}
