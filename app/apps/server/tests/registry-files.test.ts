import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await pool.end();
});

/**
 * `POST /api/files` — the tree-binary half of the registry. A device registers
 * every binary it holds on every reconcile pass, so "already registered" is the
 * normal case, and a rename has to move the row rather than fork the doc.
 */
describe("registry file registration", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let folder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    // Fresh identity per test: Better Auth keeps state keyed on the account, and
    // re-signing-up the same address across a truncate is how you get a member
    // row pointing at a user that no longer exists.
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@files.registry.test`);
    org = (await createOrg(owner, "Files Reg", `files-reg-${tag}`)).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    folder = await seedFolder(vault, null, "Team", "Team", owner.userId);
  });

  it("adopts a client-supplied id and is idempotent on a repeat", async () => {
    const id = randomUUID();
    const first = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "Team/q3.xlsx",
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id, docId: id, folderId: folder });

    const again = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "Team/q3.xlsx",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, path: "Team/q3.xlsx" });

    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("treats the same id at a new path as a move, keeping the doc", async () => {
    const id = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: id, path: "Team/q3.xlsx" });
    const moved = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "q3.xlsx",
    });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id, folderId: null, path: "q3.xlsx" });

    const { rows } = await pool.query<{ id: string; path: string; folder_id: string | null }>(
      "SELECT id, path, folder_id FROM files WHERE vault_id = $1",
      [vault],
    );
    expect(rows).toEqual([{ id, path: "q3.xlsx", folder_id: null }]);
  });

  it("a second device with its own id adopts the incumbent rather than forking", async () => {
    const mine = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: mine, path: "Team/logo.svg" });

    const exact = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "Team/logo.svg",
    });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ id: mine, docId: mine, path: "Team/logo.svg" });

    const variant = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "team/logo.svg", // case-variant: the same file on macOS
    });
    expect(variant.status).toBe(200);
    // The row's CANONICAL spelling comes back, so the second device stops
    // re-registering its own on every pass.
    expect(await variant.json()).toMatchObject({ id: mine, path: "Team/logo.svg" });

    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("adopts even when this device has not registered the folder yet", async () => {
    // The adoption lookup runs before `resolveParentFolder`, which throws for a
    // folder the server does not know. A device a pass behind on the folder map
    // must still converge on the incumbent id rather than earn a 400.
    const mine = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: mine, path: "Team/deck.pptx" });
    await pool.query("UPDATE folders SET path = 'Team2', name = 'Team2' WHERE id = $1", [folder]);

    const res = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "Team/deck.pptx",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: mine });
  });

  it("a move onto an occupied path adopts the incumbent instead of forking", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: a, path: "Team/a.png" });
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: b, path: "Team/b.png" });

    const clash = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: b,
      path: "Team/a.png",
    });
    expect(clash.status).toBe(200);
    expect(await clash.json()).toMatchObject({ id: a, docId: a });
    // Two rows still, each where it was: the path is not stolen from `a`.
    const { rows } = await pool.query<{ id: string; path: string }>(
      "SELECT id, path FROM files WHERE vault_id = $1 ORDER BY path",
      [vault],
    );
    expect(rows).toEqual([
      { id: a, path: "Team/a.png" },
      { id: b, path: "Team/b.png" },
    ]);
  });
});

/**
 * What a folder move and a folder delete do to the BINARIES underneath them.
 * Both used to ignore `files` entirely, and both lost data by doing so.
 */
describe("files under a folder that moves or is deleted", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let folder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@files.tree.test`);
    org = (await createOrg(owner, "Files Tree", `files-tree-${tag}`)).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    folder = await seedFolder(vault, null, "Alpha", "Alpha", owner.userId);
  });

  /** Register a file and give it a blob row at the same path. */
  async function seedFileWithBlob(path: string): Promise<{ docId: string; blobId: string }> {
    const docId = randomUUID();
    const res = await req(owner, "POST", "/api/files", { vaultId: vault, docId, path });
    expect(res.status).toBe(201);
    const blobId = randomUUID();
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, doc_id, sha256, size, mime, rel_path, filename,
                          storage_provider, status, data)
       VALUES ($1, $2, $3, $4, $5, 3, 'application/pdf', $6, 'f.pdf', 'postgres', 'ready',
               decode('000102','hex'))`,
      [blobId, vault, org, docId, randomUUID().replace(/-/g, "") + "9".repeat(32), path],
    );
    return { docId, blobId };
  }

  it("rewrites files.path and blobs.rel_path when the folder is renamed", async () => {
    const { docId, blobId } = await seedFileWithBlob("Alpha/spec.pdf");

    const moved = await req(owner, "PATCH", `/api/folders/${folder}`, { name: "Beta" });
    expect(moved.status).toBe(200);

    // Without this, `files.folder_id` pointed at the moved folder while
    // `files.path` still spelled `Alpha/` — the exact disagreement
    // `resolveParentFolder` refuses with 400 `path_folder_mismatch` — and
    // `GET /vaults/:id/blobs` kept advertising the OLD path, so the desktop's
    // attachment diff re-downloaded the binary into a RESURRECTED `Alpha/`.
    const file = await pool.query<{ path: string }>("SELECT path FROM files WHERE id = $1", [docId]);
    expect(file.rows[0]?.path).toBe("Beta/spec.pdf");
    const blob = await pool.query<{ rel_path: string }>(
      "SELECT rel_path FROM blobs WHERE id = $1",
      [blobId],
    );
    expect(blob.rows[0]?.rel_path).toBe("Beta/spec.pdf");
  });

  it("never rewrites an attachments/ blob, which lives outside the tree", async () => {
    const attachment = randomUUID();
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                          storage_provider, status, data)
       VALUES ($1, $2, $3, $4, 3, 'image/png', 'attachments/pic.png', 'pic.png',
               'postgres', 'ready', decode('000102','hex'))`,
      [attachment, vault, org, randomUUID().replace(/-/g, "") + "8".repeat(32)],
    );
    await req(owner, "PATCH", `/api/folders/${folder}`, { name: "Beta" });
    const { rows } = await pool.query<{ rel_path: string }>(
      "SELECT rel_path FROM blobs WHERE id = $1",
      [attachment],
    );
    expect(rows[0]?.rel_path).toBe("attachments/pic.png");
  });

  it("takes files, their bytes and a tombstone with the folder it deletes", async () => {
    const { docId, blobId } = await seedFileWithBlob("Alpha/spec.pdf");

    const del = await req(owner, "DELETE", `/api/folders/${folder}`);
    expect([200, 204]).toContain(del.status);

    // The row is gone: left behind, a vault-wide member re-downloaded it and
    // RECREATED the folder on their next pull.
    expect(
      (await pool.query("SELECT 1 FROM files WHERE id = $1", [docId])).rowCount,
    ).toBe(0);
    // And so are the bytes.
    expect(
      (await pool.query("SELECT 1 FROM blobs WHERE id = $1", [blobId])).rowCount,
    ).toBe(0);
    // The tombstone is what makes this a DELETION rather than a revocation: a
    // share-only member whose file merely left the readable set has it removed
    // outright, with no `.context/trash` copy.
    const tomb = await pool.query<{ path: string }>(
      "SELECT path FROM file_tombstones WHERE id = $1",
      [docId],
    );
    expect(tomb.rows[0]?.path).toBe("Alpha/spec.pdf");
  });

  it("counts files when asking whether a folder is empty", async () => {
    const { folderIsEmpty } = await import("../src/registry/tree-ops.js");
    expect(await folderIsEmpty(pool, folder)).toBe(true);
    await seedFileWithBlob("Alpha/spec.pdf");
    // MCP's `delete_folder` consults this before refusing a non-recursive
    // delete; a folder holding nothing but PDFs used to answer "empty".
    expect(await folderIsEmpty(pool, folder)).toBe(false);
  });
});
