import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { indexDoc } from "../src/index/indexer.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import type { NoteDeleteResult } from "../src/http/routes/bulk-types.js";

/**
 * `POST /api/vaults/:id/notes/delete-batch` — the batched twin of
 * `DELETE /api/notes/:id`.
 *
 * Same property as the registration batch: it is not "a faster delete", it is
 * the SAME delete without a request per item. 500 sidebar deletes were 500
 * requests, each re-resolving the whole permission algebra and each broadcasting
 * a `registry-changed` the entire vault re-pulled on. The drift test below is
 * what keeps the two routes from becoming two different servers.
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

async function deleteBatch(user: TestUser, vault: string, docIds: unknown[]) {
  const res = await req(user, "POST", `/api/vaults/${vault}/notes/delete-batch`, { docIds });
  return { status: res.status, body: (await res.json()) as { results: NoteDeleteResult[]; code?: string } };
}

describe("notes delete batch", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@del.test");
    org = (await createOrg(owner, "Del Co", "del-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  /**
   * The lockstep property, exactly as `bulk-registry-batch.test.ts` states it
   * for registration: two vaults, the same ids, one served by the batch route
   * and one by N single `DELETE /api/notes/:id` calls — identical rows,
   * identical tombstones, identical codes.
   */
  it("a batch and N single calls produce identical rows and identical codes", async () => {
    const mk = async () => {
      const v = await seedVault(org, `V${randomUUID().slice(0, 6)}`);
      const folder = await seedFolder(v, null, "Docs", "Docs", owner.userId);
      const ids = [
        await seedNote(v, null, "a.md", owner.userId),
        await seedNote(v, folder, "Docs/b.md", owner.userId),
        await seedNote(v, folder, "Docs/c.md", owner.userId),
      ];
      // A derived index row per note, so the purge half is observable.
      for (const id of ids) await indexDoc(id);
      // Plus two ids that must be refused: one already deleted, one unknown.
      const gone = await seedNote(v, null, "gone.md", owner.userId);
      await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);
      return { v, ids: [...ids, gone, randomUUID()] };
    };

    const A = await mk();
    const B = await mk();

    const batched = await deleteBatch(owner, A.v, A.ids);

    const singles: NoteDeleteResult[] = [];
    for (const docId of B.ids) {
      const res = await req(owner, "DELETE", `/api/notes/${docId}`);
      singles.push({
        docId,
        status: res.status === 200 ? "deleted" : res.status === 403 ? "denied" : "error",
        code: res.status === 404 ? "unknown_note" : res.status === 403 ? "no_edit_permission" : null,
        error: null,
      });
    }

    expect(batched.body.results.map((r) => [r.status, r.code])).toEqual(
      singles.map((r) => [r.status, r.code]),
    );

    const stateOf = async (v: string) =>
      (
        await pool.query(
          `SELECT rel_path, (deleted_at IS NULL) AS live,
                  (SELECT count(*)::int FROM note_index ni WHERE ni.doc_id = n.id) AS idx
             FROM notes n WHERE vault_id = $1 ORDER BY rel_path`,
          [v],
        )
      ).rows;
    expect(await stateOf(A.v)).toEqual(await stateOf(B.v));
    // …and the derived rows really are gone on both sides.
    expect((await stateOf(A.v)).every((r) => r.idx === 0)).toBe(true);
  });

  it("emits exactly ONE registry broadcast for the whole batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await seedNote(vault, null, `n${i}.md`, owner.userId));
    rec.reset();

    const { status, body } = await deleteBatch(owner, vault, ids);
    expect(status).toBe(200);
    expect(body.results.every((r) => r.status === "deleted")).toBe(true);
    expect(rec.registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
      [vault],
    );
    expect(rows[0].n).toBe(0);
  });

  it("broadcasts nothing when every item is refused", async () => {
    const { body } = await deleteBatch(owner, vault, [randomUUID(), randomUUID()]);
    expect(body.results.map((r) => r.code)).toEqual(["unknown_note", "unknown_note"]);
    expect(rec.registryBroadcasts).toEqual([]);
  });

  /** Permission is per ITEM, and it is the same resolver the single route asks:
   *  a lock caps at view, so a locked folder's note is refused while its
   *  neighbour in an unlocked folder is deleted, in ONE request. */
  it("refuses per item — a locked note stays, its neighbour goes", async () => {
    const member = await signUp("member@del.test");
    await seedMember(org, member.userId, "member");
    const open = await seedFolder(vault, null, "Open", "Open", owner.userId);
    const locked = await seedFolder(vault, null, "Frozen", "Frozen", owner.userId);
    await seedLock(org, "folder", locked, { type: "org" });
    const free = await seedNote(vault, open, "Open/ok.md", owner.userId);
    const capped = await seedNote(vault, locked, "Frozen/no.md", owner.userId);

    const { body } = await deleteBatch(member, vault, [free, capped]);
    expect(body.results.map((r) => [r.status, r.code])).toEqual([
      ["deleted", null],
      ["denied", "no_edit_permission"],
    ]);

    const { rows } = await pool.query<{ id: string; live: boolean }>(
      "SELECT id, (deleted_at IS NULL) AS live FROM notes WHERE id = ANY($1::text[])",
      [[free, capped]],
    );
    expect(new Map(rows.map((r) => [r.id, r.live]))).toEqual(
      new Map([
        [free, false],
        [capped, true],
      ]),
    );
    // One broadcast, for the one item that actually landed.
    expect(rec.registryBroadcasts).toEqual([{ vaultId: vault, originId: null }]);
  });

  it("will not delete through this vault a note that lives in another one", async () => {
    const other = await seedVault(org, "Other");
    const foreign = await seedNote(other, null, "elsewhere.md", owner.userId);
    const { body } = await deleteBatch(owner, vault, [foreign]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "unknown_note" });
    const { rows } = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [foreign]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it("kicks and unloads every doc it deleted, off the response path", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedNote(vault, null, `k${i}.md`, owner.userId));
    rec.reset();
    await deleteBatch(owner, vault, ids);
    // `setImmediate`, so it has not happened by the time the response returns.
    await new Promise((r) => setTimeout(r, 50));
    expect(rec.evicted.map((e) => e.docId).sort()).toEqual([...ids].sort());
    expect(rec.disconnected).toEqual([]);
  });

  it("gates like every other bulk route, and caps the batch", async () => {
    const anon = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/notes/delete-batch`, {
        method: "POST",
        body: JSON.stringify({ docIds: [] }),
      }),
    );
    expect(anon.status).toBe(401);

    const unknown = await req(owner, "POST", `/api/vaults/${randomUUID()}/notes/delete-batch`, {
      docIds: [],
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("unknown_vault");

    const stranger = await signUp("stranger@del.test");
    const forbidden = await req(stranger, "POST", `/api/vaults/${vault}/notes/delete-batch`, {
      docIds: [],
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe("not_a_member");

    const bad = await req(owner, "POST", `/api/vaults/${vault}/notes/delete-batch`, {});
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_body");

    const huge = await deleteBatch(
      owner,
      vault,
      Array.from({ length: 201 }, () => randomUUID()),
    );
    expect(huge.status).toBe(400);
    expect(huge.body.code).toBe("batch_too_large");
  });
});
