import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import {
  MAX_CHECKPOINTS,
  maybeDailyCheckpoint,
  pruneCheckpoints,
  withVaultCheckpointLock,
} from "../src/versions/checkpoints.js";
import { sha256Hex } from "../src/versions/capture.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedFolder, seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

/**
 * Vault-wide checkpoints and the vault revert.
 *
 * The revert is the sharp end of the feature: it un-deletes notes (the first
 * `deleted_at = NULL` in the codebase), re-creates folders with their original
 * ids, and rewrites content FORWARD through the doc writer. It is convergent
 * rather than transactional, so "run it twice" is a test, not a hazard.
 */

let rec: RecordingAppDeps;
let app: ReturnType<typeof createApp>;

function api(user: TestUser | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers.authorization = `Bearer ${user.token}`;
  return app.fetch(new Request(`http://local${path}`, { ...init, headers }));
}

async function seedCheckpoint(
  vaultId: string,
  kind: "auto" | "manual",
  createdAt: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO vault_checkpoints (id, vault_id, kind, label, created_at, structure)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [id, vaultId, kind, `${kind}@${createdAt}`, createdAt],
  );
  return id;
}

async function checkpointIds(vaultId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM vault_checkpoints WHERE vault_id = $1 ORDER BY created_at ASC",
    [vaultId],
  );
  return rows.map((r) => r.id);
}

describe("vault checkpoints", () => {
  beforeEach(async () => {
    await resetDb();
    rec = recordingAppDeps();
    app = createApp(rec.deps);
  });
  afterAll(async () => {
    await pool.end();
  });

  // ── CRUD + gates ─────────────────────────────────────────────────────────

  it("owner creates a checkpoint of every note; members can list it", async () => {
    const owner = await signUp("cp-owner@t.com");
    const member = await signUp("cp-member@t.com");
    const org = await seedOrg("Acme", "acme-c1");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    rec.docWriter.store.set(a, "alpha");
    rec.docWriter.store.set(b, "beta");

    const res = await api(owner, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ label: "Before the big refactor" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; kind: string; noteCount: number };
    expect(created.kind).toBe("manual");
    expect(created.noteCount).toBe(2);

    const list = await api(member, `/api/vaults/${vault}/checkpoints`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      checkpoints: Array<Record<string, unknown>>;
    };
    expect(body.checkpoints).toHaveLength(1);
    expect(body.checkpoints[0]).toMatchObject({
      id: created.id,
      kind: "manual",
      label: "Before the big refactor",
      createdBy: owner.userId,
      createdByName: "cp-owner",
      noteCount: 2,
    });
    // Bodies never ride a listing.
    expect(JSON.stringify(body)).not.toContain("alpha");
  });

  it("gates create/delete/revert to owner+admin, and shuts members out", async () => {
    const owner = await signUp("g-owner@t.com");
    const admin = await signUp("g-admin@t.com");
    const member = await signUp("g-member@t.com");
    const outsider = await signUp("g-out@t.com");
    const org = await seedOrg("Acme", "acme-c2");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, admin.userId, "admin");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);

    expect(
      (await api(member, `/api/vaults/${vault}/checkpoints`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(403);
    expect((await api(outsider, `/api/vaults/${vault}/checkpoints`)).status).toBe(403);
    expect((await api(owner, "/api/vaults/no-such-vault/checkpoints")).status).toBe(404);
    expect((await api(null, `/api/vaults/${vault}/checkpoints`)).status).toBe(401);

    const created = await api(admin, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: "{}",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // Revert is the recovery half of an action admins can already take, so it
    // matches create/delete: owner OR admin. A team whose owner is away used to
    // be able to take checkpoints and not use them.
    expect(
      (await api(member, `/api/vaults/${vault}/checkpoints/${id}/revert`, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (await api(outsider, `/api/vaults/${vault}/checkpoints/${id}/revert`, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (await api(admin, `/api/vaults/${vault}/checkpoints/${id}/revert`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (await api(member, `/api/vaults/${vault}/checkpoints/${id}`, { method: "DELETE" })).status,
    ).toBe(403);
    expect(
      (await api(admin, `/api/vaults/${vault}/checkpoints/${id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await api(admin, `/api/vaults/${vault}/checkpoints/${id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  // ── prune ────────────────────────────────────────────────────────────────

  it("prunes the oldest automatic checkpoints first, then the oldest manual ones", async () => {
    const org = await seedOrg("Acme", "acme-c3");
    const vault = await seedVault(org);
    const oldAuto = await seedCheckpoint(vault, "auto", "2026-01-01T00:00:00Z");
    const newAuto = await seedCheckpoint(vault, "auto", "2026-01-02T00:00:00Z");
    const m1 = await seedCheckpoint(vault, "manual", "2026-01-03T00:00:00Z");
    const m2 = await seedCheckpoint(vault, "manual", "2026-01-04T00:00:00Z");
    const m3 = await seedCheckpoint(vault, "manual", "2026-01-05T00:00:00Z");
    const m4 = await seedCheckpoint(vault, "manual", "2026-01-06T00:00:00Z");

    expect(await pruneCheckpoints(pool, vault)).toEqual([oldAuto]);
    expect(await checkpointIds(vault)).toEqual([newAuto, m1, m2, m3, m4]);

    // No autos left: the oldest manual goes instead.
    const m5 = await seedCheckpoint(vault, "manual", "2026-01-07T00:00:00Z");
    await pool.query("DELETE FROM vault_checkpoints WHERE id = $1", [newAuto]);
    const m6 = await seedCheckpoint(vault, "manual", "2026-01-08T00:00:00Z");
    expect(await pruneCheckpoints(pool, vault)).toEqual([m1]);
    expect(await checkpointIds(vault)).toEqual([m2, m3, m4, m5, m6]);
  });

  it("never prunes a checkpoint that is mid-flight", async () => {
    const org = await seedOrg("Acme", "acme-c4");
    const vault = await seedVault(org);
    const target = await seedCheckpoint(vault, "auto", "2026-01-01T00:00:00Z");
    const second = await seedCheckpoint(vault, "auto", "2026-01-02T00:00:00Z");
    for (let i = 3; i <= 7; i++) {
      await seedCheckpoint(vault, "manual", `2026-01-0${i}T00:00:00Z`);
    }

    // 7 rows, 2 over the cap: the two oldest autos would go — but the revert
    // target is being restored right now, so the prune has to skip it.
    const pruned = await pruneCheckpoints(pool, vault, [target]);
    expect(pruned).toContain(second);
    expect(pruned).not.toContain(target);
    expect(await checkpointIds(vault)).toContain(target);
    expect(await checkpointIds(vault)).toHaveLength(MAX_CHECKPOINTS);
  });

  // ── lazy daily capture ───────────────────────────────────────────────────

  it("takes the daily checkpoint once, and not again within the day", async () => {
    const org = await seedOrg("Acme", "acme-c5");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");
    rec.docWriter.store.set(docId, "daily");

    const first = await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter });
    expect(first?.noteCount).toBe(1);
    const second = await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter });
    expect(second).toBeNull();

    // A day later it is due again.
    await pool.query(
      "UPDATE vault_checkpoints SET created_at = now() - interval '25 hours' WHERE vault_id = $1",
      [vault],
    );
    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter })).not.toBeNull();
    expect(await checkpointIds(vault)).toHaveLength(2);
  });

  it("two simultaneous daily checks produce ONE checkpoint (advisory lock)", async () => {
    const org = await seedOrg("Acme", "acme-c6");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");
    rec.docWriter.store.set(docId, "stampede");

    const [a, b] = await Promise.all([
      maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter }),
      maybeDailyCheckpoint({ vaultId: vault, docWriter: rec.docWriter }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await checkpointIds(vault)).toHaveLength(1);
  });

  it("409s a manual create while the vault's lock is held", async () => {
    const owner = await signUp("busy@t.com");
    const org = await seedOrg("Acme", "acme-c7");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withVaultCheckpointLock(vault, async () => {
      await held;
    });
    // Give the lock holder a moment to actually take it.
    await new Promise((r) => setTimeout(r, 50));

    const res = await api(owner, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(409);

    release();
    await holding;
    expect((await api(owner, `/api/vaults/${vault}/checkpoints`, { method: "POST", body: "{}" }))
      .status).toBe(201);
  });

  // ── vault revert ─────────────────────────────────────────────────────────

  it("restores content, un-deletes notes, re-creates folders and tombstones new ones", async () => {
    const owner = await signUp("rv-owner@t.com");
    const org = await seedOrg("Acme", "acme-c8");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Docs", "Docs");
    const kept = await seedNote(vault, folder, "Docs/kept.md", owner.userId);
    const removed = await seedNote(vault, null, "gone.md", owner.userId);
    rec.docWriter.store.set(kept, "original body");
    rec.docWriter.store.set(removed, "will be deleted");

    const create = await api(owner, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ label: "good state" }),
    });
    const checkpoint = (await create.json()) as { id: string };

    // …then the vault drifts: a rewrite, a delete, a folder removal, a new note.
    rec.docWriter.store.set(kept, "a bad rewrite");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [removed]);
    await pool.query("DELETE FROM folders WHERE id = $1", [folder]); // notes.folder_id → NULL
    const fresh = await seedNote(vault, null, "fresh.md", owner.userId);
    rec.registryBroadcasts.length = 0;

    const res = await api(owner, `/api/vaults/${vault}/checkpoints/${checkpoint.id}/revert`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      ok: boolean;
      docsChanged: number;
      docsRestored: number;
      docsDeleted: number;
      foldersCreated: number;
      preRevertCheckpointId: string;
    };
    expect(result).toMatchObject({
      ok: true,
      docsChanged: 1,
      docsRestored: 1,
      docsDeleted: 1,
      foldersCreated: 1,
    });
    expect(result.preRevertCheckpointId).toBeTypeOf("string");

    // Content came back as a FORWARD write, attributed to the reverter.
    expect(rec.docWriter.store.get(kept)).toBe("original body");
    expect(rec.docWriter.writes.at(-1)).toMatchObject({
      docId: kept,
      actor: { userId: owner.userId },
    });

    const { rows } = await pool.query<{
      id: string;
      folder_id: string | null;
      rel_path: string;
      deleted_at: Date | null;
      last_edited_by: string | null;
    }>("SELECT id, folder_id, rel_path, deleted_at, last_edited_by FROM notes WHERE vault_id = $1", [
      vault,
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(kept)!.deleted_at).toBeNull();
    expect(byId.get(kept)!.folder_id).toBe(folder); // folder re-created with its ORIGINAL id
    expect(byId.get(kept)!.last_edited_by).toBe(owner.userId);
    expect(byId.get(removed)!.deleted_at).toBeNull(); // un-deleted
    expect(byId.get(fresh)!.deleted_at).not.toBeNull(); // created after the checkpoint
    expect(rec.registryBroadcasts).toContainEqual({ vaultId: vault, originId: null });

    // The undo of the revert itself.
    const { rows: pre } = await pool.query<{ kind: string; created_by: string }>(
      "SELECT kind, created_by FROM vault_checkpoints WHERE id = $1",
      [result.preRevertCheckpointId],
    );
    expect(pre[0]).toMatchObject({ kind: "auto", created_by: owner.userId });

    // Convergent: running it again changes nothing.
    const again = await api(owner, `/api/vaults/${vault}/checkpoints/${checkpoint.id}/revert`, {
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      docsChanged: 0,
      docsRestored: 0,
      docsDeleted: 0,
      foldersCreated: 0,
    });
    expect(rec.docWriter.store.get(kept)).toBe("original body");
  });

  it("captures structure-only for notes whose content never reached the server", async () => {
    // The freshly-synced-vault data-loss regression: registry rows exist the
    // moment sync turns on, but content uploads lag. A checkpoint captured in
    // that window must NOT record "" for the lagging notes — reverting to it
    // later would bulldoze the real text.
    const owner = await signUp("rv-lag@t.com");
    const org = await seedOrg("Lag", "lag-c8");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const uploaded = await seedNote(vault, null, "uploaded.md", owner.userId);
    const lagging = await seedNote(vault, null, "lagging.md", owner.userId);
    rec.docWriter.store.set(uploaded, "made it up");
    // `lagging` deliberately has NO server content: peekContent → null.

    const create = await api(owner, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const checkpoint = (await create.json()) as { id: string; noteCount: number };
    expect(checkpoint.noteCount).toBe(1); // uploaded only
    const { rows: docRows } = await pool.query(
      "SELECT doc_id FROM vault_checkpoint_docs WHERE checkpoint_id = $1",
      [checkpoint.id],
    );
    expect(docRows.map((r) => r.doc_id)).toEqual([uploaded]);

    // The upload finishes AFTER the checkpoint; a revert must leave it alone.
    rec.docWriter.store.set(lagging, "arrived after the checkpoint");
    const res = await api(owner, `/api/vaults/${vault}/checkpoints/${checkpoint.id}/revert`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(rec.docWriter.store.get(lagging)).toBe("arrived after the checkpoint");
    expect(rec.docWriter.store.get(uploaded)).toBe("made it up");
  });

  it("never bulldozes a note that has text with an empty snapshot row", async () => {
    // Belt for pre-fix checkpoints that already stored "" (and any future bug
    // that reintroduces one): the revert keeps the live text and reports it.
    const owner = await signUp("rv-guard@t.com");
    const org = await seedOrg("Guard", "guard-c8");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "precious.md", owner.userId);
    rec.docWriter.store.set(doc, "precious words");

    const create = await api(owner, `/api/vaults/${vault}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const checkpoint = (await create.json()) as { id: string };
    // Simulate a legacy bad checkpoint: an empty content row for a real note.
    await pool.query(
      "UPDATE vault_checkpoint_docs SET content = '', sha256 = $2 WHERE checkpoint_id = $1",
      [checkpoint.id, sha256Hex("")],
    );

    const res = await api(owner, `/api/vaults/${vault}/checkpoints/${checkpoint.id}/revert`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { docsChanged: number; docsKeptOverEmpty: number };
    expect(result.docsKeptOverEmpty).toBe(1);
    expect(result.docsChanged).toBe(0);
    expect(rec.docWriter.store.get(doc)).toBe("precious words");
  });

  it("404s a checkpoint from another vault", async () => {
    const owner = await signUp("rv-cross@t.com");
    const org = await seedOrg("Acme", "acme-c9");
    await seedMember(org, owner.userId, "owner");
    const vaultA = await seedVault(org, "A");
    const vaultB = await seedVault(org, "B");
    const created = await api(owner, `/api/vaults/${vaultA}/checkpoints`, {
      method: "POST",
      body: "{}",
    });
    const { id } = (await created.json()) as { id: string };

    expect(
      (await api(owner, `/api/vaults/${vaultB}/checkpoints/${id}/revert`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await api(owner, `/api/vaults/${vaultB}/checkpoints/${id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });
});
