import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { config } from "../config.js";

/**
 * Short-lived per-doc sync JWT (spec 03 §7, 04 §4). HS256, signed with the
 * shared secret. The Hocuspocus socket consumes this; TTL is short (~10m) so
 * revocation is near-instant.
 */
export interface SyncTokenClaims {
  docId: string;
  vaultId: string;
  readOnly: boolean;
  /**
   * Who the token was minted for — the attribution source for "last edited by".
   *
   * Optional, and `verifySyncToken` must keep it optional: tokens minted before
   * this claim existed are still in flight (TTL ~10 min), and a client holding
   * one has to keep syncing, just anonymously. Rejecting them would drop every
   * open editor at deploy time to learn a name.
   */
  userId?: string;
}

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = "context";
const AUDIENCE = "hocuspocus";

export async function mintSyncToken(
  claims: SyncTokenClaims,
  ttlSeconds: number = config.syncTokenTtlSeconds,
): Promise<string> {
  return new SignJWT({
    docId: claims.docId,
    vaultId: claims.vaultId,
    readOnly: claims.readOnly,
    ...(claims.userId ? { userId: claims.userId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifySyncToken(token: string): Promise<SyncTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (
    typeof payload.docId !== "string" ||
    typeof payload.vaultId !== "string" ||
    typeof payload.readOnly !== "boolean"
  ) {
    throw new Error("Malformed sync token claims");
  }
  return {
    docId: payload.docId,
    vaultId: payload.vaultId,
    readOnly: payload.readOnly,
    // Absent on tokens minted before attribution existed — anonymous, not invalid.
    userId: typeof payload.userId === "string" ? payload.userId : undefined,
  };
}

export { joseErrors };
