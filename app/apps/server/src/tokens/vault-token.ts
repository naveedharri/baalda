import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

/**
 * Vault-scoped sync JWT for the vault replication channel (spec 05 §7). Unlike
 * the per-doc token ([[sync-token]]), this widens the *connection* scope to a
 * whole vault and carries the `userId`, so the channel can ACL-filter **per doc**
 * on backfill + fanout. It does NOT widen data scope: a doc the user can't read
 * is never sent. Short TTL (reuses SYNC_TOKEN_TTL_SECONDS) keeps revocation near
 * the token-refresh boundary; live ACL changes are handled by acl-change events.
 */
export interface VaultTokenClaims {
  userId: string;
  vaultId: string;
}

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = "context";
const AUDIENCE = "vault-sync";

export async function mintVaultToken(
  claims: VaultTokenClaims,
  ttlSeconds: number = config.syncTokenTtlSeconds,
): Promise<string> {
  return new SignJWT({ userId: claims.userId, vaultId: claims.vaultId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyVaultToken(token: string): Promise<VaultTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.userId !== "string" || typeof payload.vaultId !== "string") {
    throw new Error("Malformed vault token claims");
  }
  return { userId: payload.userId, vaultId: payload.vaultId };
}
