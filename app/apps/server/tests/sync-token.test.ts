import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { mintSyncToken, verifySyncToken } from "../src/tokens/sync-token.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp } from "./helpers/auth.js";
import { seedFolder, seedMember, seedNote, seedOrg, seedShare, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());

async function postSyncToken(token: string | null, docId: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request("http://local/api/sync-token", {
      method: "POST",
      headers,
      body: JSON.stringify({ docId }),
    }),
  );
}

describe("POST /api/sync-token (spec 03 §7)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("edit grant -> 200 readOnly:false with a valid, doc-scoped token", async () => {
    const owner = await signUp("owner@t.com");
    const org = await seedOrg("Acme", "acme-t1");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "n.md");

    const res = await postSyncToken(owner.token, doc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      readOnly: boolean;
      permission: string;
      vaultId: string;
    };
    expect(body.readOnly).toBe(false);
    expect(body.permission).toBe("edit");

    const claims = await verifySyncToken(body.token);
    expect(claims.docId).toBe(doc);
    expect(claims.vaultId).toBe(vault);
    expect(claims.readOnly).toBe(false);
    // Attribution: the sync server reads this to stamp "last edited by" and to
    // author auto-captured versions.
    expect(claims.userId).toBe(owner.userId);
  });

  it("verifies a token minted WITHOUT a userId claim as anonymous", async () => {
    // Tokens minted before attribution existed stay in flight for the whole TTL.
    // They must keep syncing — nameless, not rejected — or a deploy drops every
    // open editor just to learn who is typing.
    const token = await mintSyncToken({ docId: "d", vaultId: "v", readOnly: false });
    const claims = await verifySyncToken(token);
    expect(claims.userId).toBeUndefined();
    expect(claims.docId).toBe("d");
  });

  it("view grant -> 200 readOnly:true", async () => {
    const viewer = await signUp("viewer@t.com");
    const org = await seedOrg("Acme", "acme-t2");
    await seedMember(org, viewer.userId, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const doc = await seedNote(vault, folder, "Shared/n.md");
    await seedShare(org, "folder", folder, viewer.userId, "view");

    const res = await postSyncToken(viewer.token, doc);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readOnly: boolean; permission: string };
    expect(body.readOnly).toBe(true);
    expect(body.permission).toBe("view");
  });

  it("no grant -> 403", async () => {
    const stranger = await signUp("stranger@t.com");
    const org = await seedOrg("Acme", "acme-t3");
    await seedMember(org, stranger.userId, "member"); // member but no share
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "n.md");

    const res = await postSyncToken(stranger.token, doc);
    expect(res.status).toBe(403);
  });

  it("unknown doc -> 404", async () => {
    const user = await signUp("u@t.com");
    const res = await postSyncToken(user.token, "no-such-doc");
    expect(res.status).toBe(404);
  });

  it("no auth -> 401", async () => {
    const org = await seedOrg("Acme", "acme-t4");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "n.md");
    const res = await postSyncToken(null, doc);
    expect(res.status).toBe(401);
  });
});
