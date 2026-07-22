import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";
import { auth } from "../auth/auth.js";
import type { McpAuth } from "./tokens.js";

/**
 * The OAuth half of MCP auth (migration 007 + the Better Auth `mcp` plugin).
 *
 * A minted `mcp_` token already encodes its (user, vault) scope in its DB
 * row. An OAuth access token, by contrast, only tells us WHO the caller is —
 * the vault is chosen by the user on the consent screen and recorded in
 * `mcp_oauth_vault`, keyed per
 * (client, user). This module bridges an incoming OAuth bearer to the same
 * `McpAuth` context an mcp_ token produces, so everything downstream
 * (service.ts ACL checks) is identical either way.
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * Record the vault the user granted a connector access to (upsert: a user
 * re-consenting the same client can retarget it to another vault).
 */
export async function setVaultBinding(
  clientId: string,
  userId: string,
  organizationId: string,
  db: Queryable = defaultPool,
): Promise<void> {
  await db.query(
    `INSERT INTO mcp_oauth_vault (client_id, user_id, organization_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, user_id)
       DO UPDATE SET organization_id = EXCLUDED.organization_id, updated_at = now()`,
    [clientId, userId, organizationId],
  );
}

/** The vault bound to (client, user), or null if none was recorded. */
async function getVaultBinding(
  clientId: string,
  userId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM mcp_oauth_vault WHERE client_id = $1 AND user_id = $2",
    [clientId, userId],
  );
  return rows[0]?.organization_id ?? null;
}

/** Fallback when no binding exists: the user's sole vault, else null. */
async function soleVault(
  userId: string,
  db: Queryable = defaultPool,
): Promise<string | null> {
  const { rows } = await db.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

/**
 * Resolve an incoming request carrying an OAuth `Authorization: Bearer` access
 * token to an `McpAuth`, or null if the token is missing/invalid/expired, no
 * vault can be determined, or the user is no longer a member of it
 * (membership can be revoked out from under a live token — re-checked here,
 * exactly like verifyMcpToken does for mcp_ tokens).
 */
export async function resolveOAuthMcpAuth(
  headers: Headers,
  db: Queryable = defaultPool,
): Promise<McpAuth | null> {
  const session = await auth.api.getMcpSession({ headers });
  if (!session?.userId || !session.clientId) return null;

  const organizationId =
    (await getVaultBinding(session.clientId, session.userId, db)) ??
    (await soleVault(session.userId, db));
  if (!organizationId) return null;

  if (!(await orgRole(organizationId, session.userId, db))) return null;

  return { userId: session.userId, organizationId };
}
