import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";
import { vaultKeysEnabled } from "../crypto/config.js";
import type { McpAuth } from "./tokens.js";
import { bearerFrom, findAccessRow, hashRowInPlace } from "./oauth-token-hash.js";
import { grantOrg, resolveGrantKeys } from "./oauth-grant-keys.js";

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

// The vault a grant acts on (binding, else the user's sole vault) lives in
// oauth-grant-keys.ts `grantOrg`, shared with the token endpoint's rewrap.

/** Why an OAuth bearer did not resolve: signed in, but no vault chosen. */
export type OAuthMcpFailure = "no_vault_selected" | null;

/**
 * Resolve an incoming request carrying an OAuth `Authorization: Bearer` access
 * token to an `McpAuth`, or null if the token is missing/invalid/expired, no
 * vault can be determined, or the user is no longer a member of it
 * (membership can be revoked out from under a live token — re-checked here,
 * exactly like verifyMcpToken does for mcp_ tokens). `onFailure` learns when
 * the token itself was valid but no vault was bound, so the 401 can say so.
 */
export async function resolveOAuthMcpAuth(
  headers: Headers,
  db: Queryable = defaultPool,
  onFailure?: (reason: OAuthMcpFailure) => void,
): Promise<McpAuth | null> {
  // Better Auth's getMcpSession matched the bearer verbatim; tokens are now
  // stored as hashes (lazily), so the lookup accepts either stored form.
  const bearer = bearerFrom(headers);
  if (!bearer) return null;
  const session = await findAccessRow(db, bearer);
  if (!session?.userId || !session.clientId) return null;
  if (session.legacyPlaintext) {
    hashRowInPlace(db, session.id).catch(() => {}); // lazy; a plaintext row still resolves
  }

  const organizationId = await grantOrg(session.clientId, session.userId, db);
  if (!organizationId) {
    onFailure?.("no_vault_selected");
    return null;
  }

  if (!(await orgRole(organizationId, session.userId, db))) return null;

  const out: McpAuth = { userId: session.userId, organizationId, oauthClientId: session.clientId };
  if (vaultKeysEnabled()) {
    const keys = await resolveGrantKeys(bearer, session, organizationId, db);
    if (keys.size > 0) out.vaultKeys = keys;
  }
  return out;
}
