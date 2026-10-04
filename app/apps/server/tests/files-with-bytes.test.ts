import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedBlob, seedFolder, seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * One-step file upload (`files-with-bytes`, migration 048).
 *
 * The intent carries `register: { docId, relPath, folderId? }`; every gate that
 * decides whether the `files` row may exist runs at intent, and the row itself
 * appears only when the bytes do — at `complete`, or at the intent on a dedupe
 * hit. A refusal at any gate leaves neither a `files` row nor a blob row.
 */
const app = createApp(testAppDeps());

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface IntentBody {
  blobId?: string;
  deduped?: boolean;
  blob?: { id: string; sha256: string; docId: string | null };
  upload?: { url: string; headers: Record<string, string> };
  completeUrl?: string;
  file?: { id: string; docId: string; folderId: string | null; path: string; status: string };
  code?: string;
}

async function setup(slug: string) {
  const owner = await signUp(`owner@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner.userId, "owner");
  const vault = await seedVault(org);
  await seedVaultGrant(org, "edit");
  return { owner, org, vault };
}

function post(user: TestUser, path: string, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://local/api${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const intent = (user: TestUser, vaultId: string, body: Record<string, unknown>) =>
  post(user, `/vaults/${vaultId}/blobs/intent`, body);
const complete = (user: TestUser, id: string) => post(user, `/blobs/${id}/complete`, {});

function putData(url: string, bytes: Buffer, headers: Record<string, string>) {
  return app.fetch(
    new Request(url.replace(/^https?:\/\/[^/]+/, "http://local"), {
      method: "PUT",
      headers,
      body: bytes,
    }),
  );
}

async function fileRows(vaultId: string) {
  const { rows } = await pool.query<{ id: string; path: string; folder_id: string | null }>(
    "SELECT id, path, folder_id FROM files WHERE vault_id = $1 ORDER BY path",
    [vaultId],
  );
  return rows;
}

async function blobRows(vaultId: string) {
  const { rows } = await pool.query<{
    id: string;
    status: string;
    doc_id: string | null;
    pending_register: unknown;
  }>("SELECT id, status, doc_id, pending_register FROM blobs WHERE vault_id = $1", [vaultId]);
  return rows;
}

const pngIntent = (docId: string, relPath: string, folderId: string | null = null) => ({
  sha256: shaOf(PNG),
  size: PNG.length,
  mime: "image/png",
  filename: relPath.split("/").pop(),
  register: { docId, relPath, folderId },
});

afterAll(async () => {
  await pool.end();
});

describe("one-step file upload (files-with-bytes)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  it("creates the files row only at complete, in the same step that publishes the bytes", async () => {
    const { owner, vault } = await setup("onestep");
    const folder = await seedFolder(vault, null, "Team", "Team", owner.userId);
    const docId = randomUUID();

    const res = await intent(owner, vault, pngIntent(docId, "Team/logo.png", folder));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IntentBody;
    expect(body.deduped).toBeUndefined();
    expect(body.file).toMatchObject({ id: docId, path: "Team/logo.png", folderId: folder, status: "pending" });

    // Nothing registered yet: the row waits on the bytes.
    expect(await fileRows(vault)).toEqual([]);
    const pending = await blobRows(vault);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].pending_register).toMatchObject({ docId, relPath: "Team/logo.png", folderId: folder });

    expect((await putData(body.upload!.url, PNG, body.upload!.headers)).status).toBeLessThan(300);
    const done = await complete(owner, body.blobId!);
    expect(done.status).toBe(200);
    const meta = (await done.json()) as { docId: string; file: { id: string; status: string } };
    expect(meta.docId).toBe(docId);
    expect(meta.file).toMatchObject({ id: docId, status: "created" });

    expect(await fileRows(vault)).toEqual([{ id: docId, path: "Team/logo.png", folder_id: folder }]);
    const ready = await blobRows(vault);
    expect(ready).toEqual([
      expect.objectContaining({ status: "ready", doc_id: docId, pending_register: null }),
    ]);

    // A retried complete is the same answer, and still one row.
    expect((await complete(owner, body.blobId!)).status).toBe(200);
    expect(await fileRows(vault)).toHaveLength(1);
  });

  it("a dedupe hit creates the files row in the intent's own response", async () => {
    const { owner, org, vault } = await setup("onestep-dedupe");
    // The bytes are already here as an attachments/ drop with no doc.
    await seedBlob(vault, org, "attachments/logo.png", {
      sha256: shaOf(PNG),
      mime: "image/png",
      size: PNG.length,
    });
    const docId = randomUUID();

    const res = await intent(owner, vault, pngIntent(docId, "logo.png"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IntentBody;
    expect(body.deduped).toBe(true);
    expect(body.file).toMatchObject({ id: docId, path: "logo.png", status: "created" });
    expect(body.blob?.docId).toBe(docId);
    expect(await fileRows(vault)).toEqual([{ id: docId, path: "logo.png", folder_id: null }]);
  });

  it("a Free vault is refused at intent and nothing is left behind", async () => {
    const { owner, vault } = await setup("onestep-free");
    process.env.POLAR_ACCESS_TOKEN = "test-token";

    const res = await intent(owner, vault, pngIntent(randomUUID(), "logo.png"));
    expect(res.status).toBe(402);
    expect(((await res.json()) as IntentBody).code).toBe("attachment_sync_requires_pro");
    expect(await fileRows(vault)).toEqual([]);
    expect(await blobRows(vault)).toEqual([]);
  });

  it("a caller who may not create in the folder is refused at intent with nothing written", async () => {
    const { org, vault } = await setup("onestep-acl");
    // Read-only vault posture: a plain member may view, not create.
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedVaultGrant(org, "view");
    const member = await signUp("member@onestep-acl.com");
    await seedMember(org, member.userId, "member");

    const res = await intent(member, vault, pngIntent(randomUUID(), "logo.png"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as IntentBody).code).toBe("no_write_access");
    expect(await fileRows(vault)).toEqual([]);
    expect(await blobRows(vault)).toEqual([]);
  });

  it("a path that disagrees with its folder is refused at intent with nothing written", async () => {
    const { owner, vault } = await setup("onestep-mismatch");
    const folder = await seedFolder(vault, null, "Team", "Team", owner.userId);

    const res = await intent(owner, vault, pngIntent(randomUUID(), "Other/logo.png", folder));
    expect(res.status).toBe(400);
    expect(((await res.json()) as IntentBody).code).toBe("path_folder_mismatch");
    expect(await fileRows(vault)).toEqual([]);
    expect(await blobRows(vault)).toEqual([]);
  });

  it("leaves the old register → intent → PUT → complete flow unchanged", async () => {
    const { owner, vault } = await setup("onestep-legacy");
    const docId = randomUUID();

    const reg = await post(owner, "/files", { vaultId: vault, path: "logo.png", docId });
    expect(reg.status).toBe(201);
    expect(await fileRows(vault)).toHaveLength(1);

    const res = await intent(owner, vault, {
      sha256: shaOf(PNG),
      size: PNG.length,
      mime: "image/png",
      filename: "logo.png",
      docId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as IntentBody;
    expect(body.file).toBeUndefined();
    expect((await putData(body.upload!.url, PNG, body.upload!.headers)).status).toBeLessThan(300);
    const done = await complete(owner, body.blobId!);
    expect(done.status).toBe(200);
    const meta = (await done.json()) as Record<string, unknown>;
    expect(meta.docId).toBe(docId);
    expect(meta.file).toBeUndefined();
    expect(await blobRows(vault)).toEqual([
      expect.objectContaining({ status: "ready", doc_id: docId, pending_register: null }),
    ]);
  });

  it("GET /health lists files-with-bytes", async () => {
    const res = await app.fetch(new Request("http://local/health"));
    const body = (await res.json()) as { features: string[] };
    expect(body.features).toContain("files-with-bytes");
  });
});
