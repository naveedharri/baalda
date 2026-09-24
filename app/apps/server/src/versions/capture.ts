import { createHash } from "node:crypto";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { BULK_ORIGIN, BULK_SEED_ORIGIN } from "../sync/doc-batch.js";

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
 *  - **last_edited_by/at** (and `updated_at`) is stamped on EVERY stored change.
 *    The throttle that used to sit on the stamp — immediately when the editor
 *    changes, else at most once a minute — now sits only on the `registry-changed`
 *    broadcast that follows it, because those are two different costs: the row
 *    write is one primary-key UPDATE on a path that already appends an update row,
 *    while the broadcast makes every client in the vault re-pull the whole
 *    registry. Scripts and agents poll `notes.updated_at` to see whether their
 *    write landed, and a throttled stamp made that column lie for up to a minute
 *    (#104); an unthrottled broadcast would loop the vault the way #98 did.
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
/** Re-broadcast a stamp to the vault at most this often for the same editor.
 *  (The row itself is written every time — see the module comment.) */
const STAMP_THROTTLE_MS = 60_000;
/**
 * Writes whose origin means "a client is uploading content it already has", not
 * "a person is editing". A bulk SEED arms no idle-capture timer: the doc is
 * being seeded from the `.md` the client is the source of truth for, so there is
 * no PRIOR server state a version could preserve — and a 5,000-note import used
 * to leave 5,000 live ten-minute timers and 5,000 `Session` objects that then
 * all fired at once, each a SELECT plus a full `loadDocState` + `Y.Doc` rebuild.
 * Attribution is unaffected: the row is still stamped.
 *
 * Only the SEED qualifies, never "arrived through the batch route": the desktop
 * routes its live local-change drain through `docs/batch` too once enough notes
 * changed at once (`expectEmpty: false`), and those are real merges into docs
 * with prior state. Gating on the route instead of on the fact meant an AI
 * rewriting 40 existing notes captured ZERO versions while 24 captured 24 —
 * history that depended on how many files a tool touched at once.
 */
const NO_VERSION_SOURCES = new Set<string>([BULK_SEED_ORIGIN]);
/**
 * Sources whose `registry-changed` broadcast coalesces per VAULT instead of per
 * DOC. A batch push is one editor touching one vault inside one second, so the
 * whole push is one fan-out; a person editing is per note, and keying THAT by
 * vault let an import suppress the human's very next edit for up to a minute.
 */
const VAULT_STAMP_SOURCES = new Set<string>([BULK_ORIGIN, BULK_SEED_ORIGIN]);
/** Per-vault ceiling on how often the lazy daily-checkpoint check runs. */
const CHECKPOINT_CHECK_INTERVAL_MS = 5 * 60_000;

export type VersionCause = "idle" | "pre-revert" | "pre-shrink";

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
  // NUL cannot be stored in Postgres text (see `pgText`); hash what is stored.
  const content = pgText(input.content);
  const sha = sha256Hex(content);
  const { rows: latest } = await db.query<{ sha256: string }>(
    "SELECT sha256 FROM note_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 1",
    [input.docId],
  );
  if (latest[0]?.sha256 === sha) return null;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause, author_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.docId, input.vaultId, content, sha, input.cause, input.authorId],
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
  /** A doc was just edited by `userId` (null = unattributed). `source` is the
   *  write's origin tag when the server itself wrote it — see
   *  {@link NO_VERSION_SOURCES}. */
  touch(vaultId: string, docId: string, userId: string | null, source?: string | null): void;
  /**
   * One update just removed most of a doc's text (`versions/shrink-guard.ts`):
   * keep `previousText` — the note as it stood right before — as a
   * `pre-shrink` version. Authored by whoever edited the doc before the shrink.
   */
  preShrink(vaultId: string, docId: string, previousText: string): Promise<void>;
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
}

/** The last `registry-changed` this process announced for a scope, and who it
 *  was about. For a BULK source the scope is the vault, because the broadcast
 *  is vault-wide: every subscriber re-resolves its whole readable set and
 *  re-pulls the registry, so firing one per doc during a 100-doc batch cost ~8
 *  whole-vault ACL recomputes a second per peer and defeated the channel's
 *  120 ms coalescer (a null origin marks that window anonymous, which sends the
 *  frame to everyone including the pusher). For a LIVE edit the scope is the
 *  doc, which is the original rule: a person's first edit to any given note
 *  announces at once, however recently an import touched the same vault. */
interface Notice {
  userId: string;
  at: number;
}

export function createVersionCapture(deps: VersionCaptureDeps): VersionCapture {
  const db = deps.db ?? defaultPool;
  const idleMs = deps.idleMs ?? IDLE_CAPTURE_MS;
  const sessions = new Map<string, Session>();
  const vaultChecked = new Map<string, number>();
  /** Bulk sources, keyed by vaultId. */
  const vaultNotices = new Map<string, Notice>();
  /** Live sources, keyed by docId. Cleared with the doc's session, exactly as
   *  the throttle state did when it lived ON the session. */
  const docNotices = new Map<string, Notice>();

  async function captureIdle(docId: string): Promise<void> {
    const session = sessions.get(docId);
    if (!session) return;
    // The session is over the moment we capture it: a later edit starts a new
    // one (and re-stamps last_edited, since the throttle state goes with it).
    sessions.delete(docId);
    docNotices.delete(docId);
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

  /**
   * Write the row always; announce it only when the caller says so.
   *
   * `stampLastEdited` reports whether a live note row was actually updated, so a
   * soft-deleted (or unknown) doc still broadcasts nothing.
   */
  async function stamp(
    vaultId: string,
    docId: string,
    userId: string,
    notify: boolean,
  ): Promise<void> {
    try {
      const stamped = await stampLastEdited(docId, userId, db);
      if (stamped && notify) deps.onRegistryChanged?.(vaultId, null);
    } catch (err) {
      console.error(`[versions] last-edited stamp failed for ${docId}:`, err);
    }
  }

  return {
    touch(vaultId, docId, userId, source) {
      const now = Date.now();

      // A bulk seed arms nothing: no session, no ten-minute timer, and an
      // existing session (someone really was editing this note) is left exactly
      // as it was rather than being re-armed by an upload.
      if (!NO_VERSION_SOURCES.has(source ?? "")) {
        let session = sessions.get(docId);
        if (!session) {
          session = { vaultId, userId };
          sessions.set(docId, session);
        }
        session.vaultId = vaultId;
        session.userId = userId;

        if (session.timer) clearTimeout(session.timer);
        const timer = setTimeout(() => void captureIdle(docId), idleMs);
        // A pending capture must never hold the process open (mirrors scheduleIndex).
        if (typeof timer.unref === "function") timer.unref();
        session.timer = timer;
      }

      // Stamp the row on every edit — `notes.updated_at` is how a script or an
      // agent asks "did my write land", and it has to be true (#104). The
      // vault-wide re-pull this used to gate is what stays throttled: announce
      // immediately when the editor changes hands, else at most once a minute.
      // The sidebar's "edited by X, <time>" is therefore up to 60 s behind the
      // row, exactly as it already was.
      //
      // The KEY depends on the source. A bulk push is keyed by VAULT — one
      // editor touching one vault inside one second is one fan-out instead of
      // 100, which is what the 120 ms coalescer could never fix, because a null
      // origin marks its window anonymous and sends it to everyone. A live edit
      // keeps the original per-DOC key, so a person's first edit to a note still
      // announces immediately even if an import just stamped the same vault
      // (keying that by vault swallowed the human's edit for up to 60 s).
      if (userId) {
        const perVault = VAULT_STAMP_SOURCES.has(source ?? "");
        const notices = perVault ? vaultNotices : docNotices;
        const key = perVault ? vaultId : docId;
        const last = notices.get(key);
        const notify = !last || last.userId !== userId || now - last.at > STAMP_THROTTLE_MS;
        if (notify) notices.set(key, { userId, at: now });
        void stamp(vaultId, docId, userId, notify);
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

    async preShrink(vaultId, docId, previousText) {
      // Read the author synchronously: the shrinking edit's own `touch` follows
      // this call and would overwrite it.
      const authorId = sessions.get(docId)?.userId ?? null;
      try {
        const { rows } = await db.query<{ id: string }>(
          "SELECT id FROM notes WHERE id = $1 AND vault_id = $2 AND deleted_at IS NULL",
          [docId, vaultId],
        );
        if (!rows[0]) return;
        await recordVersion({ vaultId, docId, content: previousText, cause: "pre-shrink", authorId }, db);
      } catch (err) {
        console.error(`[versions] pre-shrink capture failed for ${docId}:`, err);
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
      vaultNotices.clear();
      docNotices.clear();
    },
  };
}
