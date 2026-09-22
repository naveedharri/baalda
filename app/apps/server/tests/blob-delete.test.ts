import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * `DELETE /api/blobs/:id`.
 *
 * There was no way to unmake an attachment at all before this, so the whole
 * surface is new. Two things it must get right: the write gate (deleting is a
 * write, so a Read-only vault refuses it exactly as it refuses an upload), and
 * the 409 — an attachment a note still embeds is not garbage, and the refusal
 * has to NAME the notes so the caller can go and look.
 */
const app = createApp(testAppDeps());

let owner: TestUser;
let orgId = "";
let vaultId = "";

async function seedBlob(relPath: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data)
     VALUES ($1, $2, $3, $4, 3, 'image/png', $5, 'x.png', 'postgres', 'ready',
             decode('000102','hex'))`,
    [id, vaultId, orgId, randomUUID().replace(/-/g, "") + "e".repeat(32), relPath],
  );
  return id;
}

async function seedRef(relPath: string): Promise<string> {
  const docId = randomUUID();
  await pool.query(
    "INSERT INTO blob_refs (vault_id, rel_path, doc_id) VALUES ($1, $2, $3)",
    [vaultId, relPath.toLowerCase(), docId],
  );
  return docId;
}

const del = (user: TestUser, id: string, query = "") =>
  app.fetch(
    new Request(`http://local/api/blobs/${id}${query}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${user.token}` },
    }),
  );

const exists = async (id: string) =>
  (await pool.query("SELECT 1 FROM blobs WHERE id = $1", [id])).rows.length === 1;

afterAll(async () => {
  await pool.end();
});

describe("DELETE /api/blobs/:id", () => {
  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner-${randomUUID().slice(0, 8)}@del.com`);
    orgId = await seedOrg("Del Co", `del-${randomUUID().slice(0, 8)}`);
    await seedMember(orgId, owner.userId, "owner");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
  });

  it("removes an unreferenced attachment", async () => {
    const id = await seedBlob("attachments/free.png");
    const res = await del(owner, id);
    expect(res.status).toBe(204);
    expect(await exists(id)).toBe(false);
  });

  it("refuses a referenced one and names the notes", async () => {
    const id = await seedBlob("attachments/used.png");
    const docA = await seedRef("attachments/used.png");
    const docB = await seedRef("Attachments/USED.png"); // same path, other case

    const res = await del(owner, id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; referencedBy: string[] };
    expect(body.code).toBe("blob_referenced");
    expect(body.referencedBy.sort()).toEqual([docA, docB].sort());
    expect(await exists(id)).toBe(true);
  });

  it("deletes a referenced one with ?force=1", async () => {
    const id = await seedBlob("attachments/used.png");
    await seedRef("attachments/used.png");
    expect((await del(owner, id, "?force=1")).status).toBe(204);
    expect(await exists(id)).toBe(false);
  });

  it("is 403 for a member of a read-only vault", async () => {
    const reader = await signUp(`reader-${randomUUID().slice(0, 8)}@del.com`);
    await seedMember(orgId, reader.userId, "member");
    // Read-only posture: the vault-wide grant is `view`, which caps everyone.
    await pool.query("DELETE FROM shares WHERE org_id = $1", [orgId]);
    await seedVaultGrant(orgId, "view");

    const id = await seedBlob("attachments/free.png");
    expect((await del(reader, id)).status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it("is 401 without a session and 404 for an unknown blob", async () => {
    const id = await seedBlob("attachments/free.png");
    const anon = await app.fetch(
      new Request(`http://local/api/blobs/${id}`, { method: "DELETE" }),
    );
    expect(anon.status).toBe(401);
    expect((await del(owner, randomUUID())).status).toBe(404);
  });
});
