import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import {
  createVersionCapture,
  MAX_VERSIONS_PER_NOTE,
  recordVersion,
  sha256Hex,
} from "../src/versions/capture.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
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
