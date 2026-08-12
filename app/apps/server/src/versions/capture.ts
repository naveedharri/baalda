import { createHash } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";

/**
 * Automatic version capture + "last edited by" stamping.
 *
 * Both ride the same signal — a persisted doc change with an editor identity
 * (`onDocEdited` from the sync server, `onDocWritten` from the detached doc
 * writer) — but on very different clocks:
 *
 *  - **Versions** are captured at the END of an edit session: a per-doc idle
 *    timer, re-armed on every edit, fires once the doc has been quiet for
 *    {@link IDLE_CAPTURE_MS}. That gives one version per sitting instead of one
 *    per keystroke, and no scheduler.
 *  - **last_edited_by/at** is stamped eagerly but throttled (immediately when
 *    the editor changes, else at most once a minute), because it is what a file
 *    row in every open sidebar shows.
 *
 * Versions hold MARKDOWN TEXT + sha256, never Yjs bytes: the update log is
 * compacted away, a gc'd Y.Doc can't reconstruct a past state, and both preview
 * and revert-by-forward-diff need the text itself.
 */

type Queryable = Pick<pg.Pool, "query">;

/** Doc inactivity that ends an "edit session" and triggers a capture. */
export const IDLE_CAPTURE_MS = 10 * 60_000;
/** Versions kept per note; the oldest beyond this are pruned on each capture. */
export const MAX_VERSIONS_PER_NOTE = 50;
/** Re-stamp last_edited_at at most this often for the same editor. */
const STAMP_THROTTLE_MS = 60_000;
/** Per-vault ceiling on how often the lazy daily-checkpoint check runs. */
const CHECKPOINT_CHECK_INTERVAL_MS = 5 * 60_000;

export type VersionCause = "idle" | "pre-revert";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Insert a version for a doc, unless its latest stored version already has the
 * same sha256 (nothing changed since — this is the dedupe the whole capture
 * strategy relies on). Returns the new version id, or null when deduped or when
 * the doc has no live note row.
 */
export async function recordVersion(
  input: {
    vaultId: string;
    docId: string;
    content: string;
    cause: VersionCause;
    authorId: string | null;
  },
  db: Queryable = defaultPool,
): Promise<number | null> {
  const sha = sha256Hex(input.content);
  const { rows: latest } = await db.query<{ sha256: string }>(
    "SELECT sha256 FROM note_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 1",
    [input.docId],
  );
  if (latest[0]?.sha256 === sha) return null;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause, author_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.docId, input.vaultId, input.content, sha, input.cause, input.authorId],
  );
  await pruneVersions(input.docId, db);
  // BIGSERIAL arrives as a string from node-postgres; the API hands out numbers.
  return Number(rows[0].id);
}

/** Drop everything older than the newest {@link MAX_VERSIONS_PER_NOTE} versions. */
export async function pruneVersions(
  docId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM note_versions
      WHERE doc_id = $1
        AND id NOT IN (
          SELECT id FROM note_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT $2
        )`,
    [docId, MAX_VERSIONS_PER_NOTE],
  );
  return rowCount ?? 0;
}

/**
 * Stamp who last edited a note's CONTENT. Deliberately also bumps `updated_at`
 * (human sync edits never did), and deliberately does NOT broadcast — callers
 * coalesce that themselves. Returns false when there is no live note row.
 */
export async function stampLastEdited(
  docId: string,
  userId: string | null,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE notes
        SET last_edited_by = $2, last_edited_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [docId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface VersionCaptureDeps {
  docWriter: Pick<DocWriter, "peekContent">;
  /** Broadcast so open sidebars re-pull and show the new "edited by" line. */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
  /**
   * Lazy daily vault checkpoint, invoked (throttled) on vault activity. Injected
   * rather than imported so this module stays free of the checkpoint machinery;
   * `src/index.ts` wires it to `maybeDailyCheckpoint`.
   */
  dailyCheckpoint?: (vaultId: string) => Promise<unknown>;
  db?: Queryable;
  /** Override the idle window (tests). */
  idleMs?: number;
}

export interface VersionCapture {
  /** A doc was just edited by `userId` (null = unattributed). */
  touch(vaultId: string, docId: string, userId: string | null): void;
  /** Run a doc's pending idle capture NOW (test hook / shutdown). */
  flush(docId: string): Promise<void>;
  /** Drop every pending timer. */
  stop(): void;
}

interface Session {
  vaultId: string;
  /** Last editor seen in this session — the version's author. */
  userId: string | null;
  timer?: ReturnType<typeof setTimeout>;
  stampedUserId?: string | null;
  stampedAt: number;
}

export function createVersionCapture(deps: VersionCaptureDeps): VersionCapture {
  const db = deps.db ?? defaultPool;
  const idleMs = deps.idleMs ?? IDLE_CAPTURE_MS;
  const sessions = new Map<string, Session>();
  const vaultChecked = new Map<string, number>();

  async function captureIdle(docId: string): Promise<void> {
    const session = sessions.get(docId);
    if (!session) return;
    // The session is over the moment we capture it: a later edit starts a new
    // one (and re-stamps last_edited, since the throttle state goes with it).
    sessions.delete(docId);
    if (session.timer) clearTimeout(session.timer);
    try {
      // Only live notes get versions — a soft-deleted one has nothing to show
      // them in, and its vault row may already be gone.
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM notes WHERE id = $1 AND vault_id = $2 AND deleted_at IS NULL",
        [docId, session.vaultId],
      );
      if (!rows[0]) return;
      const content = await deps.docWriter.peekContent(session.vaultId, docId);
      // No server-side state yet (content still uploading) — there is nothing
      // truthful to version. The next edit re-arms the timer.
      if (content == null) return;
      await recordVersion(
        {
          vaultId: session.vaultId,
          docId,
          content,
          cause: "idle",
          authorId: session.userId,
        },
        db,
      );
    } catch (err) {
      console.error(`[versions] idle capture failed for ${docId}:`, err);
    }
  }

  async function stamp(session: Session, docId: string, userId: string): Promise<void> {
    try {
      if (await stampLastEdited(docId, userId, db)) {
        deps.onRegistryChanged?.(session.vaultId, null);
      }
    } catch (err) {
      console.error(`[versions] last-edited stamp failed for ${docId}:`, err);
    }
  }

  return {
    touch(vaultId, docId, userId) {
      const now = Date.now();
      let session = sessions.get(docId);
      if (!session) {
        session = { vaultId, userId, stampedAt: 0 };
        sessions.set(docId, session);
      }
      session.vaultId = vaultId;
      session.userId = userId;

      if (session.timer) clearTimeout(session.timer);
      const timer = setTimeout(() => void captureIdle(docId), idleMs);
      // A pending capture must never hold the process open (mirrors scheduleIndex).
      if (typeof timer.unref === "function") timer.unref();
      session.timer = timer;

      // Stamp immediately when the editor changes hands, else at most once a
      // minute — this write lands in every open sidebar via a registry re-pull.
      if (
        userId &&
        (session.stampedUserId !== userId || now - session.stampedAt > STAMP_THROTTLE_MS)
      ) {
        session.stampedUserId = userId;
        session.stampedAt = now;
        void stamp(session, docId, userId);
      }

      // Lazy daily checkpoint: activity-triggered, no scheduler. The real
      // freshness test (and the cross-instance advisory lock) lives in
      // `maybeDailyCheckpoint`; this only keeps us from asking every keystroke.
      if (deps.dailyCheckpoint) {
        const lastCheck = vaultChecked.get(vaultId) ?? 0;
        if (now - lastCheck > CHECKPOINT_CHECK_INTERVAL_MS) {
          vaultChecked.set(vaultId, now);
          void deps.dailyCheckpoint(vaultId).catch((err) => {
            console.error(`[versions] daily checkpoint check failed for ${vaultId}:`, err);
          });
        }
      }
    },

    flush(docId) {
      return captureIdle(docId);
    },

    stop() {
      for (const session of sessions.values()) {
        if (session.timer) clearTimeout(session.timer);
      }
      sessions.clear();
      vaultChecked.clear();
    },
  };
}
