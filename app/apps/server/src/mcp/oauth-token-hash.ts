// SPDX-License-Identifier: Apache-2.0
//
// OAuth (claude.ai / ChatGPT connector) tokens stored as hashes (W3, rule 3).
//
// Better Auth 1.6's `mcp` plugin has no option to hash access/refresh tokens:
// it writes them in plaintext to "oauthAccessToken" and looks them up by exact
// value (`getMcpSession`, and the token endpoint's refresh_token grant). So we
// wrap it instead of forking it:
//
// - Stored form: `h1:` + lowercase hex sha256(token). Better Auth's tokens are
//   32 ASCII letters, so the prefix makes the two forms unambiguous and a
//   mixed table (old plaintext rows + new hashed rows) is safe to read.
// - Read path (`POST /api/mcp`): `findAccessRow` hashes the presented bearer
//   and matches the hashed OR the legacy plaintext value, so every existing
//   connection keeps working with no reconnect, before and after migration.
// - Token endpoint: `storedRefreshValue` maps the client's refresh_token to the
//   value actually in the row (hashed or legacy) before Better Auth sees it;
//   after Better Auth answers, `hashIssuedRow` rewrites the row it just created
//   to hashes. The client always receives and keeps the plaintext it got.
// - Nothing here deletes a row. Hashing in place is a one-way rewrite of the
//   lookup column only; the client still holds the plaintext that hashes to it.
//
// The token itself is the connector secret: a grant's vault key is wrapped
// under HKDF(token) (`crypto/token-wrap.ts`), separately for the access and
// the refresh token, so a database copy holds neither the token nor the key.
import { createHash } from "node:crypto";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export const HASH_PREFIX = "h1:";

export function hashOAuthToken(token: string): string {
  return HASH_PREFIX + createHash("sha256").update(token, "utf8").digest("hex");
}

export function isHashedForm(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX) && stored.length === HASH_PREFIX.length + 64;
}

export interface OAuthAccessRow {
  id: string;
  clientId: string;
  userId: string | null;
  scopes: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  /** True while the row still holds a legacy plaintext token. */
  legacyPlaintext: boolean;
}

/** The live (unexpired) grant a presented access token names, or null. */
export async function findAccessRow(db: Queryable, presented: string): Promise<OAuthAccessRow | null> {
  if (!presented || isHashedForm(presented)) return null; // a hash is never a credential
  const { rows } = await db.query<OAuthAccessRow & { accessToken: string }>(
    `SELECT "id", "clientId", "userId", "scopes", "accessToken",
            "accessTokenExpiresAt", "refreshTokenExpiresAt"
       FROM "oauthAccessToken"
      WHERE "accessToken" = $1 OR "accessToken" = $2
      LIMIT 1`,
    [hashOAuthToken(presented), presented],
  );
  const row = rows[0];
  if (!row || row.accessTokenExpiresAt < new Date()) return null;
  return {
    id: row.id,
    clientId: row.clientId,
    userId: row.userId,
    scopes: row.scopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    legacyPlaintext: !isHashedForm(row.accessToken),
  };
}

/** The value Better Auth must look up for a presented refresh token (hashed or
 *  legacy), or null when no row holds it — Better Auth then refuses as today. */
export async function storedRefreshValue(db: Queryable, presented: string): Promise<string | null> {
  if (!presented || isHashedForm(presented)) return null;
  const { rows } = await db.query<{ refreshToken: string }>(
    `SELECT "refreshToken" FROM "oauthAccessToken"
      WHERE "refreshToken" = $1 OR "refreshToken" = $2 LIMIT 1`,
    [hashOAuthToken(presented), presented],
  );
  return rows[0]?.refreshToken ?? null;
}

/** Rewrite the row Better Auth just issued (plaintext) to hashes. Returns the
 *  row id, or null when no plaintext row matched (already hashed: idempotent). */
export async function hashIssuedRow(
  db: Queryable,
  accessToken: string,
  refreshToken: string | undefined,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE "oauthAccessToken"
        SET "accessToken" = $2,
            "refreshToken" = CASE
              WHEN $3::text IS NOT NULL THEN $4
              WHEN "refreshToken" LIKE 'h1:%' THEN "refreshToken"
              -- never handed out (no offline_access), hashed anyway
              ELSE 'h1:' || encode(sha256(convert_to("refreshToken", 'UTF8')), 'hex')
            END,
            "updatedAt" = now()
      WHERE "accessToken" = $1
        AND ($3::text IS NULL OR "refreshToken" = $3)
      RETURNING "id"`,
    [
      accessToken,
      hashOAuthToken(accessToken),
      refreshToken ?? null,
      refreshToken ? hashOAuthToken(refreshToken) : null,
    ],
  );
  return rows[0]?.id ?? null;
}
