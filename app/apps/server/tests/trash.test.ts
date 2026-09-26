import { EventEmitter } from "node:events";
import * as Y from "yjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedFolder, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { appendUpdate, loadDocState } from "../src/yjs/persistence.js";
import { recordVersion } from "../src/versions/capture.js";
import { purgeExpiredTrash, restoredPath } from "../src/trash/service.js";
import { TRASH_RETENTION_DAYS } from "../src/trash/retention.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import type { DocPushResult } from "../src/http/routes/bulk-types.js";

/**
 * Per-vault note Trash (offline reconciliation, Phase 2): soft deletes record
 * who and until when, pushes into a deleted doc land until `purge_after`, the
 * Trash lists and restores, the purge removes, and `ready.tombstones` tells a
 * connecting client which of its docs were deleted (never also as revoked).
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

function updateFor(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return u;
}

async function textOf(docId: string): Promise<string> {
  const state = await loadDocState(docId);
  if (!state) return "";
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = doc.getText("content").toString();
  doc.destroy();
  return out;
}

async function softDelete(user: TestUser, docId: string) {
  const res = await req(user, "DELETE", `/api/notes/${docId}`);
  expect(res.status).toBe(200);
}

async function expire(docId: string) {
  await pool.query("UPDATE notes SET purge_after = now() - interval '1 minute' WHERE id = $1", [docId]);
}

afterAll(async () => {
  await pool.end();
});

describe("note trash", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@trash.test");
    org = (await createOrg(owner, "Trash Co", "trash-co")).id;
    member = await signUp("member@trash.test");
    await seedMember(org, member.userId, "member");
    outsider = await signUp("outsider@trash.test");
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });

  it("DELETE records deleted_by + purge_after and evicts live sockets", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(member, doc);
    const { rows } = await pool.query(
      `SELECT deleted_by, purge_after - deleted_at AS window FROM notes WHERE id = $1`,
      [doc],
    );
    expect(rows[0].deleted_by).toBe(member.userId);
    expect(rows[0].window.days).toBe(TRASH_RETENTION_DAYS);
    expect(rec.evicted).toContainEqual({ vaultId: vault, docId: doc });
  });

  it("delete-batch and folder delete also stamp deleted_by", async () => {
    const f = await seedFolder(vault, null, "Docs", "Docs", owner.userId);
    const inFolder = await seedNote(vault, f, "Docs/x.md", owner.userId);
    const loose = await seedNote(vault, null, "y.md", owner.userId);
    expect((await req(owner, "DELETE", `/api/folders/${f}`)).status).toBe(200);
    expect(
      (await req(member, "POST", `/api/vaults/${vault}/notes/delete-batch`, { docIds: [loose] })).status,
    ).toBe(200);
    const { rows } = await pool.query(
      "SELECT id, deleted_by, purge_after IS NOT NULL AS has_purge FROM notes ORDER BY rel_path",
    );
    expect(rows).toEqual([
      { id: inFolder, deleted_by: owner.userId, has_purge: true },
      { id: loose, deleted_by: member.userId, has_purge: true },
    ]);
  });

  it("sync-token mints for a deleted doc inside its window, refuses after", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(owner, doc);
    const ok = await req(member, "POST", "/api/sync-token", { docId: doc });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { readOnly: boolean }).readOnly).toBe(false);
    // An outsider still gets nothing.
    expect((await req(outsider, "POST", "/api/sync-token", { docId: doc })).status).toBe(403);
    await expire(doc);
    expect((await req(member, "POST", "/api/sync-token", { docId: doc })).status).toBe(404);
  });

  it("batch push into a deleted doc is accepted before purge_after, refused after; note stays deleted", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(owner, doc);
    const push = async () => {
      const res = await req(member, "POST", `/api/vaults/${vault}/docs/batch`, {
        items: [{ docId: doc, update: Buffer.from(updateFor("offline edit")).toString("base64") }],
      });
      return ((await res.json()) as { results: DocPushResult[] }).results[0];
    };
    const first = await push();
    expect(first.status).not.toBe("denied");
    expect(first.status).not.toBe("error");
    expect(await textOf(doc)).toBe("offline edit");
    const { rows } = await pool.query("SELECT deleted_at FROM notes WHERE id = $1", [doc]);
    expect(rows[0].deleted_at).not.toBeNull();

    await expire(doc);
    const second = await push();
    expect(second.status).toBe("denied");
  });

  it("re-registering a deleted id still returns note_deleted", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(owner, doc);
    const res = await req(owner, "POST", `/api/vaults/${vault}/notes/batch`, {
      items: [{ relPath: "a.md", docId: doc }],
    });
    const body = (await res.json()) as { results: Array<{ code: string | null }> };
    expect(body.results[0].code).toBe("note_deleted");
  });

  it("lists trash filtered by readability, newest first, with unsynced contributions", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    await appendUpdate(a, updateFor("before delete"));
    await softDelete(owner, a);
    await pool.query("UPDATE notes SET deleted_at = deleted_at - interval '1 hour' WHERE id = $1", [a]);
    await pool.query("UPDATE doc_updates SET created_at = created_at - interval '2 hours' WHERE doc_id = $1", [a]);
    await softDelete(member, b);
    // A push after the delete counts as an unsynced contribution.
    await appendUpdate(b, updateFor("after delete"));

    const res = await req(member, "GET", `/api/vaults/${vault}/trash`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        docId: string;
        relPath: string;
        deletedBy: { id: string; name: string } | null;
        sizeBytes: number;
        hasUnsyncedContributions: boolean;
        purgeAfter: string;
      }>;
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items.map((i) => i.docId)).toEqual([b, a]);
    expect(body.items[0].deletedBy?.id).toBe(member.userId);
    expect(body.items[0].hasUnsyncedContributions).toBe(true);
    expect(body.items[1].hasUnsyncedContributions).toBe(false);
    expect(body.items[1].sizeBytes).toBeGreaterThan(0);

    // Non-members are refused; an expired note drops out.
    expect((await req(outsider, "GET", `/api/vaults/${vault}/trash`)).status).toBe(403);
    await expire(a);
    const after = (await (await req(member, "GET", `/api/vaults/${vault}/trash`)).json()) as {
      items: Array<{ docId: string }>;
    };
    expect(after.items.map((i) => i.docId)).toEqual([b]);
  });

  it("hides trashed notes the caller could not read", async () => {
    // Private vault: only the author (and nobody else) reads their note.
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    const mine = await seedNote(vault, null, "mine.md", member.userId);
    const theirs = await seedNote(vault, null, "theirs.md", owner.userId);
    await pool.query(
      `UPDATE notes SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = ANY($1)`,
      [[mine, theirs]],
    );
    const body = (await (await req(member, "GET", `/api/vaults/${vault}/trash`)).json()) as {
      items: Array<{ docId: string }>;
    };
    expect(body.items.map((i) => i.docId)).toEqual([mine]);
  });

  it("restores in place, keeps pushed content, and broadcasts", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(owner, doc);
    await appendUpdate(doc, updateFor("merged in trash"));
    rec.reset();
    const res = await req(member, "POST", `/api/notes/${doc}/restore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ docId: doc, relPath: "a.md", renamed: false });
    const { rows } = await pool.query(
      "SELECT deleted_at, deleted_by, purge_after FROM notes WHERE id = $1",
      [doc],
    );
    expect(rows[0]).toEqual({ deleted_at: null, deleted_by: null, purge_after: null });
    expect(await textOf(doc)).toBe("merged in trash");
    expect(rec.registryBroadcasts.map((b) => b.vaultId)).toContain(vault);
    // A second restore is a 404: it is no longer deleted.
    expect((await req(member, "POST", `/api/notes/${doc}/restore`)).status).toBe(404);
  });

  it("restores with a dated suffix when the path is taken (case-insensitive)", async () => {
    const doc = await seedNote(vault, null, "Plan.md", owner.userId);
    await softDelete(owner, doc);
    await seedNote(vault, null, "plan.md", owner.userId);
    const res = await req(owner, "POST", `/api/notes/${doc}/restore`);
    const body = (await res.json()) as { relPath: string; renamed: boolean };
    expect(body.renamed).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    expect(body.relPath).toBe(`Plan (restored ${day}).md`);
    expect(restoredPath("a/b.md", new Date("2026-09-26T00:00:00Z"), 2)).toBe("a/b (restored 2026-09-26 2).md");
  });

  it("recreates a hard-deleted parent folder chain, reusing tombstoned ids", async () => {
    const top = await seedFolder(vault, null, "A", "A", owner.userId);
    const sub = await seedFolder(vault, top, "B", "A/B", owner.userId);
    const doc = await seedNote(vault, sub, "A/B/n.md", owner.userId);
    expect((await req(owner, "DELETE", `/api/folders/${top}`)).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM folders WHERE vault_id = $1", [vault])).rows).toHaveLength(0);

    const res = await req(owner, "POST", `/api/notes/${doc}/restore`);
    expect(res.status).toBe(200);
    const { rows: folders } = await pool.query(
      "SELECT id, path, parent_id FROM folders WHERE vault_id = $1 ORDER BY path",
      [vault],
    );
    expect(folders).toEqual([
      { id: top, path: "A", parent_id: null },
      { id: sub, path: "A/B", parent_id: top },
    ]);
    const { rows } = await pool.query("SELECT folder_id FROM notes WHERE id = $1", [doc]);
    expect(rows[0].folder_id).toBe(sub);
    const { rows: tombs } = await pool.query("SELECT id FROM folder_tombstones WHERE id = ANY($1)", [[top, sub]]);
    expect(tombs).toHaveLength(0);
  });

  it("trash-content returns a deleted note's text to readers; 403 / 404 / 410 otherwise", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    const live = await seedNote(vault, null, "live.md", owner.userId);
    await appendUpdate(doc, updateFor("kept in trash"));
    await softDelete(owner, doc);
    // A view-only member can read it.
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedVaultGrant(org, "view");
    const res = await req(member, "GET", `/api/notes/${doc}/trash-content`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { docId: string; relPath: string; text: string; deletedAt: string };
    expect(body).toMatchObject({ docId: doc, relPath: "a.md", text: "kept in trash" });
    expect(Number.isNaN(Date.parse(body.deletedAt))).toBe(false);

    expect((await req(outsider, "GET", `/api/notes/${doc}/trash-content`)).status).toBe(403);
    const liveRes = await req(member, "GET", `/api/notes/${live}/trash-content`);
    expect(liveRes.status).toBe(404);
    expect(((await liveRes.json()) as { code: string }).code).toBe("not_in_trash");

    await expire(doc);
    await purgeExpiredTrash();
    const purged = await req(member, "GET", `/api/notes/${doc}/trash-content`);
    expect(purged.status).toBe(410);
    expect(((await purged.json()) as { code: string }).code).toBe("purged");
  });

  it("restore refuses members without edit (403) and unknown ids (404)", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    await softDelete(owner, doc);
    expect((await req(outsider, "POST", `/api/notes/${doc}/restore`)).status).toBe(403);
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedVaultGrant(org, "view");
    expect((await req(member, "POST", `/api/notes/${doc}/restore`)).status).toBe(403);
    expect((await req(owner, "POST", `/api/notes/nope/restore`)).status).toBe(404);
  });

  it("per-note versions stay readable on a deleted note; revert is 409 note_deleted", async () => {
    const doc = await seedNote(vault, null, "a.md", owner.userId);
    const versionId = await recordVersion({
      vaultId: vault,
      docId: doc,
      content: "v1",
      cause: "idle",
      authorId: owner.userId,
    });
    await softDelete(owner, doc);
    const list = await req(member, "GET", `/api/notes/${doc}/versions`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { versions: unknown[] }).versions).toHaveLength(1);
    const one = await req(member, "GET", `/api/notes/${doc}/versions/${versionId}`);
    expect(((await one.json()) as { content: string }).content).toBe("v1");
    expect((await req(outsider, "GET", `/api/notes/${doc}/versions`)).status).toBe(403);
    const revert = await req(member, "POST", `/api/notes/${doc}/versions/${versionId}/revert`);
    expect(revert.status).toBe(409);
    expect(((await revert.json()) as { code: string }).code).toBe("note_deleted");
  });

  it("purge removes CRDT, versions and the row for expired notes only, idempotently", async () => {
    const gone = await seedNote(vault, null, "gone.md", owner.userId);
    const kept = await seedNote(vault, null, "kept.md", owner.userId);
    const live = await seedNote(vault, null, "live.md", owner.userId);
    for (const d of [gone, kept, live]) {
      await appendUpdate(d, updateFor(`text ${d}`));
      await recordVersion({ vaultId: vault, docId: d, content: "v", cause: "idle", authorId: null });
    }
    await softDelete(owner, gone);
    await softDelete(owner, kept);
    await expire(gone);

    expect(await purgeExpiredTrash()).toEqual([gone]);
    const count = async (table: string, d: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE doc_id = $1`, [d])).rows[0].n;
    expect(await count("doc_updates", gone)).toBe(0);
    expect(await count("doc_snapshots", gone)).toBe(0);
    expect(await count("doc_state_vectors", gone)).toBe(0);
    expect(await count("note_versions", gone)).toBe(0);
    expect(await count("note_index", gone)).toBe(0);
    // The row survives as a permanent tombstone.
    const { rows: tomb } = await pool.query(
      "SELECT deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged FROM notes WHERE id = $1",
      [gone],
    );
    expect(tomb).toEqual([{ deleted: true, purged: true }]);
    // Not listed, not restorable (410), and a new note can take its path.
    const listed = (await (await req(owner, "GET", `/api/vaults/${vault}/trash`)).json()) as {
      items: Array<{ docId: string }>;
    };
    expect(listed.items.map((i) => i.docId)).toEqual([kept]);
    const restore = await req(owner, "POST", `/api/notes/${gone}/restore`);
    expect(restore.status).toBe(410);
    expect(((await restore.json()) as { code: string }).code).toBe("purged");
    await seedNote(vault, null, "gone.md", owner.userId);
    for (const d of [kept, live]) {
      expect(await count("doc_updates", d)).toBeGreaterThan(0);
      expect(await count("note_versions", d)).toBe(1);
    }
    expect(await purgeExpiredTrash()).toEqual([]);
  });

  describe("ready.tombstones", () => {
    class FakeWs extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      readonly sent: Array<Record<string, unknown>> = [];
      send(data: unknown, opts?: { binary?: boolean }): void {
        if (!opts?.binary) this.sent.push(JSON.parse(data as string));
      }
      close(): void {
        this.readyState = 3;
        this.emit("close");
      }
    }
    const EMPTY_SV = Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64");

    async function readyFor(userId: string, ids: string[]) {
      const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
      const ws = new FakeWs();
      channel.handleConnection(ws as never);
      const manifest = Object.fromEntries(ids.map((d) => [d, EMPTY_SV]));
      ws.emit(
        "message",
        Buffer.from(JSON.stringify({ t: "hello", token: await mintVaultToken({ userId, vaultId: vault }), manifest })),
        false,
      );
      const start = Date.now();
      while (!ws.sent.some((c) => c.t === "ready")) {
        if (Date.now() - start > 4000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 15));
      }
      return ws.sent.find((c) => c.t === "ready")!;
    }

    it("names held deleted docs as tombstones and never also as revoked", async () => {
      const live = await seedNote(vault, null, "live.md", owner.userId);
      const del = await seedNote(vault, null, "del.md", owner.userId);
      const privateDoc = await seedNote(vault, null, "p.md", owner.userId);
      await softDelete(owner, del);
      // Make `privateDoc` unreadable to the member without deleting it.
      await pool.query(
        `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
         VALUES (gen_random_uuid()::text, $1, 'file', $2, 'org', $1, 'denied')`,
        [org, privateDoc],
      );
      const ready = await readyFor(member.userId, [live, del, privateDoc]);
      expect(ready.tombstones).toEqual([del]);
      expect(ready.revoked).toEqual([privateDoc]);
    });

    it("still names a purged note as a tombstone", async () => {
      const del = await seedNote(vault, null, "del.md", owner.userId);
      await softDelete(owner, del);
      await expire(del);
      expect(await purgeExpiredTrash()).toEqual([del]);
      const ready = await readyFor(member.userId, [del]);
      expect(ready.tombstones).toEqual([del]);
      expect(ready.revoked).toBeUndefined();
    });

    it("live: a delete is not announced as a revocation, a real revoke still is", async () => {
      const del = await seedNote(vault, null, "del.md", owner.userId);
      const revokedDoc = await seedNote(vault, null, "r.md", owner.userId);
      const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
      const ws = new FakeWs();
      channel.handleConnection(ws as never);
      const manifest = Object.fromEntries([del, revokedDoc].map((d) => [d, EMPTY_SV]));
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            t: "hello",
            token: await mintVaultToken({ userId: member.userId, vaultId: vault }),
            manifest,
            caps: ["revocation-batches"],
          }),
        ),
        false,
      );
      const until = async (fn: () => boolean) => {
        const start = Date.now();
        while (!fn()) {
          if (Date.now() - start > 4000) throw new Error("timeout");
          await new Promise((r) => setTimeout(r, 15));
        }
      };
      await until(() => ws.sent.some((c) => c.t === "ready"));
      const before = ws.sent.length;
      await softDelete(owner, del);
      await pool.query(
        `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
         VALUES (gen_random_uuid()::text, $1, 'file', $2, 'org', $1, 'denied')`,
        [org, revokedDoc],
      );
      await channel.publishAclChanged(vault);
      await until(() => ws.sent.slice(before).some((c) => c.t === "reauth"));
      const after = ws.sent.slice(before);
      const revoked = after.filter((c) => c.t === "revoked").flatMap((c) => c.docIds as string[]);
      const dropped = after.filter((c) => c.t === "drop").map((c) => c.docId);
      expect(revoked).toEqual([revokedDoc]);
      expect(dropped).toEqual([]);
    });

    it("omits the field when nothing held is deleted", async () => {
      const live = await seedNote(vault, null, "live.md", owner.userId);
      const ready = await readyFor(member.userId, [live]);
      expect(ready.tombstones).toBeUndefined();
      expect(ready.tombstonesTruncated).toBeUndefined();
    });
  });
});
