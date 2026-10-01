import { randomUUID } from "node:crypto";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { sha256Hex } from "./capture.js";
import { isSharpShrink } from "./shrink-guard.js";
import { gcNoteTexts, storeNoteText, VERSION_CONTENT, VERSION_TEXT_JOIN } from "./texts.js";

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
): Promise<{ id: string; noteCount: number; carriedPreShrink: number }> {
  const { db, vaultId } = opts;
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

  await pruneCheckpoints(db, vaultId, [id, ...(opts.excludeFromPrune ?? [])]);
  // Housekeeping: drop texts no version or checkpoint points at any more. It
  // only ever touches `note_texts`, never an inline body of an older row.
  if (opts.gcTexts !== false) await gcNoteTexts(db, vaultId);
  return { id, noteCount, carriedPreShrink: carried.length };
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
export async function maybeDailyCheckpoint(opts: {
  vaultId: string;
  docWriter: Pick<DocWriter, "peekContent">;
  pool?: pg.Pool;
  now?: () => number;
}): Promise<{ id: string; noteCount: number } | null> {
  const pool = opts.pool ?? defaultPool;
  const now = opts.now?.() ?? Date.now();

  const due = async (db: Queryable): Promise<boolean> => {
    const { rows } = await db.query<{ at: Date | null }>(
      "SELECT max(created_at) AS at FROM vault_checkpoints WHERE vault_id = $1 AND kind = 'auto'",
      [opts.vaultId],
    );
    const at = rows[0]?.at;
    return !at || now - new Date(at).getTime() >= DAILY_CHECKPOINT_MS;
  };

  if (!(await due(pool))) return null;

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
  return outcome.acquired ? outcome.value : null;
}
