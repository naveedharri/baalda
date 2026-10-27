import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedOrg, seedShare, seedVault } from "./helpers/seed.js";

/**
 * #343: an attachment copied into a folder of the vault.
 *
 * The copy is a tree file with the SAME bytes as an `attachments/` drop. Its
 * upload used to dedupe onto the drop's row and ADOPT it (the row kept its
 * `attachments/` path but now named the file), so superseding or deleting the
 * file deleted the attachment's row too. Every device holding the attachment
 * then found its hash missing from the list and sent the bytes again, while
 * the GC deleted the object behind them: an upload loop. The file must get a
 * row of its own and the attachment's row must outlive it.
 */
const app = createApp(testAppDeps());

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PNG2 = Buffer.concat([PNG, Buffer.from([0x01, 0x02])]);
const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Intent {
  blobId?: string;
  deduped?: boolean;
  blob?: { id: string };
  upload?: { url: string; headers: Record<string, string> };
}

function call(user: TestUser, method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function upload(
  user: TestUser,
  vaultId: string,
  bytes: Buffer,
  relPath: string,
  docId: string | null = null,
  baseSha: string | null = null,
): Promise<Intent> {
  const res = await call(user, "POST", `/api/vaults/${vaultId}/blobs/intent`, {
    sha256: shaOf(bytes),
    size: bytes.byteLength,
    mime: "image/png",
    relPath,
    ...(docId ? { docId } : {}),
    ...(baseSha ? { baseSha } : {}),
  });
  expect(res.status).toBe(200);
  const plan = (await res.json()) as Intent;
  if (plan.deduped) return plan;
  const put = await app.fetch(
    new Request(plan.upload!.url.replace(/^https?:\/\/[^/]+/, "http://local"), {
      method: "PUT",
      headers: plan.upload!.headers,
      body: bytes,
    }),
  );
  expect(put.status).toBe(204);
  const done = await call(user, "POST", `/api/blobs/${plan.blobId}/complete`, {});
  expect(done.status).toBe(200);
  return plan;
}

async function attachmentRows(vaultId: string) {
  return (
    await pool.query<{ id: string; doc_id: string | null }>(
      "SELECT id, doc_id FROM blobs WHERE vault_id = $1 AND rel_path = 'attachments/pic.png'",
      [vaultId],
    )
  ).rows;
}

async function bytesOf(blobId: string): Promise<Buffer | null> {
  return (await pool.query<{ data: Buffer | null }>("SELECT data FROM blobs WHERE id = $1", [blobId]))
    .rows[0]?.data ?? null;
}

afterAll(async () => {
  await pool.end();
});

describe("an attachment copied into a folder (#343)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setup() {
    const owner = await signUp("owner@copy343.com");
    const member = await signUp("member@copy343.com");
    const org = await seedOrg("Acme", "copy343");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);
    // Scoped member: no vault-wide grant, edit on one folder only.
    const folder = await seedFolder(vault, null, "Projects", "Projects", owner.userId);
    await seedShare(org, "folder", folder, member.userId, "edit");
    return { owner, member, vault };
  }

  async function copyIntoFolder(member: TestUser, vault: string): Promise<Intent> {
    const reg = await call(member, "POST", "/api/files", {
      vaultId: vault,
      docId: "file-copy",
      path: "Projects/pic.png",
    });
    expect(reg.status).toBeLessThan(300);
    return upload(member, vault, PNG, "Projects/pic.png", "file-copy");
  }

  it("keeps the attachment's row when the copy is superseded", async () => {
    const { owner, member, vault } = await setup();
    const drop = await upload(owner, vault, PNG, "attachments/pic.png");

    const copy = await copyIntoFolder(member, vault);
    // Same bytes: nothing moves, but the copy is NOT the attachment's row.
    expect(copy.deduped).toBe(true);
    expect(copy.blob?.id).not.toBe(drop.blobId);
    expect(await attachmentRows(vault)).toEqual([{ id: drop.blobId, doc_id: null }]);

    // The copy is edited: its new version retires its old one.
    await upload(member, vault, PNG2, "Projects/pic.png", "file-copy", shaOf(PNG));

    expect(await attachmentRows(vault)).toEqual([{ id: drop.blobId, doc_id: null }]);
    const again = (await (
      await call(owner, "POST", `/api/vaults/${vault}/blobs/intent`, {
        sha256: shaOf(PNG),
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/pic.png",
      })
    ).json()) as Intent;
    expect(again.deduped).toBe(true);
    expect(again.blob?.id).toBe(drop.blobId);
    // The attachment still holds its bytes: the copy shared content, not the row.
    expect(await bytesOf(drop.blobId!)).toEqual(PNG);
  });

  it("keeps the attachment's row when the copy is deleted", async () => {
    const { owner, member, vault } = await setup();
    const drop = await upload(owner, vault, PNG, "attachments/pic.png");
    await copyIntoFolder(member, vault);

    const del = await call(member, "DELETE", "/api/files/file-copy");
    expect(del.status).toBeLessThan(300);

    expect(await attachmentRows(vault)).toEqual([{ id: drop.blobId, doc_id: null }]);
    expect(await bytesOf(drop.blobId!)).toEqual(PNG);
  });
});
