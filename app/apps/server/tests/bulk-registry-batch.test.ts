import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  freezeVaultRoot,
  seedFolder,
  seedMember,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import type { NoteBatchResult } from "../src/http/routes/bulk-types.js";

/**
 * `POST /api/vaults/:id/notes/batch` — the batched twin of `POST /api/notes`.
 *
 * The property that matters is not "it is fast": it is that a batch and N single
 * calls are the SAME write. They share `registry/batch-ops.ts registerNote`, and
 * the last test here holds them to producing identical rows and identical
 * refusal codes, because the moment they can disagree the client has two
 * different servers to reason about.
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

async function noteBatch(user: TestUser, vault: string, items: unknown[]) {
  const res = await req(user, "POST", `/api/vaults/${vault}/notes/batch`, { items });
  return { status: res.status, body: (await res.json()) as { results: NoteBatchResult[]; code?: string } };
}

describe("notes batch registration", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@bulk.test");
    org = (await createOrg(owner, "Bulk Co", "bulk-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creates every item, echoes the canonical path, and broadcasts ONCE", async () => {
    await seedFolder(vault, null, "Docs", "Docs");
    const { status, body } = await noteBatch(owner, vault, [
      { relPath: "a.md", title: "A" },
      { relPath: "Docs/b.md", title: "B" },
      { relPath: "Docs/c.md" },
    ]);
    expect(status).toBe(200);
    expect(body.results.map((r) => r.status)).toEqual(["created", "created", "created"]);
    expect(body.results.map((r) => r.relPath)).toEqual(["a.md", "Docs/b.md", "Docs/c.md"]);
    expect(body.results[1].folderId).not.toBeNull();
    expect(body.results[0].folderId).toBeNull();
    // 3 rows, 1 broadcast: per-item broadcasts would cost a per-subscriber ACL
    // recompute each for one logical change.
    expect(rec.registryBroadcasts.length).toBe(1);
    const { rows } = await pool.query("SELECT rel_path FROM notes WHERE vault_id = $1 ORDER BY rel_path", [vault]);
    expect(rows.map((r) => r.rel_path)).toEqual(["Docs/b.md", "Docs/c.md", "a.md"]);
  });

  it("re-sending the same batch adopts and writes nothing new", async () => {
    const items = [{ relPath: "a.md" }, { relPath: "b.md" }];
    const first = await noteBatch(owner, vault, items);
    rec.reset();
    const second = await noteBatch(owner, vault, items);
    expect(second.body.results.map((r) => r.status)).toEqual(["adopted", "adopted"]);
    expect(second.body.results.map((r) => r.docId)).toEqual(first.body.results.map((r) => r.docId));
    // Nothing changed, so nobody is told to re-pull.
    expect(rec.registryBroadcasts.length).toBe(0);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM notes WHERE vault_id = $1", [vault]);
    expect(rows[0].n).toBe(2);
  });

  // The 2026-09-04 runaway: a case-variant path is the SAME FILE on macOS and
  // Windows, and storing both forks one file across two doc_ids forever.
  it("adopts a case-variant path and echoes the row's canonical spelling", async () => {
    const first = await noteBatch(owner, vault, [{ relPath: "Daily/x.md", folderPath: "Daily" }]);
    // No folder yet ⇒ mismatch, which is its own contract; create it and retry.
    expect(first.body.results[0].code).toBe("path_folder_mismatch");
    await seedFolder(vault, null, "Daily", "Daily");
    const created = await noteBatch(owner, vault, [{ relPath: "Daily/Note.md" }]);
    const variant = await noteBatch(owner, vault, [{ relPath: "daily/note.MD", docId: randomUUID() }]);
    expect(variant.body.results[0].status).toBe("adopted");
    expect(variant.body.results[0].docId).toBe(created.body.results[0].docId);
    expect(variant.body.results[0].relPath).toBe("Daily/Note.md");
  });

  // `relPath` places the note; `folderPath` only has to AGREE with it. A client
  // whose two fields contradict each other is the 2026-08-27 phantom-root-folder.
  it("refuses an item whose folderPath contradicts its relPath", async () => {
    await seedFolder(vault, null, "Docs", "Docs");
    const { body } = await noteBatch(owner, vault, [
      { relPath: "Docs/ok.md", folderPath: "Docs" },
      { relPath: "Docs/bad.md", folderPath: "Elsewhere" },
      { relPath: "root.md", folderPath: null },
      { relPath: "Docs/case.md", folderPath: "docs" }, // case-variant ⇒ agrees
    ]);
    expect(body.results.map((r) => r.status)).toEqual(["created", "error", "created", "created"]);
    expect(body.results[1].code).toBe("path_folder_mismatch");
  });

  it("reports a doc_id that belongs to another vault as a per-item conflict", async () => {
    const other = await seedVault(org, "Other");
    const docId = randomUUID();
    await noteBatch(owner, other, [{ relPath: "a.md", docId }]);
    const { body } = await noteBatch(owner, vault, [
      { relPath: "keep.md" },
      { relPath: "a.md", docId },
    ]);
    expect(body.results[0].status).toBe("created");
    expect(body.results[1].status).toBe("conflict");
    expect(body.results[1].code).toBe("doc_id_conflict");
    // The conflict is per ITEM: the good one still landed.
    const { rows } = await pool.query("SELECT rel_path FROM notes WHERE vault_id = $1", [vault]);
    expect(rows.map((r) => r.rel_path)).toEqual(["keep.md"]);
  });

  // Prod 2026-09-23: a device holding an unconfirmed local copy of a note a
  // teammate deleted re-registered it under the same id every pass. The server
  // answered "created" (deleted_at untouched) and broadcast `registry-changed`
  // to the whole vault each time.
  it("refuses a soft-deleted doc_id as note_deleted, writes nothing, broadcasts nothing", async () => {
    const docId = randomUUID();
    await noteBatch(owner, vault, [{ relPath: "gone.md", docId }]);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [docId]);
    rec.reset();
    const { body } = await noteBatch(owner, vault, [
      { relPath: "gone.md", docId },
      { relPath: "moved/elsewhere.md", docId, folderPath: null },
    ]);
    expect(body.results[0].status).toBe("conflict");
    expect(body.results[0].code).toBe("note_deleted");
    expect(body.results[0].docId).toBe(docId);
    expect(rec.registryBroadcasts.length).toBe(0);
    const { rows } = await pool.query(
      "SELECT rel_path, deleted_at IS NOT NULL AS dead FROM notes WHERE id = $1",
      [docId],
    );
    expect(rows).toEqual([{ rel_path: "gone.md", dead: true }]);

    // The single-item route is the same code: 409 with the same code, no broadcast.
    const res = await req(owner, "POST", "/api/notes", { vaultId: vault, relPath: "gone.md", docId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("note_deleted");
    expect(rec.registryBroadcasts.length).toBe(0);

    // A NEW id at the dead path is still an ordinary create.
    const fresh = await noteBatch(owner, vault, [{ relPath: "gone.md" }]);
    expect(fresh.body.results[0].status).toBe("created");
    expect(fresh.body.results[0].docId).not.toBe(docId);
  });

  it("refuses new ROOT notes at a frozen root, per item, and still takes nested ones", async () => {
    await seedFolder(vault, null, "Docs", "Docs");
    await freezeVaultRoot(vault);
    const { body } = await noteBatch(owner, vault, [
      { relPath: "root.md" },
      { relPath: "Docs/ok.md" },
    ]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "root_frozen" });
    expect(body.results[1].status).toBe("created");
  });

  it("refuses a member with no write access, per item", async () => {
    const reader = await signUp("reader@bulk.test");
    await seedMember(org, reader.userId, "member");
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedVaultGrant(org, "view"); // Read-only posture
    const { body } = await noteBatch(reader, vault, [{ relPath: "nope.md" }]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "no_write_access" });
  });

  it("refuses an over-long batch as a request, not per item", async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ relPath: `n${i}.md` }));
    const { status, body } = await noteBatch(owner, vault, items);
    expect(status).toBe(400);
    expect(body.code).toBe("batch_too_large");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM notes WHERE vault_id = $1", [vault]);
    expect(rows[0].n).toBe(0);
  });

  it("gates like every other vault route: 401 / 404 unknown_vault / 403 not_a_member", async () => {
    const anon = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/notes/batch`, {
        method: "POST",
        body: JSON.stringify({ items: [] }),
      }),
    );
    expect(anon.status).toBe(401);
    const unknown = await req(owner, "POST", `/api/vaults/${randomUUID()}/notes/batch`, { items: [] });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("unknown_vault");
    const stranger = await signUp("stranger@bulk.test");
    const forbidden = await req(stranger, "POST", `/api/vaults/${vault}/notes/batch`, { items: [] });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("not_a_member");
  });

  /**
   * The lockstep property. Two vaults, the same inputs, one served by the batch
   * route and one by N single `POST /api/notes` calls — identical rows and
   * identical codes. This is the test that makes `registry/batch-ops.ts` worth
   * having; if it ever fails, the two surfaces have grown apart.
   */
  it("a batch and N single calls produce identical rows and identical codes", async () => {
    const vaultA = await seedVault(org, "A");
    const vaultB = await seedVault(org, "B");
    for (const v of [vaultA, vaultB]) await seedFolder(v, null, "Docs", "Docs");
    // A doc_id per VAULT: reusing one across both would make the second run's
    // id "already in another vault", which is a different test.
    const inputs = (dupId: string) => [
      { relPath: "a.md", title: "A" },
      { relPath: "Docs/b.md", title: "B" },
      { relPath: "A.md" }, // case-variant of the first ⇒ adopt
      { relPath: "Missing/c.md" }, // no such folder ⇒ path_folder_mismatch
      { relPath: "d.md", docId: dupId },
      { relPath: "e.md", docId: dupId }, // same id twice ⇒ adopt at d.md's path
    ];

    const batched = await noteBatch(owner, vaultA, inputs(randomUUID()));

    const singles: NoteBatchResult[] = [];
    for (const input of inputs(randomUUID())) {
      const res = await req(owner, "POST", "/api/notes", { vaultId: vaultB, ...input });
      const b = (await res.json()) as Record<string, unknown>;
      singles.push({
        relPath: (b.relPath as string) ?? input.relPath,
        docId: (b.docId as string) ?? null,
        status:
          res.status === 201 ? "created" : res.status === 200 ? "adopted" : res.status === 409 ? "conflict" : "error",
        folderId: (b.folderId as string | null) ?? null,
        title: (b.title as string | null) ?? null,
        code: (b.code as string) ?? null,
        error: null,
      });
    }

    // Statuses, codes and canonical paths match item for item…
    expect(batched.body.results.map((r) => [r.status, r.code, r.relPath])).toEqual(
      singles.map((r) => [r.status, r.code, r.relPath]),
    );
    // …and so does what actually landed in Postgres.
    const rowsOf = async (v: string) =>
      (
        await pool.query(
          "SELECT rel_path, title, (folder_id IS NULL) AS at_root FROM notes WHERE vault_id = $1 ORDER BY rel_path",
          [v],
        )
      ).rows;
    expect(await rowsOf(vaultA)).toEqual(await rowsOf(vaultB));
  });
});
