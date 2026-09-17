import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { mintUploadToken, verifyUploadToken } from "../src/blobs/upload-token.js";

/**
 * The Postgres provider's half of a presigned URL. Every property asserted here
 * is one the `PUT /api/blobs/:id/data` route relies on instead of a session, so
 * a regression in any of them is an authorization bug, not a formatting one.
 */
const CLAIMS = {
  blobId: "blob-1",
  vaultId: "vault-1",
  sha256: "a".repeat(64),
  size: 4096,
};

const secret = new TextEncoder().encode(config.jwtSecret);

describe("blob upload token", () => {
  it("round-trips every claim the PUT route checks", async () => {
    const token = await mintUploadToken({ ...CLAIMS, uploadId: "mp-1" }, 600);
    expect(await verifyUploadToken(token)).toEqual({ ...CLAIMS, uploadId: "mp-1" });
  });

  it("omits uploadId when there is no multipart upload", async () => {
    const decoded = await verifyUploadToken(await mintUploadToken(CLAIMS, 600));
    expect(decoded.uploadId).toBeUndefined();
  });

  it("rejects a tampered signature", async () => {
    const token = await mintUploadToken(CLAIMS, 600);
    const [h, p] = token.split(".");
    await expect(verifyUploadToken(`${h}.${p}.${"A".repeat(43)}`)).rejects.toThrow();
  });

  it("rejects a tampered payload", async () => {
    const token = await mintUploadToken(CLAIMS, 600);
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    // A bigger size would let a leaked token write a bigger body than the gate
    // that minted it ever admitted.
    payload.size = 5_000_000_000;
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
    await expect(verifyUploadToken(`${h}.${forged}.${s}`)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    await expect(verifyUploadToken(await mintUploadToken(CLAIMS, -60))).rejects.toThrow();
  });

  it("rejects a SYNC token signed with the same secret", async () => {
    // Both token families are HS256 over `config.jwtSecret`; the audience is the
    // only thing stopping a doc-sync token from being replayed as a licence to
    // write bytes, so it has to be checked.
    const crossAudience = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("context")
      .setAudience("hocuspocus")
      .setExpirationTime("600s")
      .sign(secret);
    await expect(verifyUploadToken(crossAudience)).rejects.toThrow();
  });

  it("rejects a well-signed token with claims the route could not use", async () => {
    const malformed = await new SignJWT({ blobId: "b", vaultId: "v" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("context")
      .setAudience("blob-upload")
      .setExpirationTime("600s")
      .sign(secret);
    await expect(verifyUploadToken(malformed)).rejects.toThrow(/Malformed/);
  });
});
