// Bulk content upload — the half of "turn on sync" that did not exist.
//
// Reconcile only ever registered STRUCTURE: it created a `notes` row (and hence
// an EMPTY server Y.Doc) per file. A note's markdown reached the server solely
// when a human opened that note in the editor, so a 500-note vault reported
// "Synced" while 500 empty docs sat on the server. This module pushes the
// content, through the existing bridge + provider machinery, in a bounded,
// checkpointed, cancellable queue.
//
// ── The idempotency guarantee (the single most important property) ────────────
// Re-running this must NOT duplicate a note's text. It cannot, because the only
// ways text ever enters a doc here are `NoteBridge.seedFromFileIfEmpty()` and —
// on `ingestFromFile` runs — `NoteBridge.ingestNow()`, whose echo-hash +
// converged-content guards make a re-run of the same file bytes a no-op (it
// applies a DIFF against the doc's current text, never an insert of the whole
// file). For the seed path:
//
//   1. it inserts nothing when the Y.Text is already non-empty; and
//   2. it is called ONLY after the provider's initial server sync has genuinely
//      landed (`isSynced`, not merely "the timeout elapsed"), so the server's
//      canonical state is already merged into the doc before we look at it.
//
// So a second run finds the doc non-empty — either from the CRDT the first run
// persisted locally, or from the server state it just pulled — and inserts
// nothing. Transmitting is separately idempotent: Yjs updates are keyed by
// (clientId, clock), so re-sending state the server already has is a no-op.
//
// Doubling would require inserting the same text twice under two DIFFERENT
// client ids (two Y.Docs both seeding from the same file). (1) and (2) are
// exactly what make that impossible; reversing (2) — seeding before the pull —
// is the bug that would double every note, which is why the order is asserted in
// `contentUpload.test.ts`.
//
// Pure with respect to I/O: every dependency (bridge acquisition, provider
// creation, timers) is injected, so the whole engine runs under vitest in Node.

import type * as Y from "yjs";
import { encodeStateAsUpdate } from "yjs";
import type { NoteBridge } from "../bridge";
import { UPLOAD_CONCURRENCY, runPool } from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";

/** The network side of one doc's push. Implemented by `DocSync` in production. */
export interface DocPush {
  /** View-only grant: we must not attempt to push (the server would refuse). */
  readonly readOnly: boolean;
  /** True once the initial server sync genuinely completed. */
  readonly isSynced: boolean;
  /** Resolve when the initial sync lands, or after `timeoutMs` either way. */
  whenSynced(timeoutMs: number): Promise<void>;
  /** Resolve true once the server has acked every local change; false on timeout. */
  whenFlushed(timeoutMs: number): Promise<boolean>;
  destroy(): void;
}

export interface ContentUploadDeps {
  /** Take a resident bridge for a doc (`VaultDocStore.promote`, no file seed). */
  acquire(docId: string, relPath: string): Promise<NoteBridge>;
  /** Flush + tear the bridge down (`VaultDocStore.demote`). */
  release(docId: string): Promise<void>;
  /** Attach a network provider to the bridge's Y.Doc (`new DocSync(...)`). */
  connect(input: { docId: string; vaultId: string; doc: Y.Doc }): DocPush;
  /**
   * Read a note's current file text (`ipc.readNote`, epoch-pinned). Optional so
   * the older harnesses need not provide it; when present it powers the two
   * pre-network checks in {@link ContentUploader.pushOne}: the empty-everywhere
   * short-circuit and the size ceiling.
   */
  readFile?(relPath: string): Promise<string>;
}

/**
 * The note-size ceiling, mirroring the server's `MAX_NOTE_MB` default (10 MB;
 * `sync/hocuspocus.ts` refuses any sync message above it and closes the socket).
 *
 * Checked BEFORE a provider is opened. Without it a file over the cap was pushed
 * on every connect: the server closed the connection, the push read as "server
 * did not acknowledge", and — because the server still held nothing for the doc —
 * the next `ready.empty` queued it again. Two such files in one production vault
 * cost a rejected socket apiece on every reconnect of every member, forever.
 * Here the doc fails ONCE, permanently, with a reason a person can act on.
 *
 * ── Measure the DOC, not just the file ───────────────────────────────────────
 * The cap has to be applied to both, because they are different numbers and the
 * server only ever sees one of them. What goes on the wire is the encoded Yjs
 * state; the `.md` on disk is just the text that state currently serializes to.
 * A doc carrying megabytes of CRDT history — duplication garbage from a past
 * fork/ping-pong, say — can sit behind a file of ZERO bytes.
 *
 * Checking only the file is how this bug came back: four notes in a production
 * vault held 10–17 MB of Yjs state behind 0-byte files, so the file check
 * passed, a socket opened, the server rejected the ~17 MB message and closed the
 * connection, the provider reconnected — about once a second, forever, strobing
 * the sync badge. {@link crdtBytes} is the measurement that matches the server's.
 */
export const MAX_NOTE_BYTES = 10 * 1024 * 1024;

/**
 * What this doc would put on the wire: its full encoded Yjs state.
 *
 * Deliberately the conservative measure. The provider actually sends only the
 * diff the server lacks, which can be smaller — but a doc whose ENTIRE state is
 * over the cap is pathological for a markdown note however you slice it, and
 * refusing it locally is strictly better than learning the same thing from a
 * closed socket. Costs one encode per doc per run, on a doc already in memory.
 */
export function crdtBytes(doc: Y.Doc): number {
  return encodeStateAsUpdate(doc).byteLength;
}

const utf8 = new TextEncoder();

/** A doc whose content could not be pushed, after retries. */
export interface UploadFailure {
  docId: string;
  relPath: string;
  reason: string;
  /**
   * The failure is a property of the FILE, not of the network: retrying on the
   * next `ready` cannot fix it (today: the note is over {@link MAX_NOTE_BYTES}).
   * The session remembers these so they are not re-queued every connect, and
   * they never count toward the failure streak that pauses a run.
   */
  permanent?: boolean;
}

export interface ContentUploaderOptions {
  /** Server note-collection id (the Postgres `vaults` row). */
  vaultId: string;
  /** Every mapped note in the vault: `registry.mappedNotes()`. */
  notes: Array<{ docId: string; relPath: string }>;
  deps: ContentUploadDeps;
  /** Resume point: docs already confirmed on the server are skipped. */
  isPushed: (docId: string) => boolean;
  /** Record a confirmed push (checkpointed by the registry). */
  markPushed: (docId: string) => void;
  /** Docs to leave alone — currently the open note, whose own editor session
   *  owns its provider (two providers on one doc is the one thing to avoid). */
  skip?: (docId: string) => boolean;
  /** Queue every note regardless of the pushed checkpoint. For local-change
   *  runs: the doc IS confirmed on the server, but its .md just changed on disk
   *  underneath us, so "pushed" says nothing about the new bytes. */
  force?: boolean;
  /**
   * Queue this doc even though {@link ContentUploaderOptions.isPushed} says it is
   * confirmed — a targeted `force`.
   *
   * Fed by the vault channel's `ready.empty`: the server is the authority on
   * whether it holds a note's content, and `pushed` is only a local optimisation
   * that a crashed run or a wiped `.context/` gets wrong. Without this, a note
   * the checkpoint claims and the server does not have is unreachable forever.
   */
  include?: (docId: string) => boolean;
  /**
   * Docs to push FIRST. Order within each group is preserved (a stable
   * partition), so the queue stays deterministic.
   *
   * Used for the same `ready.empty` set: those notes have NO content on the
   * server, so if a run is cut short (vault switch, quit, failure pause) the
   * work that mattered most is the work that already happened.
   */
  priority?: (docId: string) => boolean;
  /**
   * Merge each note's current file bytes into its doc (`NoteBridge.ingestNow`)
   * as part of the push — the local-change run's whole reason to exist. Without
   * it this engine only ever *seeds an empty doc*, so an edit to a note that
   * already has CRDT content would silently push nothing.
   *
   * Split-brain safe: the pre-connect ingest runs ONLY when the doc already has
   * content (a diff-merge, same as the open editor's ingest); an empty doc
   * waits for the server pull + `seedFromFileIfEmpty`, exactly like the bulk
   * path, and a post-sync ingest then folds in any bytes the seed didn't cover.
   */
  ingestFromFile?: boolean;
  /** Veto for the ingest fast-path (see below): true means this doc holds
   *  local-only ops from an OUT-OF-BAND merge (a resident bridge or a cold
   *  apply already folded the external edit in), so "the file matches the doc"
   *  does not mean "nothing to send" — connect and flush regardless. */
  mustConnect?: (docId: string) => boolean;
  progress?: SyncProgressSink;
  /** Abandon the run (vault switch). Checked before every doc. */
  shouldStop?: () => boolean;
  concurrency?: number;
  /** How long to wait for the initial server sync per doc. Default 10s. */
  syncTimeoutMs?: number;
  /** How long to wait for the server to ack our push per doc. Default 30s. */
  flushTimeoutMs?: number;
  /**
   * Consecutive per-doc failures that PAUSE the run. Default 10.
   *
   * A dead/unreachable server fails EVERY doc, and grinding through 500 × the
   * sync timeout is exactly the "syncing forever" symptom. So the run stops and
   * the remaining docs stay honestly unsynced instead of silently claimed.
   *
   * This is a pause, not a verdict: a dead server pauses the run, and the next
   * vault-channel `ready` resumes it (see `SyncManager.handleServerEmpty`). That
   * is why the limit is 10 rather than the original 5 — with nothing to restart
   * the run, five transient failures used to strand every remaining note until
   * the user signed out and back in.
   */
  failureStreakLimit?: number;
}

export interface UploadRunResult {
  /** Docs considered (after the pushed/skip filters). */
  total: number;
  pushed: number;
  failed: number;
  /** True when the failure streak limit tripped. */
  aborted: boolean;
  /** True when the vault changed under us — the run is void, not failed. */
  cancelled: boolean;
}

export class ContentUploader {
  private readonly opts: ContentUploaderOptions;
  private readonly progress: SyncProgressSink;
  private readonly concurrency: number;
  private readonly syncTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly streakLimit: number;

  private stopped = false;
  private aborted = false;
  private streak = 0;
  private failures: UploadFailure[] = [];
  private running = false;

  constructor(opts: ContentUploaderOptions) {
    this.opts = opts;
    this.progress = opts.progress ?? nullProgressSink;
    this.concurrency = Math.max(1, opts.concurrency ?? UPLOAD_CONCURRENCY);
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 10_000;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? 30_000;
    this.streakLimit = Math.max(1, opts.failureStreakLimit ?? 10);
  }

  /** Cancel the run. Called from `SyncManager.teardown` on every vault switch. */
  stop(): void {
    this.stopped = true;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Docs that could not be pushed — a vault with any of these is NOT synced. */
  failedDocs(): UploadFailure[] {
    return [...this.failures];
  }

  private shouldStop(): boolean {
    return this.stopped || this.aborted || (this.opts.shouldStop?.() ?? false);
  }

  /**
   * Push content for every mapped note the server doesn't have yet.
   *
   * The work list is computed up front (so `total` is honest from the first
   * emission) and then drained by a `runPool` at `UPLOAD_CONCURRENCY`.
   */
  async run(): Promise<UploadRunResult> {
    this.running = true;
    this.failures = [];
    this.streak = 0;
    this.aborted = false;
    try {
      const queue = this.orderQueue(
        this.opts.notes.filter(
          (n) =>
            (this.opts.force === true ||
              !this.opts.isPushed(n.docId) ||
              (this.opts.include?.(n.docId) ?? false)) &&
            !(this.opts.skip?.(n.docId) ?? false),
        ),
      );
      // Everything already confirmed reads as synced straight away, so the badge
      // for a resumed vault is correct before a single socket opens.
      const queued = new Set(queue.map((n) => n.docId));
      for (const n of this.opts.notes) {
        // `queued` wins over the checkpoint: a doc named by `ready.empty` is
        // "pushed" locally and yet has no content on the server, so badging it
        // synced here — even for the one emission before the `queued` below
        // overwrites it — would be the exact lie this run exists to fix.
        if (this.opts.isPushed(n.docId) && !queued.has(n.docId)) {
          this.progress.doc(n.docId, "synced");
        }
      }
      this.progress.phase("uploading", queue.length);
      for (const n of queue) this.progress.doc(n.docId, "queued");
      this.progress.flush();
      if (queue.length === 0) {
        return { total: 0, pushed: 0, failed: 0, aborted: false, cancelled: false };
      }

      let pushed = 0;
      await runPool(
        queue,
        async (note) => {
          const ok = await this.pushOne(note.docId, note.relPath);
          if (ok) pushed++;
        },
        { concurrency: this.concurrency, shouldStop: () => this.shouldStop() },
      );
      this.progress.flush();
      const cancelled = this.stopped || (this.opts.shouldStop?.() ?? false);
      return {
        total: queue.length,
        pushed,
        failed: this.failures.length,
        aborted: this.aborted,
        cancelled,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Stable partition: `priority` docs first, everything else in its original
   * order. A sort() would be shorter and wrong — `Array.prototype.sort` is only
   * guaranteed stable per spec for the comparator's ties, and reordering the
   * queue arbitrarily makes a resumed run's progress unrepeatable.
   */
  private orderQueue<T extends { docId: string }>(queue: T[]): T[] {
    const isFirst = this.opts.priority;
    if (!isFirst) return queue;
    const first: T[] = [];
    const rest: T[] = [];
    for (const n of queue) (isFirst(n.docId) ? first : rest).push(n);
    return [...first, ...rest];
  }

  /** Push one note. Returns true when the server has acked its content. */
  private async pushOne(docId: string, relPath: string): Promise<boolean> {
    if (this.shouldStop()) return false;
    // Re-checked here, not just when the queue was built: the user can open a note
    // mid-run, and once its editor session owns a provider for that doc we must not
    // become a second writer on it. (A doc opened during its OWN push still races;
    // both sides converge through Yjs, and the window is one doc's push.)
    if (this.opts.skip?.(docId)) {
      this.progress.item("ok");
      return false;
    }
    this.progress.doc(docId, "syncing");
    let bridge: NoteBridge;
    try {
      bridge = await this.opts.deps.acquire(docId, relPath);
    } catch (e) {
      this.fail(docId, relPath, `open failed: ${msg(e)}`);
      return false;
    }
    // The vault can have changed while we were opening — release and drop before
    // any network work binds this doc to a collection that is no longer current.
    if (this.shouldStop()) {
      await this.releaseQuietly(docId);
      return false;
    }

    // THE size ceiling, measured the way the server measures it: on the encoded
    // Yjs state, which is what the socket would actually carry. Runs before the
    // file checks below and independently of `readFile`, because a doc can be
    // over the cap with no file at all (or, as in the production vault that
    // brought this back, with a 0-byte one). See {@link MAX_NOTE_BYTES}.
    const stateBytes = crdtBytes(bridge.doc);
    if (stateBytes > MAX_NOTE_BYTES) {
      await this.releaseQuietly(docId);
      const mb = (stateBytes / (1024 * 1024)).toFixed(1);
      const cap = Math.round(MAX_NOTE_BYTES / (1024 * 1024));
      this.fail(
        docId,
        relPath,
        `too large to sync (${mb} MB of edit history; the limit is ${cap} MB) — ` +
          `reset this note's history to sync it again`,
        { permanent: true },
      );
      return false;
    }

    // Two checks that need no socket, both driven by the file's current bytes.
    if (this.opts.deps.readFile) {
      let fileText: string | null = null;
      try {
        fileText = await this.opts.deps.readFile(relPath);
      } catch {
        fileText = null; // unreadable — let the normal path decide (and report)
      }
      if (this.shouldStop()) {
        await this.releaseQuietly(docId);
        return false;
      }
      if (fileText != null) {
        // (a) Over the server's size ceiling: the server would refuse the sync
        //     message and close the socket, so don't open one. Permanent — the
        //     bytes on disk have to change for this to ever succeed.
        const bytes = utf8.encode(fileText).byteLength;
        if (bytes > MAX_NOTE_BYTES) {
          await this.releaseQuietly(docId);
          const mb = (bytes / (1024 * 1024)).toFixed(1);
          const cap = Math.round(MAX_NOTE_BYTES / (1024 * 1024));
          this.fail(docId, relPath, `too large to sync (${mb} MB; the limit is ${cap} MB)`, {
            permanent: true,
          });
          return false;
        }
        // (b) Nothing anywhere: the SERVER said it holds nothing for this doc
        //     (`include`, fed by `ready.empty`), the file is empty AND the local
        //     doc is empty. There is no text to seed and nothing to pull, so a
        //     socket would only cost a token mint to learn that — and on a vault
        //     with hundreds of empty placeholder files, `ready.empty` names every
        //     one of them on EVERY connect, which is exactly how "310 files
        //     re-syncing on each reload" happened. Record it as confirmed.
        //
        //     Gated on the server's word on purpose. Without `include`, an empty
        //     file + empty doc can still mean "a placeholder whose backfill
        //     frame this device missed" — the pull is what fills it in — or, on
        //     a local-change run, "someone truncated the file", which the
        //     post-sync ingest must propagate as a deletion. Both keep the
        //     network path.
        if (
          fileText.length === 0 &&
          bridge.serialize().length === 0 &&
          (this.opts.include?.(docId) ?? false)
        ) {
          await this.releaseQuietly(docId);
          this.streak = 0;
          this.opts.markPushed(docId);
          this.progress.doc(docId, "synced");
          this.progress.item("ok");
          return true;
        }
      }
    }

    let preIngested = false;
    if (this.opts.ingestFromFile && bridge.serialize().length > 0) {
      preIngested = true;
      // Diff-merge the file into the already-populated doc BEFORE any network
      // work. When nothing changed (our own background egest echoing back
      // through the watcher, or an edit a previous run already merged) and the
      // server has confirmed this doc before, there is nothing to send — skip
      // the socket entirely. That check is what keeps a teammate's every remote
      // update (which we egest to disk, which fires the watcher) from costing a
      // provider connect apiece.
      const changed = await bridge.ingestNow();
      const serverHasIt =
        this.opts.isPushed(docId) && !(this.opts.include?.(docId) ?? false);
      if (!changed && serverHasIt && !(this.opts.mustConnect?.(docId) ?? false)) {
        await this.releaseQuietly(docId);
        this.streak = 0;
        this.progress.doc(docId, "synced");
        this.progress.item("ok");
        return true;
      }
    }

    const push = this.opts.deps.connect({ docId, vaultId: this.opts.vaultId, doc: bridge.doc });
    try {
      // PULL FIRST. This is the split-brain rule (spec 03 §5): the server's state
      // must be merged before we consider seeding, or two devices each insert the
      // file's text under their own client id and the note doubles.
      await push.whenSynced(this.syncTimeoutMs);
      if (this.shouldStop()) return false;
      if (!push.isSynced) {
        // The timeout elapsed without a real sync (offline / server down). We
        // deliberately do NOT seed here: seeding on an unverified pull is exactly
        // how a local orphan is created that later merges into real server content
        // as a duplicate. Leave the doc untouched and report honestly.
        this.fail(docId, relPath, "server did not respond to the initial sync");
        return false;
      }

      if (!push.readOnly) {
        // Seeds ONLY a genuine orphan (empty Y.Text) — see the module header.
        await bridge.seedFromFileIfEmpty();
        // A doc that was empty before the pull couldn't take the pre-connect
        // ingest (that would seed before the server's state — the doubling
        // bug). Now the server's canonical state is in, fold in whatever the
        // file holds that the seed didn't cover: e.g. an external write into a
        // still-unhydrated placeholder file. ONLY when the pre-connect ingest
        // didn't run: after it has, the file is one merge behind the doc (the
        // pull just landed server ops the file has never seen), and diffing the
        // stale file against the merged doc would DELETE those server ops.
        if (this.opts.ingestFromFile && !preIngested) await bridge.ingestNow();
      }
      const flushed = await push.whenFlushed(this.flushTimeoutMs);
      // Whatever the server had for this doc has landed in the Y.Doc by now;
      // write it out so the .md on disk matches. (The watcher will see this
      // write, but every ingest side runs behind the bridge's echo-hash guard —
      // the local-change path recognizes its own bytes and stays quiet.)
      await bridge.flushEgest();
      if (!flushed) {
        this.fail(docId, relPath, "server did not acknowledge the content");
        return false;
      }
      this.streak = 0;
      this.opts.markPushed(docId);
      this.progress.doc(docId, "synced");
      this.progress.item("ok");
      return true;
    } catch (e) {
      this.fail(docId, relPath, msg(e));
      return false;
    } finally {
      // Order matters: kill the provider before the bridge, so no inbound update
      // can land on a Y.Doc that is being destroyed.
      try {
        push.destroy();
      } catch {
        /* provider already gone */
      }
      await this.releaseQuietly(docId);
    }
  }

  private async releaseQuietly(docId: string): Promise<void> {
    try {
      await this.opts.deps.release(docId);
    } catch (e) {
      console.warn(`[upload] release failed for ${docId}`, e);
    }
  }

  private fail(
    docId: string,
    relPath: string,
    reason: string,
    opts: { permanent?: boolean } = {},
  ): void {
    this.failures.push({ docId, relPath, reason, ...(opts.permanent ? { permanent: true } : {}) });
    this.progress.doc(docId, "error");
    this.progress.item("failed");
    // A permanent failure says nothing about the server's health, so it must
    // not help trip the streak that pauses the run for everyone else.
    if (opts.permanent) return;
    this.streak++;
    if (this.streak >= this.streakLimit && !this.aborted) {
      this.aborted = true;
      console.warn(
        `[upload] ${this.streak} consecutive failures — stopping the run for this vault`,
      );
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
