import { randomUUID } from "node:crypto";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { sha256Hex } from "./capture.js";
import { isSharpShrink } from "./shrink-guard.js";
import { gcNoteTexts, storeNoteText, VERSION_CONTENT, VERSION_TEXT_JOIN } from "./texts.js";
import { countRegisteredWithoutState, inc } from "../metrics/sync-metrics.js";

/**
 * Vault-wide checkpoints: a snapshot of the folder/note STRUCTURE (JSONB) plus
 * one row per note body, taken automatically once a day and manually by an
 * owner/admin. At most {@link MAX_CHECKPOINTS} are kept.
 *
 * Everything that mutates a vault's checkpoint set — auto capture, manual
 * capture, and a vault revert — serializes on ONE Postgres advisory lock per
 * vault, so two instances (or two impatient clicks) can't interleave a capture
 * with a revert, or both decide the daily snapshot is due.
 */

type Queryable = Pick<pg.Pool, "query">;

/** Checkpoints retained per vault (oldest `auto` pruned first, then `manual`). */
export const MAX_CHECKPOINTS = 5;
/** A pathological doc this size is skipped rather than snapshotted. */
export const MAX_CHECKPOINT_DOC_BYTES = 20 * 1024 * 1024;
/** How stale the newest `auto` checkpoint must be before another is taken. */
export const DAILY_CHECKPOINT_MS = 24 * 60 * 60 * 1000;
/**
 * A `pre-shrink` version this recent, on a note that is still shrunk, is what a
 * checkpoint stores for that note instead of its current text (#254). One day,
 * the daily cadence, so roughly the first checkpoint after a wipe carries the
 * text from before it, and a note someone emptied on purpose is not resurrected
 * by checkpoints for ever.
 */
export const CHECKPOINT_SHRINK_CARRY_MS = DAILY_CHECKPOINT_MS;
/**
 * Upload-in-flight window for the daily checkpoint's deferral. A note created
 * this recently with no server content yet, a `pending` blob, or a `files` row
 * with no ready blob means a device is mid-upload: a checkpoint taken now would
 * be structure-only for exactly the items arriving. The check is skipped and
 * asked again on later activity.
 */
export const CHECKPOINT_DEFER_MS = 120_000;
/**
 * The final safety net for the deferral: once a vault has been deferred this
 * long (a stuck pending row, a note whose content never arrives), the
 * checkpoint is taken anyway, structure-only where it must be.
 */
export const CHECKPOINT_MAX_DEFER_MS = 30 * 60_000;
/** Stateless notes confirmed per deferral check (each is one `peekContent`). */
const DEFER_PEEK_LIMIT = 20;
/**
 * How long after an automatic checkpoint a note's FIRST content is still added
 * to it ("top-up"). A note the checkpoint stored structure-only had no server
 * text at capture time; restoring it to its first content is strictly better
 * than leaving it alone, and waiting a day for the next checkpoint is not.
 */
export const CHECKPOINT_TOPUP_WINDOW_MS = 60 * 60_000;
/**
 * Bytes one checkpoint may pin in the POSTGRES blob store (plan risk 3). A
 * pinned Postgres blob whose row is deleted is retired into
 * `checkpoint_blob_bytes`, so a large pinned set is real table growth; on S3 a
 * pin only delays an object's deletion and is not capped. Files past the cap
 * are recorded structure-only and counted in the capture log, like notes.
 */
export const CHECKPOINT_BLOB_MAX_POSTGRES_BYTES = 2 * 1024 * 1024 * 1024;

export type CheckpointKind = "auto" | "manual";

export interface CheckpointNote {
  id: string;
  rel_path: string;
  folder_id: string | null;
  title: string | null;
}

export interface CheckpointFolder {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort: number;
}

export interface CheckpointStructure {
  notes: CheckpointNote[];
  folders: CheckpointFolder[];
  /**
   * Notes whose stored body is their recent `pre-shrink` text rather than the
   * (emptied) text they held at capture time — see
   * {@link CHECKPOINT_SHRINK_CARRY_MS}. Metadata only; a revert reads bodies
   * from `vault_checkpoint_docs` either way. Absent on older checkpoints.
   */
  carriedPreShrink?: string[];
}

/** The list-shape a client sees. Never carries note content. */
export interface CheckpointSummary {
  id: string;
  kind: CheckpointKind;
  label: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  noteCount: number;
}

/**
 * Run `fn` holding this vault's checkpoint lock, inside one transaction.
 *
 * `pg_try_advisory_xact_lock` — try, not wait: a second caller is told the vault
 * is busy (409) instead of queueing behind a multi-second snapshot. The lock is
 * transaction-scoped, so it is released by COMMIT/ROLLBACK even if the process
 * dies mid-revert.
 */
export async function withVaultCheckpointLock<T>(
  vaultId: string,
  fn: (db: pg.PoolClient) => Promise<T>,
  pool: pg.Pool = defaultPool,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      [`vault-checkpoint:${vaultId}`],
    );
    if (!rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { acquired: false };
    }
    try {
      const value = await fn(client);
      await client.query("COMMIT");
      return { acquired: true, value };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Read a vault's live structure — the shape stored in `structure` JSONB. */
export async function readVaultStructure(
  db: Queryable,
  vaultId: string,
): Promise<CheckpointStructure> {
  const { rows: notes } = await db.query<CheckpointNote>(
    `SELECT id, rel_path, folder_id, title
       FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path`,
    [vaultId],
  );
  const { rows: folders } = await db.query<CheckpointFolder>(
    "SELECT id, parent_id, name, path, sort FROM folders WHERE vault_id = $1 ORDER BY path",
    [vaultId],
  );
  return { notes, folders };
}

export interface CaptureCheckpointOptions {
  db: Queryable;
  docWriter: Pick<DocWriter, "peekContent">;
  vaultId: string;
  kind: CheckpointKind;
  label?: string | null;
  createdBy?: string | null;
  /** Checkpoint ids the prune must not touch (a revert's target, e.g.). */
  excludeFromPrune?: string[];
  /** Override {@link CHECKPOINT_BLOB_MAX_POSTGRES_BYTES} (tests). */
  blobMaxPostgresBytes?: number;
  /**
   * Sweep the vault's unreferenced `note_texts` afterwards (default true). A
   * revert's own undo snapshot passes false: it runs inside the revert's long
   * transaction, where the sweep's row locks would be held until the end.
   */
  gcTexts?: boolean;
}

/**
 * Snapshot a vault: structure first, then each note body sequentially (one doc
 * at a time — a vault can hold thousands, and the point is durability, not
 * speed). Prunes afterwards so the set never exceeds {@link MAX_CHECKPOINTS}.
 */
export async function captureCheckpoint(
  opts: CaptureCheckpointOptions,
): Promise<{
  id: string;
  noteCount: number;
  carriedPreShrink: number;
  /** Notes stored structure-only because the server had no content for them. */
  structureOnly: number;
  /** Binaries pinned (tree files + attachments). */
  blobCount: number;
}> {
  const { db, vaultId } = opts;
  const startedAt = Date.now();
  const structure = await readVaultStructure(db, vaultId);
  const id = randomUUID();
  const preShrink = await recentPreShrinkTexts(
    db,
    structure.notes.map((n) => n.id),
  );
  const carried: string[] = [];
  await db.query(
    `INSERT INTO vault_checkpoints (id, vault_id, kind, label, created_by, structure)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [id, vaultId, opts.kind, opts.label ?? null, opts.createdBy ?? null, JSON.stringify(structure)],
  );

  let noteCount = 0;
  // Counted, not logged per note. Both of these are ORDINARY for a large vault
  // — a freshly-synced client has thousands of notes whose CRDT has not arrived
  // yet — and a line apiece made one daily checkpoint emit thousands of them:
  // in production a 4,445-note vault buried every other log line and tripped
  // the host's 500 logs/sec ceiling, which DROPS messages. Losing the rest of
  // the log to a routine housekeeping pass is worse than not knowing which
  // individual note was skipped, so the ids are sampled and the rest counted.
  let emptyCount = 0;
  let oversizedCount = 0;
  const skippedEmpty: string[] = [];
  const skippedOversized: string[] = [];
  const SAMPLE = 5;
  for (const note of structure.notes) {
    const raw = await opts.docWriter.peekContent(vaultId, note.id);
    // NUL would abort the whole checkpoint transaction (see `pgText`).
    const content = raw == null ? null : pgText(raw);
    // `null` = the server has never seen this note's content (registered, but
    // its CRDT is still on its way up from a freshly-synced client). Recording
    // "" for it would make a later revert bulldoze the real text — the exact
    // data-loss this feature exists to prevent. Structure keeps the note; the
    // revert leaves its content alone.
    if (content == null) {
      if (skippedEmpty.length < SAMPLE) skippedEmpty.push(note.id);
      emptyCount++;
      continue;
    }
    // A note emptied by a recent sharp shrink is checkpointed as it stood
    // BEFORE the shrink (#254): the overdue daily checkpoint is typically
    // triggered by the very write that emptied it, and storing the wiped body
    // made the newest checkpoint useless for undoing exactly that damage,
    // while rotation aged out the older ones that still had the text.
    let body = content;
    const before = preShrink.get(note.id);
    if (before != null && isSharpShrink(before, content)) {
      body = before;
      carried.push(note.id);
    }
    if (Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_DOC_BYTES) {
      if (skippedOversized.length < SAMPLE) skippedOversized.push(note.id);
      oversizedCount++;
      continue;
    }
    // Content-addressed (#264): an unchanged note costs this checkpoint one
    // narrow reference row, no text. Text first, reference second: the order
    // the `note_texts` sweep's grace relies on.
    const sha = sha256Hex(body);
    await storeNoteText(db, { vaultId, docId: note.id, sha, content: body });
    await db.query(
      `INSERT INTO vault_checkpoint_docs (checkpoint_id, doc_id, sha256, content)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (checkpoint_id, doc_id) DO NOTHING`,
      [id, note.id, sha],
    );
    noteCount++;
  }

  const blobs = await captureCheckpointBlobs(db, vaultId, id, opts.blobMaxPostgresBytes);

  if (carried.length > 0) {
    await db.query(
      `UPDATE vault_checkpoints
          SET structure = jsonb_set(structure, '{carriedPreShrink}', $2::jsonb)
        WHERE id = $1`,
      [id, JSON.stringify(carried)],
    );
    console.warn(
      `[checkpoints] vault ${vaultId}: ${carried.length} recently shrunk note(s) checkpointed ` +
        `with their text from before the shrink (${sample(carried.slice(0, SAMPLE), carried.length)})`,
    );
  }

  if (emptyCount > 0 || oversizedCount > 0) {
    const parts: string[] = [];
    if (emptyCount > 0) {
      parts.push(`${emptyCount} with no server content yet (${sample(skippedEmpty, emptyCount)})`);
    }
    if (oversizedCount > 0) {
      parts.push(`${oversizedCount} oversized (${sample(skippedOversized, oversizedCount)})`);
    }
    console.warn(
      `[checkpoints] vault ${vaultId}: captured ${noteCount}/${structure.notes.length} notes; ` +
        `structure-only for ${parts.join(", ")}`,
    );
  }

  // §8 proof metric: one summary line per capture, ids and counts only.
  // `structureOnly` should trend to 0 once notes arrive with their content.
  inc("checkpoint.captures");
  inc("checkpoint.docs.text", noteCount);
  inc("checkpoint.docs.structureOnly", emptyCount);
  inc("checkpoint.docs.oversized", oversizedCount);
  console.info(
    `[checkpoint] vault=${vaultId} kind=${opts.kind} notes=${structure.notes.length} text=${noteCount} ` +
      `structureOnly=${emptyCount} oversized=${oversizedCount} carriedPreShrink=${carried.length} ` +
      `blobs=${blobs.pinned} ms=${Date.now() - startedAt}`,
  );

  await pruneCheckpoints(db, vaultId, [id, ...(opts.excludeFromPrune ?? [])]);
  // Housekeeping: drop texts no version or checkpoint points at any more. It
  // only ever touches `note_texts`, never an inline body of an older row.
  if (opts.gcTexts !== false) await gcNoteTexts(db, vaultId);
  return {
    id,
    noteCount,
    carriedPreShrink: carried.length,
    structureOnly: emptyCount,
    blobCount: blobs.pinned,
  };
}

/**
 * Pin the vault's binaries in checkpoint `checkpointId`: every registered tree
 * file with a ready blob (its newest ready row — there is one per file) and
 * every ready `attachments/` drop. One read, one bulk insert, no byte copies.
 * Pinned bytes outlive their `blobs` row (migration 047), so a later revert can
 * bring a deleted or overwritten file back under its SAME `files` id.
 */
async function captureCheckpointBlobs(
  db: Queryable,
  vaultId: string,
  checkpointId: string,
  postgresCap = CHECKPOINT_BLOB_MAX_POSTGRES_BYTES,
): Promise<{ pinned: number; overCap: number }> {
  const { rows } = await db.query<{
    file_id: string | null;
    rel_path: string;
    folder_id: string | null;
    sha256: string;
    size: string | null;
    mime: string | null;
    blob_id: string;
    storage_provider: string | null;
    storage_key: string | null;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (f.id)
              f.id AS file_id, f.path AS rel_path, f.folder_id, b.sha256, b.size, b.mime,
              b.id AS blob_id, b.storage_provider, b.storage_key
         FROM files f
         JOIN blobs b ON b.vault_id = f.vault_id AND b.doc_id = f.id
        WHERE f.vault_id = $1 AND b.status = 'ready' AND b.sha256 IS NOT NULL
        ORDER BY f.id, b.created_at DESC, b.id DESC
     ) files_part
     UNION ALL
     SELECT NULL AS file_id, b.rel_path, NULL AS folder_id, b.sha256, b.size, b.mime,
            b.id AS blob_id, b.storage_provider, b.storage_key
       FROM blobs b
      WHERE b.vault_id = $1 AND b.doc_id IS NULL AND b.status = 'ready'
        AND b.rel_path IS NOT NULL AND b.sha256 IS NOT NULL`,
    [vaultId],
  );
  if (rows.length === 0) return { pinned: 0, overCap: 0 };

  // Postgres-store bytes count toward the cap once per distinct sha: two paths
  // with the same content retire one copy.
  const counted = new Set<string>();
  let postgresBytes = 0;
  let overCap = 0;
  const keep: typeof rows = [];
  const seenPath = new Set<string>();
  for (const r of rows) {
    const pathKey = r.rel_path.toLowerCase();
    if (seenPath.has(pathKey)) continue;
    const provider = (r.storage_provider ?? "postgres").toLowerCase();
    if (provider === "postgres" && !counted.has(r.sha256)) {
      const size = Number(r.size ?? 0);
      if (postgresBytes + size > postgresCap) {
        overCap++;
        continue;
      }
      postgresBytes += size;
      counted.add(r.sha256);
    }
    seenPath.add(pathKey);
    keep.push(r);
  }

  if (keep.length > 0) {
    await db.query(
      `INSERT INTO vault_checkpoint_blobs
         (checkpoint_id, vault_id, rel_path, file_id, folder_id, sha256, size, mime,
          blob_id, storage_provider, storage_key)
       SELECT $1, $2, t.rel_path, t.file_id, t.folder_id, t.sha256, t.size, t.mime,
              t.blob_id, t.storage_provider, t.storage_key
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[],
                     $8::text[], $9::text[], $10::text[], $11::text[])
           AS t(rel_path, file_id, folder_id, sha256, size, mime, blob_id, storage_provider, storage_key)
       ON CONFLICT (checkpoint_id, rel_path) DO NOTHING`,
      [
        checkpointId,
        vaultId,
        keep.map((r) => r.rel_path),
        keep.map((r) => r.file_id),
        keep.map((r) => r.folder_id),
        keep.map((r) => r.sha256),
        keep.map((r) => (r.size == null ? null : String(r.size))),
        keep.map((r) => r.mime),
        keep.map((r) => r.blob_id),
        keep.map((r) => (r.storage_provider ?? "postgres").toLowerCase()),
        keep.map((r) => r.storage_key),
      ],
    );
  }
  if (overCap > 0) {
    console.warn(
      `[checkpoints] vault ${vaultId}: ${overCap} file(s) recorded structure-only, over the ` +
        `${postgresCap}-byte Postgres pin cap for one checkpoint`,
    );
  }
  return { pinned: keep.length, overCap };
}

/**
 * Is a device mid-upload into this vault? True when, within `windowMs`: a note
 * was created that the server holds no content for (confirmed through the doc
 * writer, which also sees a live in-memory doc whose updates are not stored
 * yet), a blob is still `pending`, or a `files` row has no ready blob.
 */
export async function vaultUploadInFlight(
  db: Queryable,
  docWriter: Pick<DocWriter, "peekContent">,
  vaultId: string,
  windowMs = CHECKPOINT_DEFER_MS,
): Promise<boolean> {
  return (await uploadInFlightReason(db, docWriter, vaultId, windowMs)) !== null;
}

/** Why a checkpoint is deferred: the first in-flight upload kind found. */
export type CheckpointDeferReason = "pending-blobs" | "files-without-bytes" | "fresh-stateless-notes";

/** {@link vaultUploadInFlight}, naming WHICH upload is in flight (null = none). */
export async function uploadInFlightReason(
  db: Queryable,
  docWriter: Pick<DocWriter, "peekContent">,
  vaultId: string,
  windowMs = CHECKPOINT_DEFER_MS,
): Promise<CheckpointDeferReason | null> {
  const { rows: binaries } = await db.query<{ pending: boolean; unbacked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM blobs b
        WHERE b.vault_id = $1 AND b.status = 'pending'
          AND b.created_at > now() - ($2::bigint * interval '1 millisecond')
     ) AS pending, EXISTS (
       SELECT 1 FROM files f
        WHERE f.vault_id = $1
          AND f.created_at > now() - ($2::bigint * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM blobs b
             WHERE b.vault_id = f.vault_id AND b.doc_id = f.id AND b.status = 'ready'
          )
     ) AS unbacked`,
    [vaultId, windowMs],
  );
  if (binaries[0]?.pending) return "pending-blobs";
  if (binaries[0]?.unbacked) return "files-without-bytes";

  const { rows: notes } = await db.query<{ id: string }>(
    `SELECT n.id FROM notes n
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL AND n.confirmed_empty_at IS NULL
        AND n.created_at > now() - ($2::bigint * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM doc_snapshots s WHERE s.doc_id = n.id)
        AND NOT EXISTS (SELECT 1 FROM doc_updates u WHERE u.doc_id = n.id)
      ORDER BY n.created_at DESC
      LIMIT $3`,
    [vaultId, windowMs, DEFER_PEEK_LIMIT],
  );
  for (const n of notes) {
    if ((await docWriter.peekContent(vaultId, n.id)) == null) return "fresh-stateless-notes";
  }
  return null;
}

/** The newest daily checkpoint still open for top-up, and the notes it stored
 *  structure-only. Null when there is none younger than `windowMs`. */
export interface TopUpWindow {
  checkpointId: string;
  /** Epoch ms after which the checkpoint is too old to top up. */
  expiresAt: number;
  docIds: Set<string>;
}

export async function loadTopUpWindow(
  db: Queryable,
  vaultId: string,
  opts: { windowMs?: number; now?: number } = {},
): Promise<TopUpWindow | null> {
  const windowMs = opts.windowMs ?? CHECKPOINT_TOPUP_WINDOW_MS;
  const now = opts.now ?? Date.now();
  // Daily checkpoints only: a labelled `auto` is a revert's undo snapshot, and
  // a manual one is a moment someone chose — neither should change afterwards.
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM vault_checkpoints
      WHERE vault_id = $1 AND kind = 'auto' AND label IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [vaultId],
  );
  const cp = rows[0];
  if (!cp) return null;
  const expiresAt = new Date(cp.created_at).getTime() + windowMs;
  if (now >= expiresAt) return null;
  const { rows: missing } = await db.query<{ id: string }>(
    `SELECT n->>'id' AS id
       FROM vault_checkpoints c, jsonb_array_elements(coalesce(c.structure->'notes', '[]'::jsonb)) n
      WHERE c.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM vault_checkpoint_docs d
           WHERE d.checkpoint_id = c.id AND d.doc_id = n->>'id'
        )`,
    [cp.id],
  );
  return { checkpointId: cp.id, expiresAt, docIds: new Set(missing.map((r) => r.id)) };
}

/**
 * Add the current text of `docIds` to checkpoint `checkpointId`, for the ones
 * that have server content now. Idempotent: an existing row is left alone, and
 * a checkpoint pruned in the meantime gets nothing. Returns the doc ids that
 * now have a row.
 */
export async function topUpCheckpoint(
  db: Queryable,
  docWriter: Pick<DocWriter, "peekContent">,
  vaultId: string,
  checkpointId: string,
  docIds: string[],
): Promise<string[]> {
  const done: string[] = [];
  for (const docId of docIds) {
    const raw = await docWriter.peekContent(vaultId, docId);
    if (raw == null) continue;
    const body = pgText(raw);
    if (Buffer.byteLength(body, "utf8") > MAX_CHECKPOINT_DOC_BYTES) continue;
    const sha = sha256Hex(body);
    // Text first, reference second, as in `captureCheckpoint`.
    await storeNoteText(db, { vaultId, docId, sha, content: body });
    const { rowCount } = await db.query(
      `INSERT INTO vault_checkpoint_docs (checkpoint_id, doc_id, sha256, content)
       SELECT $1, $2, $3, NULL
        WHERE EXISTS (SELECT 1 FROM vault_checkpoints WHERE id = $1 AND vault_id = $4)
       ON CONFLICT (checkpoint_id, doc_id) DO NOTHING`,
      [checkpointId, docId, sha, vaultId],
    );
    const { rows } = await db.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM vault_checkpoint_docs WHERE checkpoint_id = $1 AND doc_id = $2) AS ok",
      [checkpointId, docId],
    );
    if ((rowCount ?? 0) > 0 || rows[0]?.ok) done.push(docId);
  }
  return done;
}

/**
 * Each doc's newest `pre-shrink` text from the last
 * {@link CHECKPOINT_SHRINK_CARRY_MS}, for the docs that have one. One indexed
 * query (`note_versions_doc_idx`) for the whole vault; the hits are rare.
 */
async function recentPreShrinkTexts(
  db: Queryable,
  docIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (docIds.length === 0) return out;
  const { rows } = await db.query<{ doc_id: string; content: string | null }>(
    `SELECT DISTINCT ON (v.doc_id) v.doc_id, ${VERSION_CONTENT} AS content
       FROM note_versions v ${VERSION_TEXT_JOIN}
      WHERE v.doc_id = ANY($1::text[]) AND v.cause = 'pre-shrink'
        AND v.created_at > now() - ($2::bigint * interval '1 millisecond')
      ORDER BY v.doc_id, v.id DESC`,
    [docIds, CHECKPOINT_SHRINK_CARRY_MS],
  );
  for (const r of rows) if (r.content != null) out.set(r.doc_id, pgText(r.content));
  return out;
}

/** `a, b, c …+97 more` — enough to chase one, never enough to flood. */
function sample(ids: string[], total: number): string {
  const more = total - ids.length;
  return more > 0 ? `${ids.join(", ")} …+${more} more` : ids.join(", ");
}

/**
 * Keep at most {@link MAX_CHECKPOINTS} per vault. Automatic snapshots go first
 * (oldest first) — they cost the user nothing to lose, since another one is due
 * within a day — and only then the oldest manual ones, which someone chose to
 * take. `excludeIds` protects checkpoints that are mid-flight (a revert's target
 * and the pre-revert snapshot that is its undo).
 */
export async function pruneCheckpoints(
  db: Queryable,
  vaultId: string,
  excludeIds: string[] = [],
): Promise<string[]> {
  const { rows } = await db.query<{ id: string; kind: CheckpointKind }>(
    "SELECT id, kind FROM vault_checkpoints WHERE vault_id = $1 ORDER BY created_at ASC, id ASC",
    [vaultId],
  );
  const overflow = rows.length - MAX_CHECKPOINTS;
  if (overflow <= 0) return [];

  const excluded = new Set(excludeIds);
  const candidates = [
    ...rows.filter((r) => r.kind === "auto"),
    ...rows.filter((r) => r.kind === "manual"),
  ].filter((r) => !excluded.has(r.id));
  const victims = candidates.slice(0, overflow).map((r) => r.id);
  if (victims.length === 0) return [];
  await db.query("DELETE FROM vault_checkpoints WHERE id = ANY($1::text[])", [victims]);
  return victims;
}

/** Checkpoint list for a vault, newest first. */
export async function listCheckpoints(
  db: Queryable,
  vaultId: string,
): Promise<CheckpointSummary[]> {
  const { rows } = await db.query<{
    id: string;
    kind: CheckpointKind;
    label: string | null;
    created_at: Date;
    created_by: string | null;
    created_by_name: string | null;
    note_count: number;
  }>(
    `SELECT c.id, c.kind, c.label, c.created_at, c.created_by,
            u.name AS created_by_name,
            (SELECT count(*) FROM vault_checkpoint_docs d WHERE d.checkpoint_id = c.id)::int
              AS note_count
       FROM vault_checkpoints c
       LEFT JOIN "user" u ON u.id = c.created_by
      WHERE c.vault_id = $1
      ORDER BY c.created_at DESC, c.id DESC`,
    [vaultId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    noteCount: r.note_count,
  }));
}

/** One checkpoint's summary row (after a create), or null if it's gone. */
export async function getCheckpointSummary(
  db: Queryable,
  vaultId: string,
  checkpointId: string,
): Promise<CheckpointSummary | null> {
  const all = await listCheckpoints(db, vaultId);
  return all.find((c) => c.id === checkpointId) ?? null;
}

/**
 * Take the daily automatic checkpoint if one is due. Called on vault activity
 * (throttled in-process by the capture layer), so there is no scheduler.
 *
 * The age test is made twice: once cheaply outside the lock, and again INSIDE
 * it, because "is a snapshot due?" is exactly the question two instances answer
 * simultaneously at midnight. Returns null when not due or when another caller
 * holds the lock.
 */
/** First deferral per vault, for {@link CHECKPOINT_MAX_DEFER_MS}. Process-local:
 *  another instance keeps its own, which only ever defers less. */
const deferredSince = new Map<string, number>();

export type DailyCheckpointOutcome =
  | { id: string; noteCount: number; structureOnly: number }
  | { deferred: true };

export function isDeferredCheckpoint(v: unknown): v is { deferred: true } {
  return typeof v === "object" && v !== null && (v as { deferred?: unknown }).deferred === true;
}

export async function maybeDailyCheckpoint(opts: {
  vaultId: string;
  docWriter: Pick<DocWriter, "peekContent">;
  pool?: pg.Pool;
  now?: () => number;
  /** Override {@link CHECKPOINT_DEFER_MS} (tests). 0 disables the deferral. */
  deferMs?: number;
  /** Override {@link CHECKPOINT_MAX_DEFER_MS} (tests). */
  maxDeferMs?: number;
}): Promise<DailyCheckpointOutcome | null> {
  const pool = opts.pool ?? defaultPool;
  const now = opts.now?.() ?? Date.now();
  const deferMs = opts.deferMs ?? CHECKPOINT_DEFER_MS;
  const maxDeferMs = opts.maxDeferMs ?? CHECKPOINT_MAX_DEFER_MS;

  const due = async (db: Queryable): Promise<boolean> => {
    const { rows } = await db.query<{ at: Date | null }>(
      "SELECT max(created_at) AS at FROM vault_checkpoints WHERE vault_id = $1 AND kind = 'auto'",
      [opts.vaultId],
    );
    const at = rows[0]?.at;
    return !at || now - new Date(at).getTime() >= DAILY_CHECKPOINT_MS;
  };

  if (!(await due(pool))) {
    deferredSince.delete(opts.vaultId);
    return null;
  }

  // Deferral: a device mid-upload would leave this checkpoint structure-only
  // for exactly the notes and files that are arriving. Ask again on later
  // activity; past the cap, take it anyway (structure-only where it must be).
  if (deferMs > 0) {
    const since = deferredSince.get(opts.vaultId);
    const capped = since !== undefined && now - since >= maxDeferMs;
    const reason = capped ? null : await uploadInFlightReason(pool, opts.docWriter, opts.vaultId, deferMs);
    if (reason) {
      if (since === undefined) deferredSince.set(opts.vaultId, now);
      await recordDeferral(pool, opts.vaultId, reason, since === undefined ? 0 : now - since, now);
      return { deferred: true };
    }
    if (capped) {
      console.warn(
        `[checkpoints] vault ${opts.vaultId}: uploads still in flight after ${maxDeferMs} ms of deferral; ` +
          "taking the daily checkpoint anyway",
      );
    }
  }

  const outcome = await withVaultCheckpointLock(
    opts.vaultId,
    async (db) => {
      if (!(await due(db))) return null;
      return captureCheckpoint({
        db,
        docWriter: opts.docWriter,
        vaultId: opts.vaultId,
        kind: "auto",
        createdBy: null,
      });
    },
    pool,
  );
  if (outcome.acquired && outcome.value) deferredSince.delete(opts.vaultId);
  return outcome.acquired ? outcome.value : null;
}

/** Notes registered longer ago than this with no CRDT count as "stateless" (§8). */
const STATELESS_GAUGE_AGE_S = 60;
/** At most one deferral line (and one gauge query) per vault per this long. */
const DEFERRAL_LOG_EVERY_MS = 60_000;
const lastDeferralLog = new Map<string, number>();

/**
 * Count a deferral and, at most once a minute per vault, log it. The
 * fresh-stateless-notes reason is the one place the "registered without state"
 * gauge is already the question being asked, so the gauge rides along there
 * instead of on a scheduled job:
 *
 *   [checkpoint] vault=<id> deferred reason=<reason> deferredMs=N statelessOver60s=N[+]
 */
async function recordDeferral(
  db: Queryable,
  vaultId: string,
  reason: CheckpointDeferReason,
  deferredMs: number,
  now: number,
): Promise<void> {
  inc("checkpoint.deferred");
  inc(`checkpoint.deferred.${reason}`);
  const last = lastDeferralLog.get(vaultId);
  if (last !== undefined && now - last < DEFERRAL_LOG_EVERY_MS) return;
  lastDeferralLog.set(vaultId, now);
  let gauge = "";
  if (reason === "fresh-stateless-notes") {
    try {
      const { count, capped } = await countRegisteredWithoutState(db, vaultId, STATELESS_GAUGE_AGE_S);
      gauge = ` statelessOver${STATELESS_GAUGE_AGE_S}s=${count}${capped ? "+" : ""}`;
    } catch {
      // The gauge is a diagnostic; a failed probe must never block the deferral.
      gauge = ` statelessOver${STATELESS_GAUGE_AGE_S}s=?`;
    }
  }
  console.info(
    `[checkpoint] vault=${vaultId} deferred reason=${reason} deferredMs=${deferredMs}${gauge}`,
  );
}

/** Forget every vault's deferral clock (tests). */
export function resetCheckpointDeferrals(): void {
  deferredSince.clear();
  lastDeferralLog.clear();
}
