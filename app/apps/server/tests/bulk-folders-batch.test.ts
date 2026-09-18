import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { freezeVaultRoot, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import type { FileBatchResult, FolderBatchResult } from "../src/http/routes/bulk-types.js";

/**
 * `POST /api/vaults/:id/folders/batch` and `/files/batch`.
 *
 * The folder route's whole reason to exist is the depth sort: the client used to
 * create folders level by level, one `runPool` wave per depth, because it had to
 * know a parent's id before it could send the child. Sending `path` and letting
 * the server order the batch deletes that loop entirely — so the first test here
 * sends a tree DEEPEST-FIRST and expects it to come out right anyway.
 */

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

describe("folders + files batch registration", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@folders.test");
    org = (await createOrg(owner, "Folder Co", "folder-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  const folderBatch = async (items: unknown[]) => {
    const res = await req(owner, "POST", `/api/vaults/${vault}/folders/batch`, { items });
    return { status: res.status, body: (await res.json()) as { results: FolderBatchResult[]; code?: string } };
  };

  it("resolves parents in-request from a DEEPEST-FIRST batch", async () => {
    const { body } = await folderBatch([
      { path: "a/b/c/d", name: "d" },
      { path: "a/b", name: "b" },
      { path: "a/b/c", name: "c" },
      { path: "a", name: "a" },
    ]);
    // Results come back in the CALLER's order, whatever order the server ran them.
    expect(body.results.map((r) => [r.path, r.status])).toEqual([
      ["a/b/c/d", "created"],
      ["a/b", "created"],
      ["a/b/c", "created"],
      ["a", "created"],
    ]);
    const { rows } = await pool.query<{ path: string; parent: string | null }>(
      `SELECT f.path, p.path AS parent FROM folders f
         LEFT JOIN folders p ON p.id = f.parent_id
        WHERE f.vault_id = $1 ORDER BY f.path`,
      [vault],
    );
    expect(rows).toEqual([
      { path: "a", parent: null },
      { path: "a/b", parent: "a" },
      { path: "a/b/c", parent: "a/b" },
      { path: "a/b/c/d", parent: "a/b/c" },
    ]);
    expect(rec.registryBroadcasts.length).toBe(1);
  });

  it("is idempotent: a re-send adopts every row and broadcasts nothing", async () => {
    const items = [
      { path: "a", name: "a" },
      { path: "a/b", name: "b" },
    ];
    const first = await folderBatch(items);
    rec.reset();
    const again = await folderBatch(items);
    expect(again.body.results.map((r) => r.status)).toEqual(["adopted", "adopted"]);
    expect(again.body.results.map((r) => r.id)).toEqual(first.body.results.map((r) => r.id));
    expect(rec.registryBroadcasts.length).toBe(0);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM folders WHERE vault_id = $1", [vault]);
    expect(rows[0].n).toBe(2);
  });

  it("adopts a case-variant folder path and echoes the canonical spelling", async () => {
    await folderBatch([{ path: "Projects", name: "Projects" }]);
    const { body } = await folderBatch([{ path: "projects", name: "projects" }]);
    expect(body.results[0].status).toBe("adopted");
    expect(body.results[0].path).toBe("Projects");
  });

  it("reports an unresolvable parent per item and keeps the rest", async () => {
    const { body } = await folderBatch([
      { path: "ok", name: "ok" },
      { path: "ghost/child", name: "child" },
    ]);
    expect(body.results[0].status).toBe("created");
    expect(body.results[1]).toMatchObject({ status: "error", code: "path_folder_mismatch" });
  });

  it("applies the frozen-root latch to new root folders only", async () => {
    await folderBatch([{ path: "existing", name: "existing" }]);
    await freezeVaultRoot(vault);
    const { body } = await folderBatch([
      { path: "fresh", name: "fresh" },
      { path: "existing/child", name: "child" },
      { path: "existing", name: "existing" },
    ]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "root_frozen" });
    expect(body.results[1].status).toBe("created");
    // A folder that predates the latch still reconciles from every device.
    expect(body.results[2].status).toBe("adopted");
  });

  it("refuses an over-long folder batch as a request", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ path: `f${i}`, name: `f${i}` }));
    const { status, body } = await folderBatch(items);
    expect(status).toBe(400);
    expect(body.code).toBe("batch_too_large");
  });

  it("registers files in bulk, adopting on re-send and carrying sha/size/mime harmlessly", async () => {
    await folderBatch([{ path: "Assets", name: "Assets" }]);
    const send = async () => {
      const res = await req(owner, "POST", `/api/vaults/${vault}/files/batch`, {
        items: [
          { relPath: "Assets/a.pdf", sha256: "a".repeat(64), size: 10, mime: "application/pdf" },
          { relPath: "b.png", sha256: "b".repeat(64), size: 3, mime: "image/png" },
        ],
      });
      return (await res.json()) as { results: FileBatchResult[] };
    };
    const first = await send();
    expect(first.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(first.results[0].folderId).not.toBeNull();
    const again = await send();
    expect(again.results.map((r) => r.status)).toEqual(["adopted", "adopted"]);
    expect(again.results.map((r) => r.fileId)).toEqual(first.results.map((r) => r.fileId));
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM files WHERE vault_id = $1", [vault]);
    expect(rows[0].n).toBe(2);
  });

  it("a file re-registered at a new path MOVES rather than forking a second row", async () => {
    const fileId = randomUUID();
    await req(owner, "POST", `/api/vaults/${vault}/files/batch`, {
      items: [{ relPath: "old.pdf", fileId, sha256: "c".repeat(64), size: 1, mime: null }],
    });
    const res = await req(owner, "POST", `/api/vaults/${vault}/files/batch`, {
      items: [{ relPath: "new.pdf", fileId, sha256: "c".repeat(64), size: 1, mime: null }],
    });
    const body = (await res.json()) as { results: FileBatchResult[] };
    expect(body.results[0]).toMatchObject({ status: "adopted", fileId, relPath: "new.pdf" });
    const { rows } = await pool.query("SELECT path FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toEqual([{ path: "new.pdf" }]);
  });
});
