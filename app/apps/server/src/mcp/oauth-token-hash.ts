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
//   connection keeps working with no reconnect, before and after hashing.
// - Token endpoint (`mcp/oauth-token-endpoint.ts`): the client's refresh_token
//   is mapped to the value actually in the row before Better Auth sees it;
//   after Better Auth answers, the row it just created is rewritten to hashes.
//   The client always receives and keeps the plaintext it got.
// - Hashing is LAZY in the first release (on issue, refresh and use), never a
//   bulk migration: a rollback to code without the dual lookup would cut off
//   hashed connections, so the bulk pass waits one release.
// - Nothing here deletes a row. Hashing in place rewrites the lookup columns
//   only, deterministically: the client's plaintext still hashes to them.
//
// The token itself is the connector secret: a grant's vault key is wrapped
// under HKDF(token) (`mcp/oauth-grant-keys.ts`), separately for the access and
// the refresh token, so a database copy holds neither the token nor the key.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

export const HASH_PREFIX = "h1:";

export function hashOAuthToken(token: string): string {
  return HASH_PREFIX + createHash("sha256").update(token, "utf8").digest("hex");
}

export function isHashedForm(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX) && stored.length === HASH_PREFIX.length + 64;
}

/** Bare lowercase hex sha256 of a stored token value, whichever form the row
 *  holds. This (never the `h1:` form) is the allow-list MAC input. */
export function bareHashHex(stored: string): string {
  return isHashedForm(stored)
    ? stored.slice(HASH_PREFIX.length)
    : createHash("sha256").update(stored, "utf8").digest("hex");
}

/** The bearer Better Auth's getMcpSession would have read. */
export function bearerFrom(headers: Headers): string | null {
  const raw = headers.get("Authorization")?.replace("Bearer ", "");
  return raw ? raw : null;
}

/** A value no row can hold: forwarded to Better Auth in place of a refresh
 *  token we refuse (unknown, or a hash presented as a credential). */
export function unmatchableToken(): string {
  return `x-${randomBytes(24).toString("hex")}`;
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
  /** Bare hex sha256 of the refresh token (allow-list MAC input). */
  refreshHashHex: string;
}

/** The live (unexpired) grant a presented access token names, or null. */
export async function findAccessRow(db: Queryable, presented: string): Promise<OAuthAccessRow | null> {
  if (!presented || isHashedForm(presented)) return null; // a hash is never a credential
  const { rows } = await db.query<OAuthAccessRow & { accessToken: string; refreshToken: string }>(
    `SELECT "id", "clientId", "userId", "scopes", "accessToken", "refreshToken",
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
    legacyPlaintext: !isHashedForm(row.accessToken) || !isHashedForm(row.refreshToken),
    refreshHashHex: bareHashHex(row.refreshToken),
  };
}

/** The row a presented refresh token names: id, stored value, hash state. */
export async function findRefreshRow(
  db: Queryable,
  presented: string,
): Promise<{ id: string; stored: string; legacyPlaintext: boolean; refreshHashHex: string } | null> {
  if (!presented || isHashedForm(presented)) return null;
  const { rows } = await db.query<{ id: string; refreshToken: string; accessToken: string }>(
    `SELECT "id", "refreshToken", "accessToken" FROM "oauthAccessToken"
      WHERE "refreshToken" = $1 OR "refreshToken" = $2 LIMIT 1`,
    [hashOAuthToken(presented), presented],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    stored: r.refreshToken,
    legacyPlaintext: !isHashedForm(r.refreshToken) || !isHashedForm(r.accessToken),
    refreshHashHex: bareHashHex(r.refreshToken),
  };
}

/** The value Better Auth must look up for a presented refresh token (hashed or
 *  legacy), or null when no row holds it. */
export async function storedRefreshValue(db: Queryable, presented: string): Promise<string | null> {
  return (await findRefreshRow(db, presented))?.stored ?? null;
}

/** SQL turning a stored token column into its hashed form (idempotent). */
const hashedSql = (col: string) =>
  `CASE WHEN "${col}" LIKE 'h1:%' THEN "${col}"
        ELSE 'h1:' || encode(sha256(convert_to("${col}", 'UTF8')), 'hex') END`;

/** Hash a legacy plaintext row in place (both columns). Deterministic, so the
 *  client's plaintext still matches. True when the row changed. */
export async function hashRowInPlace(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE "oauthAccessToken"
        SET "accessToken" = ${hashedSql("accessToken")},
            "refreshToken" = ${hashedSql("refreshToken")}
      WHERE "id" = $1 AND ("accessToken" NOT LIKE 'h1:%' OR "refreshToken" NOT LIKE 'h1:%')`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Rewrite the row Better Auth just issued (plaintext) to hashes, including a
 *  refresh token it generated but did not return (no offline_access). Returns
 *  the row id, or null when no plaintext row matched (idempotent). */
export async function hashIssuedRow(
  db: Queryable,
  accessToken: string,
  refreshToken: string | undefined,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE "oauthAccessToken"
        SET "accessToken" = $2,
            "refreshToken" = ${hashedSql("refreshToken")}
      WHERE "accessToken" = $1
        AND ($3::text IS NULL OR "refreshToken" = $3)
      RETURNING "id"`,
    [accessToken, hashOAuthToken(accessToken), refreshToken ?? null],
  );
  return rows[0]?.id ?? null;
}
