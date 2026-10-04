import { createHash } from "node:crypto";
import { pgText } from "../db/text.js";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { BULK_ORIGIN, BULK_SEED_ORIGIN } from "../sync/doc-batch.js";
import { storeNoteText } from "./texts.js";

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
/** Recent `pre-shrink` versions kept past {@link MAX_VERSIONS_PER_NOTE}. */
export const PINNED_PRE_SHRINK = 10;
/** How long a `pre-shrink` version stays pinned (matches the shrink feed's window). */
export const PRE_SHRINK_PIN_DAYS = 30;
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
/**
 * After a sharp shrink in a vault, hold its activity-triggered checkpoint for
 * this long (#254). A device back from a long absence often makes the damaging
 * write FIRST, and that same write used to trigger the overdue daily checkpoint
 * a moment later — racing the `pre-shrink` capture and snapshotting the notes
 * already emptied. Waiting out the burst lets every `pre-shrink` row land, so
 * `captureCheckpoint` can keep the text from before the wipe instead.
 */
export const SHRINK_CHECKPOINT_HOLD_MS = 2 * 60_000;
/** After a deferred daily checkpoint, ask again this soon (not the full
 *  {@link CHECKPOINT_CHECK_INTERVAL_MS}): an upload usually finishes in seconds. */
export const CHECKPOINT_DEFER_RETRY_MS = 30_000;
/** Top-up: first-content docs are collected per vault for this long, then
 *  added to the open checkpoint in one pass. */
export const TOPUP_DEBOUNCE_MS = 30_000;
/** How long a vault's top-up window (or the absence of one) is cached. */
const TOPUP_WINDOW_CACHE_MS = 60_000;

/**
 * Did the write that just landed give this doc its FIRST server content? True
 * when the doc has no snapshot and at most one stored update — both write paths
 * (`hocuspocus.ts onChange`, `doc-batch.ts applyDetached`) append the update
 * BEFORE they report the edit, so the one row is this write. Route-agnostic: a
 * seed through the live socket counts exactly like a bulk `expectEmpty` seed.
 * One indexed probe (`doc_updates_doc_id_idx`, `doc_snapshots` pk).
 */
export async function isFirstContent(docId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rows } = await db.query<{ updates: number; snap: boolean }>(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM doc_updates WHERE doc_id = $1 LIMIT 2) u)::int AS updates,
            EXISTS (SELECT 1 FROM doc_snapshots WHERE doc_id = $1) AS snap`,
    [docId],
  );
  const r = rows[0];
  return !!r && !r.snap && r.updates <= 1;
}

/** Same shape as `checkpoints.ts TopUpWindow`; declared here so this module
 *  stays free of the checkpoint machinery (it is injected). */
export interface CheckpointTopUpWindow {
  checkpointId: string;
  expiresAt: number;
  docIds: Set<string>;
}

export interface CheckpointTopUp {
  /** The vault's newest daily checkpoint still open for top-up, or null. */
  window(vaultId: string): Promise<CheckpointTopUpWindow | null>;
  /** Add these docs' current text to the checkpoint; returns the ids now in it. */
  apply(vaultId: string, checkpointId: string, docIds: string[]): Promise<string[]>;
}

export type VersionCause = "idle" | "pre-revert" | "pre-shrink";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Insert a version for a doc, unless its latest stored version already has the
 * same sha256 (nothing changed since — this is the dedupe the whole capture
 * strategy relies on). Returns the new version id, or null when deduped or when
 * the doc has no live note row.
 *
 * A `pre-shrink` version is the one exception to the dedupe (#253). It is not a
 * snapshot of "what changed", it is the RECORD that one update just removed
 * most of the note — Activity's shrink feed and recovery list exactly these
 * rows. The note a stale device empties is usually one nobody touched since its
 * last idle version, so its pre-shrink text is that version's text, and the
 * dedupe used to swallow every such wipe without a trace. The row is still
 * cheap: text is content-addressed (`versions/texts.ts`), so it adds a
 * reference, not a second copy.
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
  if (input.cause !== "pre-shrink") {
    const { rows: latest } = await db.query<{ sha256: string }>(
      "SELECT sha256 FROM note_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 1",
      [input.docId],
    );
    if (latest[0]?.sha256 === sha) return null;
  }

  // Text first, reference second: the order the text sweep's grace relies on.
  await storeNoteText(db, { vaultId: input.vaultId, docId: input.docId, sha, content });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause, author_id)
     VALUES ($1, $2, NULL, $3, $4, $5)
     RETURNING id`,
    [input.docId, input.vaultId, sha, input.cause, input.authorId],
  );
  await pruneVersions(input.docId, db);
  // BIGSERIAL arrives as a string from node-postgres; the API hands out numbers.
  return Number(rows[0].id);
}

/**
 * Drop everything older than the newest {@link MAX_VERSIONS_PER_NOTE} versions,
 * except the recent `pre-shrink` ones (#253): a wiped note keeps being edited
 * (or keeps receiving idle captures of its empty state), and fifty of those
 * used to push the only copy of the text from before the wipe out of history
 * while the note was still empty. Up to {@link PINNED_PRE_SHRINK} of them, from
 * the last {@link PRE_SHRINK_PIN_DAYS} days, are kept regardless.
 *
 * Every clause only ever KEEPS more than the plain "newest fifty" rule did: a
 * row goes only when it is outside the newest fifty overall, outside the newest
 * fifty that are not `pre-shrink` (so the shrink rows #253 now records never
 * push an older ordinary version out sooner than before), and not pinned.
 */
export async function pruneVersions(
  docId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM note_versions
      WHERE doc_id = $1
        AND id NOT IN (
          SELECT id FROM note_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT $2
        )
        AND id NOT IN (
          SELECT id FROM note_versions
           WHERE doc_id = $1 AND cause <> 'pre-shrink' ORDER BY id DESC LIMIT $2
        )
        AND id NOT IN (
          SELECT id FROM note_versions
           WHERE doc_id = $1 AND cause = 'pre-shrink'
             AND created_at > now() - ($4::int * interval '1 day')
           ORDER BY id DESC LIMIT $3
        )`,
    [docId, MAX_VERSIONS_PER_NOTE, PINNED_PRE_SHRINK, PRE_SHRINK_PIN_DAYS],
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
  /**
   * "Was this the doc's first server content?" — a seed by any route, which
   * never triggers the daily checkpoint (see {@link isFirstContent}, wired in
   * `src/index.ts`). Omitted: only the bulk seed origin counts.
   */
  firstContent?: (docId: string) => Promise<boolean>;
  /** Top-up of the newest checkpoint with first content (wired in `src/index.ts`). */
  checkpointTopUp?: CheckpointTopUp;
  /** Override {@link TOPUP_DEBOUNCE_MS} (tests). */
  topUpDebounceMs?: number;
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
  /** Run a vault's pending checkpoint top-up NOW (test hook). */
  flushTopUp(vaultId: string): Promise<void>;
  /** Resolves once in-flight daily-checkpoint checks have settled (test hook). */
  settled(): Promise<void>;
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
  /** Last sharp shrink reported per vault — holds its daily checkpoint. */
  const vaultShrunkAt = new Map<string, number>();
  /** Bulk sources, keyed by vaultId. */
  const vaultNotices = new Map<string, Notice>();
  /** Live sources, keyed by docId. Cleared with the doc's session, exactly as
   *  the throttle state did when it lived ON the session. */
  const docNotices = new Map<string, Notice>();
  const topUpDebounceMs = deps.topUpDebounceMs ?? TOPUP_DEBOUNCE_MS;
  /** Cached top-up window per vault; `window: null` caches "none open". */
  const topUpWindows = new Map<
    string,
    { window: CheckpointTopUpWindow | null; checkedUntil: number }
  >();
  const topUpLoading = new Map<string, Promise<void>>();
  const topUpPending = new Map<
    string,
    { checkpointId: string; docIds: Set<string>; timer?: ReturnType<typeof setTimeout> }
  >();
  const inFlight = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p)).catch(() => {});
    return p;
  }

  /**
   * The activity-triggered daily checkpoint, minus two cases:
   *  - the write was the doc's first content (a seed by any route): the
   *    throttle stamp is handed back, so the next real edit asks at once;
   *  - the checkpoint deferred (uploads in flight): ask again after
   *    {@link CHECKPOINT_DEFER_RETRY_MS} instead of the full interval.
   * Without `firstContent` the call happens synchronously, as it always did.
   */
  async function dailyCheck(vaultId: string, docId: string, stampedAt: number, prevStamp: number) {
    try {
      if (deps.firstContent && (await deps.firstContent(docId))) {
        if (vaultChecked.get(vaultId) === stampedAt) {
          if (prevStamp > 0) vaultChecked.set(vaultId, prevStamp);
          else vaultChecked.delete(vaultId);
        }
        return;
      }
      const result = await deps.dailyCheckpoint!(vaultId);
      if (isDeferred(result)) {
        if (vaultChecked.get(vaultId) === stampedAt) {
          vaultChecked.set(
            vaultId,
            Date.now() - CHECKPOINT_CHECK_INTERVAL_MS + CHECKPOINT_DEFER_RETRY_MS,
          );
        }
      } else if (result && typeof result === "object" && "id" in result) {
        // A new checkpoint: its structure-only notes are the next top-up set.
        topUpWindows.delete(vaultId);
      }
    } catch (err) {
      console.error(`[versions] daily checkpoint check failed for ${vaultId}:`, err);
    }
  }

  async function loadTopUpWindow(vaultId: string, now: number): Promise<void> {
    const topUp = deps.checkpointTopUp!;
    let loading = topUpLoading.get(vaultId);
    if (!loading) {
      loading = (async () => {
        try {
          const window = await topUp.window(vaultId);
          const until = window
            ? Math.min(now + TOPUP_WINDOW_CACHE_MS, window.expiresAt)
            : now + TOPUP_WINDOW_CACHE_MS;
          topUpWindows.set(vaultId, { window, checkedUntil: until });
        } catch (err) {
          console.error(`[versions] top-up window lookup failed for ${vaultId}:`, err);
          topUpWindows.set(vaultId, { window: null, checkedUntil: now + TOPUP_WINDOW_CACHE_MS });
        } finally {
          topUpLoading.delete(vaultId);
        }
      })();
      topUpLoading.set(vaultId, loading);
    }
    await loading;
  }

  /**
   * Queue `docId` for top-up when the vault's newest daily checkpoint (under
   * an hour old) stored it structure-only. Cheap by construction: the window
   * is one cached lookup per vault per minute, and a doc outside it costs a
   * Set lookup. Any write to such a doc is its first content, by definition —
   * the checkpoint found none.
   */
  async function considerTopUp(vaultId: string, docId: string, now: number): Promise<void> {
    let cached = topUpWindows.get(vaultId);
    if (!cached || now >= cached.checkedUntil) {
      await loadTopUpWindow(vaultId, now);
      cached = topUpWindows.get(vaultId);
    }
    const window = cached?.window;
    if (!window || Date.now() >= window.expiresAt || !window.docIds.has(docId)) return;
    let pending = topUpPending.get(vaultId);
    if (pending && pending.checkpointId !== window.checkpointId) {
      if (pending.timer) clearTimeout(pending.timer);
      topUpPending.delete(vaultId);
      pending = undefined;
    }
    if (!pending) {
      pending = { checkpointId: window.checkpointId, docIds: new Set() };
      topUpPending.set(vaultId, pending);
    }
    pending.docIds.add(docId);
    if (!pending.timer) {
      const timer = setTimeout(() => void runTopUp(vaultId), topUpDebounceMs);
      if (typeof timer.unref === "function") timer.unref();
      pending.timer = timer;
    }
  }

  async function runTopUp(vaultId: string): Promise<void> {
    const pending = topUpPending.get(vaultId);
    if (!pending) return;
    topUpPending.delete(vaultId);
    if (pending.timer) clearTimeout(pending.timer);
    const ids = [...pending.docIds];
    if (ids.length === 0) return;
    try {
      const done = await deps.checkpointTopUp!.apply(vaultId, pending.checkpointId, ids);
      const window = topUpWindows.get(vaultId)?.window;
      if (window && window.checkpointId === pending.checkpointId) {
        for (const id of done) window.docIds.delete(id);
      }
      if (done.length > 0) {
        console.log(
          `[checkpoints] vault ${vaultId}: topped up checkpoint ${pending.checkpointId} with ${done.length} note(s)' first content`,
        );
      }
    } catch (err) {
      console.error(`[versions] checkpoint top-up failed for ${vaultId}:`, err);
    }
  }

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
      //
      // Two kinds of activity never trigger it (#254). A bulk SEED is a client
      // uploading what it already has — a brand-new vault's first upload used to
      // take its first checkpoint mid-flight, "structure-only" for every note
      // whose content had not arrived yet. And a vault that just had a sharp
      // shrink waits out {@link SHRINK_CHECKPOINT_HOLD_MS}: the throttle stamp is
      // left alone, so the first edit after the hold asks again.
      const shrunkAt = vaultShrunkAt.get(vaultId);
      const holding = shrunkAt !== undefined && now - shrunkAt < SHRINK_CHECKPOINT_HOLD_MS;
      if (shrunkAt !== undefined && !holding) vaultShrunkAt.delete(vaultId);
      //
      // A doc's FIRST content never triggers it either, whatever route it came
      // by (`firstContent`): a first upload of 21 notes one at a time through
      // the live socket used to take the vault's first checkpoint after note
      // one, structure-only for the other twenty.
      if (deps.dailyCheckpoint && !holding && !NO_VERSION_SOURCES.has(source ?? "")) {
        const lastCheck = vaultChecked.get(vaultId) ?? 0;
        if (now - lastCheck > CHECKPOINT_CHECK_INTERVAL_MS) {
          vaultChecked.set(vaultId, now);
          void track(dailyCheck(vaultId, docId, now, lastCheck));
        }
      }

      // Top-up rides EVERY source, the bulk seed included: a seed is exactly
      // the first content a structure-only checkpoint row is missing.
      if (deps.checkpointTopUp) {
        void track(
          considerTopUp(vaultId, docId, now).catch((err) => {
            console.error(`[versions] checkpoint top-up check failed for ${docId}:`, err);
          }),
        );
      }
    },

    async preShrink(vaultId, docId, previousText) {
      // Read the author synchronously: the shrinking edit's own `touch` follows
      // this call and would overwrite it. The checkpoint hold is set
      // synchronously for the same reason: that `touch` is what would otherwise
      // fire the daily checkpoint over the freshly emptied note.
      const authorId = sessions.get(docId)?.userId ?? null;
      vaultShrunkAt.set(vaultId, Date.now());
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

    async flushTopUp(vaultId) {
      await Promise.all([...inFlight]);
      await runTopUp(vaultId);
    },

    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    stop() {
      for (const session of sessions.values()) {
        if (session.timer) clearTimeout(session.timer);
      }
      sessions.clear();
      vaultChecked.clear();
      vaultShrunkAt.clear();
      vaultNotices.clear();
      docNotices.clear();
      for (const pending of topUpPending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      topUpPending.clear();
      topUpWindows.clear();
    },
  };
}

function isDeferred(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { deferred?: unknown }).deferred === true;
}
