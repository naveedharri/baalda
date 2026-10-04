import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { BULK_SEED_ORIGIN } from "../src/sync/doc-batch.js";
import { createVersionCapture, isFirstContent } from "../src/versions/capture.js";
import {
  captureCheckpoint,
  loadTopUpWindow,
  maybeDailyCheckpoint,
  resetCheckpointDeferrals,
  topUpCheckpoint,
  CHECKPOINT_MAX_DEFER_MS,
} from "../src/versions/checkpoints.js";
import { revertVaultToCheckpoint } from "../src/versions/revert.js";
import { memoryDocWriter } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedFile, seedNote, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * Checkpoints that heal themselves around an upload (PR1 of the one-step note
 * sync plan): a seed by ANY route never triggers the daily checkpoint, the
 * checkpoint defers while uploads are in flight, a structure-only note is
 * topped up with its first content, and binaries are pinned and restorable.
 */

const sha = (c: string) => c.repeat(64).slice(0, 64);

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

async function appendUpdate(docId: string): Promise<void> {
  await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)", [
    docId,
    Buffer.from([0]),
  ]);
}

afterAll(async () => {
  await pool.end();
});

describe("checkpoint healing", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    resetCheckpointDeferrals();
    owner = await signUp("owner@cp-heal.test");
    org = await seedOrg("Heal Co", `heal-${randomUUID().slice(0, 8)}`);
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });

  // ── 1. route-agnostic seed ───────────────────────────────────────────────

  it("first content through the live route does not trigger the checkpoint; the second edit does", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const dailyCheckpoint = vi.fn(async (_vaultId: string) => null);
    const capture = createVersionCapture({
      docWriter: memoryDocWriter(),
      idleMs: 60_000,
      dailyCheckpoint,
      firstContent: (id) => isFirstContent(id),
    });
    try {
      await appendUpdate(docId); // the write the touch reports is already stored
      capture.touch(vault, docId, null);
      await capture.settled();
      expect(dailyCheckpoint).not.toHaveBeenCalled();

      await appendUpdate(docId);
      capture.touch(vault, docId, null);
      await capture.settled();
      expect(dailyCheckpoint).toHaveBeenCalledWith(vault);
    } finally {
      capture.stop();
    }
  });

  it("twenty-one notes seeded one by one never trigger the checkpoint", async () => {
    const dailyCheckpoint = vi.fn(async (_vaultId: string) => null);
    const capture = createVersionCapture({
      docWriter: memoryDocWriter(),
      idleMs: 60_000,
      dailyCheckpoint,
      firstContent: (id) => isFirstContent(id),
    });
    try {
      for (let i = 0; i < 21; i++) {
        const docId = await seedNote(vault, null, `n${i}.md`, owner.userId);
        await appendUpdate(docId);
        capture.touch(vault, docId, owner.userId);
        await capture.settled();
      }
      expect(dailyCheckpoint).not.toHaveBeenCalled();
    } finally {
      capture.stop();
    }
  });

  it("a doc with a snapshot is never first content", async () => {
    const docId = await seedNote(vault, null, "s.md", owner.userId);
    await pool.query("INSERT INTO doc_snapshots (doc_id, snapshot) VALUES ($1, $2)", [
      docId,
      Buffer.from([0]),
    ]);
    expect(await isFirstContent(docId)).toBe(false);
  });

  // ── 2. deferral ─────────────────────────────────────────────────────────

  it("defers while a fresh note has no content, then captures after the cap", async () => {
    const writer = memoryDocWriter();
    const ready = await seedNote(vault, null, "ready.md", owner.userId);
    writer.store.set(ready, "here");
    await seedNote(vault, null, "arriving.md", owner.userId); // no content yet

    const t0 = Date.now();
    const first = await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer, now: () => t0 });
    expect(first).toEqual({ deferred: true });
    expect(await count("SELECT count(*) AS n FROM vault_checkpoints WHERE vault_id = $1", [vault])).toBe(0);

    const capped = await maybeDailyCheckpoint({
      vaultId: vault,
      docWriter: writer,
      now: () => t0 + CHECKPOINT_MAX_DEFER_MS + 1,
    });
    expect(capped).toMatchObject({ noteCount: 1, structureOnly: 1 });
  });

  it("defers on a pending blob and on a files row with no ready blob", async () => {
    const writer = memoryDocWriter();
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, rel_path, storage_provider, status)
       VALUES ($1, $2, $3, $4, 3, 'attachments/a.png', 'postgres', 'pending')`,
      [randomUUID(), vault, org, sha("a")],
    );
    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer })).toEqual({ deferred: true });

    await pool.query("DELETE FROM blobs WHERE vault_id = $1", [vault]);
    resetCheckpointDeferrals();
    await seedFile(vault, null, "doc.pdf");
    expect(await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer })).toEqual({ deferred: true });
  });

  it("a deferred check is retried soon instead of after the full interval", async () => {
    const results: unknown[] = [{ deferred: true }, null];
    const dailyCheckpoint = vi.fn(async (_vaultId: string) => results.shift() ?? null);
    const capture = createVersionCapture({ docWriter: memoryDocWriter(), idleMs: 60_000, dailyCheckpoint });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      capture.touch(vault, "d1", null);
      await capture.settled();
      expect(dailyCheckpoint).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 31_000);
      capture.touch(vault, "d1", null);
      await capture.settled();
      expect(dailyCheckpoint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      capture.stop();
    }
  });

  // ── 3. top-up ───────────────────────────────────────────────────────────

  it("tops up a structure-only note within the window, idempotently, and not after", async () => {
    const writer = memoryDocWriter();
    const late = await seedNote(vault, null, "late.md", owner.userId);
    const made = await captureCheckpoint({ db: pool, docWriter: writer, vaultId: vault, kind: "auto" });
    expect(made.structureOnly).toBe(1);

    const window = await loadTopUpWindow(pool, vault);
    expect(window?.checkpointId).toBe(made.id);
    expect(window?.docIds.has(late)).toBe(true);

    // Content not there yet: nothing inserted.
    expect(await topUpCheckpoint(pool, writer, vault, made.id, [late])).toEqual([]);

    writer.store.set(late, "first words");
    expect(await topUpCheckpoint(pool, writer, vault, made.id, [late])).toEqual([late]);
    expect(await topUpCheckpoint(pool, writer, vault, made.id, [late])).toEqual([late]);
    expect(
      await count("SELECT count(*) AS n FROM vault_checkpoint_docs WHERE checkpoint_id = $1", [made.id]),
    ).toBe(1);
    expect((await loadTopUpWindow(pool, vault))?.docIds.has(late)).toBe(false);

    await pool.query(
      "UPDATE vault_checkpoints SET created_at = now() - interval '2 hours' WHERE id = $1",
      [made.id],
    );
    expect(await loadTopUpWindow(pool, vault)).toBeNull();
  });

  it("the capture layer tops up on a seed touch", async () => {
    const writer = memoryDocWriter();
    const late = await seedNote(vault, null, "late.md", owner.userId);
    const made = await captureCheckpoint({ db: pool, docWriter: writer, vaultId: vault, kind: "auto" });
    const capture = createVersionCapture({
      docWriter: writer,
      idleMs: 60_000,
      topUpDebounceMs: 60_000,
      checkpointTopUp: {
        window: (v) => loadTopUpWindow(pool, v),
        apply: (v, cp, ids) => topUpCheckpoint(pool, writer, v, cp, ids),
      },
    });
    try {
      writer.store.set(late, "arrived");
      capture.touch(vault, late, owner.userId, BULK_SEED_ORIGIN);
      await capture.flushTopUp(vault);
      const { rows } = await pool.query<{ doc_id: string }>(
        "SELECT doc_id FROM vault_checkpoint_docs WHERE checkpoint_id = $1",
        [made.id],
      );
      expect(rows.map((r) => r.doc_id)).toEqual([late]);
    } finally {
      capture.stop();
    }
  });

  // ── 4. binaries ─────────────────────────────────────────────────────────

  it("pins files and attachments, keeps a deleted file's bytes, and a revert restores it under the same id", async () => {
    const writer = memoryDocWriter();
    const fileId = await seedFile(vault, null, "report.pdf");
    await seedBlob(vault, org, "report.pdf", { docId: fileId, sha256: sha("f") });
    await seedBlob(vault, org, "attachments/pic.png", { sha256: sha("p") });

    const made = await captureCheckpoint({ db: pool, docWriter: writer, vaultId: vault, kind: "manual" });
    expect(made.blobCount).toBe(2);
    const { rows: pins } = await pool.query<{ file_id: string | null; sha256: string }>(
      "SELECT file_id, sha256 FROM vault_checkpoint_blobs WHERE checkpoint_id = $1 ORDER BY rel_path",
      [made.id],
    );
    expect(pins).toEqual([
      { file_id: null, sha256: sha("p") },
      { file_id: fileId, sha256: sha("f") },
    ]);

    // Delete the file the way the registry does: blob rows, row, tombstone.
    await pool.query("DELETE FROM blobs WHERE doc_id = $1", [fileId]);
    await pool.query("DELETE FROM files WHERE id = $1", [fileId]);
    await pool.query("INSERT INTO file_tombstones (id, vault_id, path) VALUES ($1, $2, 'report.pdf')", [
      fileId,
      vault,
    ]);
    expect(
      await count("SELECT count(*) AS n FROM checkpoint_blob_bytes WHERE vault_id = $1 AND sha256 = $2", [
        vault,
        sha("f"),
      ]),
    ).toBe(1);

    const out = await revertVaultToCheckpoint({
      vaultId: vault,
      checkpointId: made.id,
      userId: owner.userId,
      docWriter: writer,
    });
    expect(out.acquired).toBe(true);
    if (!out.acquired) return;
    expect(out.result.filesRestored).toBe(1);

    expect(await count("SELECT count(*) AS n FROM files WHERE id = $1 AND vault_id = $2", [fileId, vault])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM file_tombstones WHERE id = $1", [fileId])).toBe(0);
    const { rows: blob } = await pool.query<{ data: Buffer }>(
      "SELECT data FROM blobs WHERE vault_id = $1 AND doc_id = $2 AND status = 'ready' AND sha256 = $3",
      [vault, fileId, sha("f")],
    );
    expect(blob[0]?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("a revert points a live file that moved on back at the pinned bytes", async () => {
    const writer = memoryDocWriter();
    const fileId = await seedFile(vault, null, "sheet.xlsx");
    await seedBlob(vault, org, "sheet.xlsx", { docId: fileId, sha256: sha("1") });
    const made = await captureCheckpoint({ db: pool, docWriter: writer, vaultId: vault, kind: "manual" });

    // A new version replaces the old one (one ready row per file).
    await pool.query("DELETE FROM blobs WHERE doc_id = $1", [fileId]);
    await seedBlob(vault, org, "sheet.xlsx", { docId: fileId, sha256: sha("2") });

    const out = await revertVaultToCheckpoint({
      vaultId: vault,
      checkpointId: made.id,
      userId: owner.userId,
      docWriter: writer,
    });
    if (!out.acquired) throw new Error("lock");
    expect(out.result.fileBytesRestored).toBe(1);
    const { rows } = await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM blobs WHERE vault_id = $1 AND doc_id = $2 AND status = 'ready'",
      [vault, fileId],
    );
    expect(rows.map((r) => r.sha256)).toEqual([sha("1")]);
  });

  it("pruning the last pinning checkpoint frees retired bytes and re-queues an S3 object", async () => {
    const writer = memoryDocWriter();
    const fileId = await seedFile(vault, null, "a.bin");
    await seedBlob(vault, org, "a.bin", { docId: fileId, sha256: sha("b") });
    const s3File = await seedFile(vault, null, "big.mov");
    const key = `vaults/${vault}/${sha("c")}`;
    await pool.query(
      `INSERT INTO blobs (id, vault_id, org_id, sha256, size, rel_path, filename,
                          storage_provider, storage_key, status, doc_id)
       VALUES ($1, $2, $3, $4, 10, 'big.mov', 'big.mov', 's3', $5, 'ready', $6)`,
      [randomUUID(), vault, org, sha("c"), key, s3File],
    );
    const made = await captureCheckpoint({ db: pool, docWriter: writer, vaultId: vault, kind: "manual" });
    expect(made.blobCount).toBe(2);

    await pool.query("DELETE FROM blobs WHERE vault_id = $1", [vault]);
    const queuedAfterDelete = await count(
      "SELECT count(*) AS n FROM blob_deletions WHERE storage_key = $1",
      [key],
    );
    expect(
      await count("SELECT count(*) AS n FROM checkpoint_blob_bytes WHERE vault_id = $1", [vault]),
    ).toBe(1);

    await pool.query("DELETE FROM vault_checkpoints WHERE id = $1", [made.id]);
    expect(
      await count("SELECT count(*) AS n FROM checkpoint_blob_bytes WHERE vault_id = $1", [vault]),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS n FROM blob_deletions WHERE storage_key = $1", [key]),
    ).toBe(queuedAfterDelete + 1);
  });

  it("files past the Postgres pin cap are recorded structure-only", async () => {
    const writer = memoryDocWriter();
    const fileId = await seedFile(vault, null, "x.bin");
    await seedBlob(vault, org, "x.bin", { docId: fileId, sha256: sha("x"), size: 3 });
    const made = await captureCheckpoint({
      db: pool,
      docWriter: writer,
      vaultId: vault,
      kind: "manual",
      blobMaxPostgresBytes: 2,
    });
    expect(made.blobCount).toBe(0);
  });
});
