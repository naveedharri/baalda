import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import {
  createVersionCapture,
  MAX_VERSIONS_PER_NOTE,
  recordVersion,
  sha256Hex,
} from "../src/versions/capture.js";
import {
  applyDocPushBatch,
  BULK_ORIGIN,
  BULK_SEED_ORIGIN,
  setDocBatchRuntime,
  type DocApplyItem,
} from "../src/sync/doc-batch.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import * as Y from "yjs";
import { flushIndexQueue } from "../src/index/indexer.js";
import {
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedVault,
} from "./helpers/seed.js";

/**
 * Per-note version history: automatic capture at the end of an edit session,
 * the "last edited by" stamp that rides the same signal, and the HTTP surface
 * (which is gated by the SAME per-doc ACL as sync — a `locked` share caps at
 * view, so listing works and reverting 403s).
 */

let rec: RecordingAppDeps;
let app: ReturnType<typeof createApp>;

/** A Yjs update that sets a note's body to `text` — the wire shape a batch
 *  push carries, built the same way `tests/bulk-docs-batch.test.ts` builds it. */
function updateFor(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function api(user: TestUser | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Bearer ${user.token}`;
  return app.fetch(new Request(`http://local${path}`, { ...init, headers }));
}

describe("per-note versions", () => {
  beforeEach(async () => {
    await resetDb();
    rec = recordingAppDeps();
    app = createApp(rec.deps);
  });
  afterEach(() => setDocBatchRuntime(null));
  afterAll(async () => {
    await pool.end();
  });

  // ── capture ──────────────────────────────────────────────────────────────

  it("captures one version when a doc's edit session goes idle", async () => {
    const user = await signUp("cap@t.com");
    const org = await seedOrg("Acme", "acme-v1");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    rec.docWriter.store.set(docId, "# Draft\n\nbody");

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      // Long idle window: the flush hook is what ends the session here, exactly
      // as the timer would 10 minutes later.
      idleMs: 60_000,
    });
    capture.touch(vault, docId, user.userId);
    capture.touch(vault, docId, user.userId);
    await capture.flush(docId);
    capture.stop();

    const { rows } = await pool.query(
      "SELECT doc_id, vault_id, content, sha256, cause, author_id FROM note_versions",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].doc_id).toBe(docId);
    expect(rows[0].vault_id).toBe(vault);
    expect(rows[0].content).toBe("# Draft\n\nbody");
    expect(rows[0].sha256).toBe(sha256Hex("# Draft\n\nbody"));
    expect(rows[0].cause).toBe("idle");
    expect(rows[0].author_id).toBe(user.userId);
  });

  it("skips a capture whose content is identical to the newest version", async () => {
    const user = await signUp("dedupe@t.com");
    const org = await seedOrg("Acme", "acme-v2");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    rec.docWriter.store.set(docId, "same text");

    const capture = createVersionCapture({ docWriter: rec.docWriter, idleMs: 60_000 });
    capture.touch(vault, docId, user.userId);
    await capture.flush(docId);
    capture.touch(vault, docId, user.userId);
    await capture.flush(docId);
    expect(await countVersions(docId)).toBe(1);

    rec.docWriter.store.set(docId, "changed");
    capture.touch(vault, docId, user.userId);
    await capture.flush(docId);
    capture.stop();
    expect(await countVersions(docId)).toBe(2);
  });

  it("attributes an unauthenticated (pre-attribution token) edit to nobody", async () => {
    const org = await seedOrg("Acme", "acme-v3");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");
    rec.docWriter.store.set(docId, "anonymous work");

    const capture = createVersionCapture({ docWriter: rec.docWriter, idleMs: 60_000 });
    capture.touch(vault, docId, null);
    await capture.flush(docId);
    capture.stop();

    const { rows } = await pool.query("SELECT author_id FROM note_versions WHERE doc_id = $1", [
      docId,
    ]);
    expect(rows[0].author_id).toBeNull();
  });

  it(`keeps at most ${MAX_VERSIONS_PER_NOTE} versions per note, dropping the oldest`, async () => {
    const org = await seedOrg("Acme", "acme-v4");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");

    for (let i = 0; i < MAX_VERSIONS_PER_NOTE + 7; i++) {
      await recordVersion({ vaultId: vault, docId, content: `v${i}`, cause: "idle", authorId: null });
    }
    const { rows } = await pool.query<{ content: string }>(
      "SELECT content FROM note_versions WHERE doc_id = $1 ORDER BY id ASC",
      [docId],
    );
    expect(rows).toHaveLength(MAX_VERSIONS_PER_NOTE);
    expect(rows[0].content).toBe("v7");
    expect(rows[rows.length - 1].content).toBe(`v${MAX_VERSIONS_PER_NOTE + 6}`);
  });

  it("stamps last_edited_by/at on the first touch and broadcasts it", async () => {
    const user = await signUp("stamp@t.com");
    const org = await seedOrg("Acme", "acme-v5");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    rec.docWriter.store.set(docId, "hello");

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000,
    });
    capture.touch(vault, docId, user.userId);
    // The stamp is fire-and-forget inside touch(); let it land.
    await new Promise((r) => setTimeout(r, 100));
    capture.stop();

    const { rows } = await pool.query<{ last_edited_by: string; last_edited_at: Date | null }>(
      "SELECT last_edited_by, last_edited_at FROM notes WHERE id = $1",
      [docId],
    );
    expect(rows[0].last_edited_by).toBe(user.userId);
    expect(rows[0].last_edited_at).not.toBeNull();
    expect(rec.registryBroadcasts).toContainEqual({ vaultId: vault, originId: null });
  });

  // The row and the broadcast are on different clocks on purpose (#104): a
  // script or an agent polls `notes.updated_at` to learn whether its write
  // landed, so every stored change has to move it — while the vault-wide
  // `registry-changed` re-pull it triggers stays throttled to once a minute.
  it("stamps the row on every touch but broadcasts at most once a minute", async () => {
    const user = await signUp("stamp2@t.com");
    const org = await seedOrg("Acme", "acme-v5b");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    rec.docWriter.store.set(docId, "hello");

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000,
    });
    const stampedAt = async (): Promise<{ updated: number; edited: number }> => {
      const { rows } = await pool.query<{ updated_at: Date; last_edited_at: Date }>(
        "SELECT updated_at, last_edited_at FROM notes WHERE id = $1",
        [docId],
      );
      return { updated: rows[0].updated_at.getTime(), edited: rows[0].last_edited_at.getTime() };
    };

    capture.touch(vault, docId, user.userId);
    await new Promise((r) => setTimeout(r, 100)); // the stamp is fire-and-forget
    const first = await stampedAt();
    expect(rec.registryBroadcasts).toHaveLength(1);

    capture.touch(vault, docId, user.userId); // same editor, well inside the 60 s window
    await new Promise((r) => setTimeout(r, 100));
    capture.stop();

    const second = await stampedAt();
    expect(second.updated).toBeGreaterThan(first.updated);
    expect(second.edited).toBeGreaterThan(first.edited);
    expect(rec.registryBroadcasts).toHaveLength(1); // …and still only one fan-out
  });

  /**
   * The #98 shape, re-run for the version machinery: a bulk push is ONE editor
   * touching ONE vault in one second, and it used to fire a null-origin
   * `registry-changed` PER DOC. A null origin marks the channel's 120 ms
   * coalescing window anonymous, which forces `origins = []` — so every frame
   * landed on every subscriber INCLUDING the pushing client, and each one cost a
   * whole-vault ACL recompute plus a registry re-pull. At ~8/s for the length of
   * an import.
   *
   * The throttle is now keyed by vault rather than by doc: same rule ("announce
   * when the editor changes hands, else at most once a minute"), applied at the
   * scope the broadcast actually has.
   */
  it("a 50-doc batch from one editor is at most ONE broadcast", async () => {
    const user = await signUp("batch-stamp@t.com");
    const org = await seedOrg("Acme", "acme-v5d");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = await seedNote(vault, null, `n${i}.md`, user.userId);
      rec.docWriter.store.set(id, "hello");
      docIds.push(id);
    }

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000,
    });
    for (const docId of docIds) capture.touch(vault, docId, user.userId, BULK_SEED_ORIGIN);
    // The stamps are fire-and-forget inside touch(); wait for all 50 to land.
    const stamped = async (): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM notes WHERE vault_id = $1 AND last_edited_by = $2",
          [vault, user.userId],
        )
      ).rows[0].n;
    for (let i = 0; i < 100 && (await stamped()) < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    capture.stop();

    expect(rec.registryBroadcasts.length).toBeLessThanOrEqual(1);
    // Every row is still stamped — attribution is not what was throttled (#104).
    expect(await stamped()).toBe(50);

    // …and the coalescing is BULK-only. The same person hand-editing one of the
    // notes they just imported announces at once: keying the live throttle by
    // vault too meant an import swallowed the human's very next edit — and every
    // teammate's "edited by X, <time>" — for up to 60 s.
    const before = rec.registryBroadcasts.length;
    const live = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000,
    });
    live.touch(vault, docIds[0], user.userId);
    await new Promise((r) => setTimeout(r, 100));
    live.stop();
    expect(rec.registryBroadcasts.length).toBe(before + 1);
  });

  /**
   * …and a bulk seed arms no ten-minute idle timer. 5,000 of those were 5,000
   * live timers and 5,000 `Session` objects that later fired at once, each a
   * SELECT plus a full `loadDocState` + `Y.Doc` rebuild — for a doc that had
   * just received its FIRST copy of its own `.md` and so had no prior state a
   * version could preserve.
   */
  it("a bulk SEED captures no idle version — but a plain bulk merge does", async () => {
    const user = await signUp("bulk-noversion@t.com");
    const org = await seedOrg("Acme", "acme-v5e");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    rec.docWriter.store.set(docId, "seeded from disk");

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 10,
    });
    capture.touch(vault, docId, user.userId, BULK_SEED_ORIGIN);
    await new Promise((r) => setTimeout(r, 120));
    capture.stop();
    const seedOnly = await pool.query("SELECT id FROM note_versions WHERE doc_id = $1", [docId]);
    expect(seedOnly.rowCount).toBe(0);

    // A NON-seed batch write to the same doc does capture: `docs/batch` also
    // carries the live local-change drain, which is a merge into prior state.
    const bulk = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 10,
    });
    rec.docWriter.store.set(docId, "rewritten in bulk");
    bulk.touch(vault, docId, user.userId, BULK_ORIGIN);
    await new Promise((r) => setTimeout(r, 120));
    bulk.stop();
    expect(
      (await pool.query("SELECT id FROM note_versions WHERE doc_id = $1", [docId])).rowCount,
    ).toBe(1);

    // A human edit to the same doc still does, so this is a source filter and
    // not a switch that turned versions off.
    const human = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 10,
    });
    rec.docWriter.store.set(docId, "and then typed on");
    human.touch(vault, docId, user.userId);
    await new Promise((r) => setTimeout(r, 120));
    human.stop();
    const after = await pool.query("SELECT id FROM note_versions WHERE doc_id = $1", [docId]);
    expect(after.rowCount).toBe(2);
  });

  /**
   * H1: the skip is a SEED filter, not a "came in through the batch route"
   * filter. The desktop routes its live local-change drain through the same
   * `docs/batch` endpoint once enough notes changed at once — `expectEmpty:
   * false`, a real diff-merge into docs that already hold text. Tagging those
   * `bulk` too meant an AI rewriting 40 existing notes captured ZERO versions
   * while 24 captured 24: history that depended on how many files a tool
   * touched in one go, in exactly the case a restore point matters most.
   *
   * Driven through `applyDocPushBatch` (not `touch` directly) so what is pinned
   * is the wiring: which source the batch applier hands the hook for a seed and
   * for a merge.
   */
  it("a batch SEED captures nothing; a batch MERGE captures one version per doc", async () => {
    const user = await signUp("batch-versions@t.com");
    const org = await seedOrg("Acme", "acme-v5f");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000, // `flush` ends each session, exactly as the timer would
    });
    setDocBatchRuntime({
      // No live docs in this test: every item takes the detached path, which is
      // the one that calls `onDocWritten`.
      server: { hocuspocus: { documents: new Map() } } as never,
      hooks: {
        onDocWritten: (v, d, u, src) => capture.touch(v, d, u, src),
      },
    });

    const seeded: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = await seedNote(vault, null, `seed${i}.md`, user.userId);
      rec.docWriter.store.set(id, `first copy ${i}`);
      seeded.push(id);
    }
    const seedItems: DocApplyItem[] = seeded.map((docId, i) => ({
      docId,
      update: updateFor(`first copy ${i}`),
      expectEmpty: true,
    }));
    const seedOut = await applyDocPushBatch(vault, seedItems, { userId: user.userId });
    expect(seedOut.every((r) => r.outcome === "applied")).toBe(true);
    for (const id of seeded) await capture.flush(id);
    expect(await pool.query("SELECT id FROM note_versions")).toMatchObject({ rowCount: 0 });

    // Now the merge: 30 of those docs already hold text, and a tool rewrites
    // them in one drain. `expectEmpty` is false — there IS prior state.
    const merged = seeded.slice(0, 30);
    for (const [i, id] of merged.entries()) rec.docWriter.store.set(id, `rewritten ${i}`);
    const mergeItems: DocApplyItem[] = merged.map((docId, i) => ({
      docId,
      update: updateFor(`rewritten ${i}`),
    }));
    const mergeOut = await applyDocPushBatch(vault, mergeItems, { userId: user.userId });
    expect(mergeOut.every((r) => r.outcome === "applied")).toBe(true);
    for (const id of merged) await capture.flush(id);
    capture.stop();

    // One per doc — exactly what 30 single writes down the live path produce.
    const { rows } = await pool.query<{ doc_id: string; content: string }>(
      "SELECT doc_id, content FROM note_versions",
    );
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.doc_id))).toEqual(new Set(merged));
    // …and the untouched 20 still have none.
    expect(rows.some((r) => seeded.slice(30).includes(r.doc_id))).toBe(false);
    // The batch path defers its re-index; drain it so no timer fires after the
    // suite closes the pool.
    await flushIndexQueue();
  });

  it("broadcasts immediately when the editor changes hands", async () => {
    const owner = await signUp("hands-a@t.com");
    const mate = await signUp("hands-b@t.com");
    const org = await seedOrg("Acme", "acme-v5c");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, mate.userId, "member");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    rec.docWriter.store.set(docId, "hello");

    const capture = createVersionCapture({
      docWriter: rec.docWriter,
      onRegistryChanged: rec.deps.onRegistryChanged,
      idleMs: 60_000,
    });
    capture.touch(vault, docId, owner.userId);
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.registryBroadcasts).toHaveLength(1);

    capture.touch(vault, docId, mate.userId); // different editor → no throttle
    await new Promise((r) => setTimeout(r, 100));
    capture.stop();

    expect(rec.registryBroadcasts).toHaveLength(2);
    const { rows } = await pool.query<{ last_edited_by: string }>(
      "SELECT last_edited_by FROM notes WHERE id = $1",
      [docId],
    );
    expect(rows[0].last_edited_by).toBe(mate.userId);
  });

  it("surfaces the stamp on GET /api/notes (name joined in)", async () => {
    const user = await signUp("surf@t.com");
    const org = await seedOrg("Acme", "acme-v6");
    await seedMember(org, user.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", user.userId);
    await pool.query(
      "UPDATE notes SET last_edited_by = $2, last_edited_at = now() WHERE id = $1",
      [docId, user.userId],
    );

    const res = await api(user, `/api/notes?vaultId=${vault}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notes: Array<{
        id: string;
        last_edited_by: string | null;
        last_edited_by_name: string | null;
        last_edited_at: string | null;
      }>;
    };
    const note = body.notes.find((n) => n.id === docId)!;
    expect(note.last_edited_by).toBe(user.userId);
    expect(note.last_edited_by_name).toBe("surf");
    expect(note.last_edited_at).not.toBeNull();
  });

  // ── HTTP surface ─────────────────────────────────────────────────────────

  it("lists versions newest-first, without content", async () => {
    const owner = await signUp("list@t.com");
    const org = await seedOrg("Acme", "acme-v7");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const first = await recordVersion({
      vaultId: vault,
      docId,
      content: "one",
      cause: "idle",
      authorId: owner.userId,
    });
    const second = await recordVersion({
      vaultId: vault,
      docId,
      content: "two",
      cause: "idle",
      authorId: owner.userId,
    });

    const res = await api(owner, `/api/notes/${docId}/versions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: Array<Record<string, unknown>>;
    };
    expect(body.versions.map((v) => v.id)).toEqual([second, first]);
    expect(body.versions[0]).toMatchObject({
      cause: "idle",
      authorId: owner.userId,
      authorName: "list",
      sha256: sha256Hex("two"),
      size: 3,
    });
    expect(body.versions[0].content).toBeUndefined();

    const detail = await api(owner, `/api/notes/${docId}/versions/${second}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { content: string }).content).toBe("two");
  });

  it("404s a version id that belongs to another note", async () => {
    const owner = await signUp("cross@t.com");
    const org = await seedOrg("Acme", "acme-v8");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const versionOfA = await recordVersion({
      vaultId: vault,
      docId: a,
      content: "secret",
      cause: "idle",
      authorId: owner.userId,
    });

    const res = await api(owner, `/api/notes/${b}/versions/${versionOfA}`);
    expect(res.status).toBe(404);
  });

  it("a viewer may list versions but may not revert; a stranger sees nothing", async () => {
    const owner = await signUp("owner8@t.com");
    const viewer = await signUp("viewer8@t.com");
    const stranger = await signUp("stranger8@t.com");
    const org = await seedOrg("Acme", "acme-v9");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, viewer.userId, "member");
    await seedMember(org, stranger.userId, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const docId = await seedNote(vault, folder, "Shared/n.md", owner.userId);
    await seedShare(org, "folder", folder, viewer.userId, "view");
    const version = await recordVersion({
      vaultId: vault,
      docId,
      content: "old",
      cause: "idle",
      authorId: owner.userId,
    });
    rec.docWriter.store.set(docId, "new");

    expect((await api(viewer, `/api/notes/${docId}/versions`)).status).toBe(200);
    expect((await api(stranger, `/api/notes/${docId}/versions`)).status).toBe(403);
    const revert = await api(viewer, `/api/notes/${docId}/versions/${version}/revert`, {
      method: "POST",
    });
    expect(revert.status).toBe(403);
    expect(rec.docWriter.store.get(docId)).toBe("new");
  });

  it("a locked share caps an editor at view, so revert 403s", async () => {
    const owner = await signUp("owner9@t.com");
    const editor = await signUp("editor9@t.com");
    const org = await seedOrg("Acme", "acme-v10");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, editor.userId, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Locked", "Locked");
    const docId = await seedNote(vault, folder, "Locked/n.md", owner.userId);
    await seedShare(org, "folder", folder, editor.userId, "edit");
    await seedLock(org, "folder", folder, { type: "org" });
    const version = await recordVersion({
      vaultId: vault,
      docId,
      content: "old",
      cause: "idle",
      authorId: owner.userId,
    });

    expect((await api(editor, `/api/notes/${docId}/versions`)).status).toBe(200);
    const revert = await api(editor, `/api/notes/${docId}/versions/${version}/revert`, {
      method: "POST",
    });
    expect(revert.status).toBe(403);
  });

  it("reverting captures a pre-revert version, writes forward, and re-stamps", async () => {
    const owner = await signUp("revert@t.com");
    const org = await seedOrg("Acme", "acme-v11");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const version = await recordVersion({
      vaultId: vault,
      docId,
      content: "the good version",
      cause: "idle",
      authorId: owner.userId,
    });
    // Live text has moved on since that version — so it must be saved first.
    rec.docWriter.store.set(docId, "a regrettable rewrite");
    rec.registryBroadcasts.length = 0;

    const res = await api(owner, `/api/notes/${docId}/versions/${version}/revert`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; preRevertVersionId: number | null };
    expect(body.ok).toBe(true);
    expect(body.preRevertVersionId).toBeTypeOf("number");

    const pre = await pool.query<{ content: string; cause: string; author_id: string }>(
      "SELECT content, cause, author_id FROM note_versions WHERE id = $1",
      [body.preRevertVersionId],
    );
    expect(pre.rows[0]).toMatchObject({
      content: "a regrettable rewrite",
      cause: "pre-revert",
      author_id: owner.userId,
    });

    // Forward write, attributed to the reverter.
    expect(rec.docWriter.store.get(docId)).toBe("the good version");
    expect(rec.docWriter.writes.at(-1)).toMatchObject({
      docId,
      actor: { userId: owner.userId },
    });
    const stamped = await pool.query<{ last_edited_by: string }>(
      "SELECT last_edited_by FROM notes WHERE id = $1",
      [docId],
    );
    expect(stamped.rows[0].last_edited_by).toBe(owner.userId);
    expect(rec.registryBroadcasts).toContainEqual({ vaultId: vault, originId: null });
  });

  it("skips the pre-revert version when the live text is already the newest one", async () => {
    const owner = await signUp("nopre@t.com");
    const org = await seedOrg("Acme", "acme-v12");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const older = await recordVersion({
      vaultId: vault,
      docId,
      content: "older",
      cause: "idle",
      authorId: owner.userId,
    });
    await recordVersion({
      vaultId: vault,
      docId,
      content: "current",
      cause: "idle",
      authorId: owner.userId,
    });
    rec.docWriter.store.set(docId, "current");

    const res = await api(owner, `/api/notes/${docId}/versions/${older}/revert`, {
      method: "POST",
    });
    const body = (await res.json()) as { preRevertVersionId: number | null };
    expect(body.preRevertVersionId).toBeNull();
    expect(rec.docWriter.store.get(docId)).toBe("older");
  });

  it("401s without a session and 404s an unknown note", async () => {
    const owner = await signUp("gate@t.com");
    expect((await api(null, "/api/notes/whatever/versions")).status).toBe(401);
    expect((await api(owner, "/api/notes/no-such-note/versions")).status).toBe(404);
  });
});

async function countVersions(docId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM note_versions WHERE doc_id = $1",
    [docId],
  );
  return Number(rows[0].n);
}
