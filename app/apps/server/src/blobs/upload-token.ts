import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

/**
 * The capability to write bytes into ONE pending blob.
 *
 * `intent` hands the client a URL it can PUT to; for the S3 provider that URL
 * is presigned by the bucket, and for the Postgres provider it is a same-origin
 * `PUT /api/blobs/:id/data?t=<this token>`. The two have to be interchangeable
 * or `AttachmentSync` would branch on the provider, which is exactly what the
 * intent flow exists to avoid — so this is the Postgres half of a presigned
 * URL, and it is built to the same shape: short-lived, single-purpose, and
 * carrying everything the write has to agree with.
 *
 * Why a token rather than the session:
 *  - The body PUT is a raw stream from Rust. Keeping it unauthenticated-by-
 *    session means no bearer crosses a redirect and no session cookie is needed
 *    on a transport that may be retried, resumed or run from another process.
 *  - Every decision that needs a database read — ACL, quota, MIME, rel_path,
 *    size cap — was already made at `intent`, under the session. Re-deciding
 *    them per byte-stream would be a second full gate for no extra safety.
 *  - The claims BIND the upload: a token for blob A cannot write blob B, and
 *    the sha256 and size in it are re-checked against the bytes that arrive, so
 *    a leaked token can only write the exact content it was minted for.
 *
 * HS256 with the shared secret, mirroring `tokens/sync-token.ts`. A distinct
 * audience is what stops a sync token being replayed here (and vice versa) even
 * though both are signed with the same key.
 */
export interface UploadTokenClaims {
  blobId: string;
  vaultId: string;
  /** Content hash the bytes must have. */
  sha256: string;
  /** Exact byte count the bytes must have. */
  size: number;
  /** Multipart upload this token may presign further parts for, when there is one. */
  uploadId?: string;
}

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = "context";
const AUDIENCE = "blob-upload";

export async function mintUploadToken(
  claims: UploadTokenClaims,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({
    blobId: claims.blobId,
    vaultId: claims.vaultId,
    sha256: claims.sha256,
    size: claims.size,
    ...(claims.uploadId ? { uploadId: claims.uploadId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

/**
 * Verify and decode. Throws on a bad signature, a wrong issuer/audience, an
 * expired token or malformed claims — the route answers 401 for all of them
 * alike, because telling a caller WHICH one failed is free reconnaissance.
 */
export async function verifyUploadToken(token: string): Promise<UploadTokenClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
  if (
    typeof payload.blobId !== "string" ||
    typeof payload.vaultId !== "string" ||
    typeof payload.sha256 !== "string" ||
    typeof payload.size !== "number"
  ) {
    throw new Error("Malformed upload token claims");
  }
  return {
    blobId: payload.blobId,
    vaultId: payload.vaultId,
    sha256: payload.sha256,
    size: payload.size,
    uploadId: typeof payload.uploadId === "string" ? payload.uploadId : undefined,
  };
}
