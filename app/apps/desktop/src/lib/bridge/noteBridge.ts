// NoteBridge — one Y.Doc (a single Y.Text 'content') per note, reconciled with
// the plain-markdown file on disk (spec 03 §5). Two guards keep the loop safe:
//   • origin tags   — never react to a change we caused ('disk' egest is dropped)
//   • lastWrittenHash — the ingest side ignores the exact bytes egest just wrote
//
// This module is pure: it takes all I/O through `BridgeIO`, so it runs under
// vitest in Node with an in-memory fake and no Tauri/DOM.

import * as Y from "yjs";
import { applyDiff, changeRatio, computeDiff } from "./diff";
import {
  DEFAULT_CONFIG,
  ORIGIN_DISK,
  ORIGIN_EDITOR,
  ORIGIN_REMOTE,
  type BridgeConfig,
  type BridgeIO,
  type NoteBridgeOptions,
} from "./types";

export class NoteBridge {
  /** Disk input already merged with a racing peer edit, until the combined
   * result reaches disk. A queued watcher read of that same input is no edit. */
  private pendingMergedFileHash: string | null = null;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly docId: string;

  private io: BridgeIO;
  private cfg: BridgeConfig;
  private _path: string;
  /** Seed from file on open when no CRDT exists (false ⇒ sync layer seeds later). */
  private seedOnOpen: boolean;

  /** Hash of the bytes we last wrote to disk; the ingest echo guard (spec 03 §5). */
  private lastWrittenHash: string | null = null;
  /**
   * The DURABLE twin of `lastWrittenHash` (#200): sha256 of the bytes this
   * device last synced between the file and the doc — the last egest write,
   * or the last file read INTO the doc — persisted per doc so it survives a
   * relaunch. A file that still hashes to it was never edited outside the app
   * since then, so a doc that differs from it is AHEAD of the file (an egest
   * that failed, or a quit inside the 300ms debounce). Diffing that older file
   * into the doc would turn the newest text into deletions; writing the doc out
   * is the only right answer. Null = unknown (an older vault): every differing
   * file is then diffed, as before.
   */
  private diskBase: string | null = null;
  /**
   * The compare-and-swap base for egest (#216): the hash of the file bytes this
   * bridge last OBSERVED on disk — last read by an ingest or seed, or last
   * written by an egest — plus, when known, the doc state whose text equals
   * those bytes. Egest passes the hash to `writeFileAtomic`, which refuses to
   * replace a file that moved on since ("stale"): someone else wrote it — an
   * external editor inside the 300 ms egest window, or a second doc on the same
   * file (a symbolic link, a case variant). The bridge then merges the newer
   * file in, three-way against `state` when it has one, instead of clobbering.
   * Null = never observed (or the last read failed): the write is unconditional,
   * as every write was before.
   */
  private observed: { hash: string; state: Uint8Array | null } | null = null;
  /** `writeThrough`: the next egest writes unconditionally (a placeholder the
   *  caller knows it is filling), whatever this bridge last observed. */
  private blindNextWrite = false;
  /**
   * Pull-before-merge (#200). Non-null while a signed-in bridge waits for its
   * first server pull: the doc's state as it was BEFORE that pull, encoded.
   *
   * Merging the file into a local CRDT that is behind the server re-inserts
   * whatever the server already has: a local doc at `Price: 97`, a file at
   * `Price: 127` (a teammate's edit, egested on an earlier launch) and a
   * pre-pull ingest makes this device insert `12` under its own client id; the
   * pull then lands the teammate's identical `12` and the note reads
   * `Price: 12127` — and gains the digits again on every such round. So while
   * this is set the file is neither ingested (watcher events only mark it
   * dirty) nor written (egests are deferred), and `reconcileAfterPull` settles
   * it once, three-way, against this pre-pull state.
   */
  private prePull: Uint8Array | null = null;
  /** An egest was requested while {@link prePull} was set. */
  private egestDeferred = false;
  /** Upper bound on the pull wait — see `pullReconcileTimeoutMs`. */
  private pullTimer: number | null = null;

  /** Count of updates in the persisted log since the last snapshot/compaction. */
  private logLength = 0;
  /** Bytes in that log. The count above never reached its threshold on a real
   *  vault while the BYTES did (see `compactBytes`), so both are tracked. */
  private logBytes = 0;
  /** One compaction at a time: the live trigger fires from an update callback,
   *  and a second pass while the first is still writing its snapshot would
   *  reset the counters twice for one truncation. */
  private compacting = false;
  /** Monotonic count of every update ever observed on this doc (for assertions). */
  private observedUpdates = 0;
  /** Whether the oversize refusal has already been reported for the current
   *  run of oversized reads, so one runaway file logs once, not per watcher
   *  event. Cleared as soon as a normal-sized read comes through. */
  private oversizeReported = false;
  /** Same one-report-per-run rule as {@link oversizeReported}, for the 0-byte
   *  truncation refusal: a placeholder file that keeps being re-read must log
   *  once, not per watcher event. */
  private truncateReported = false;
  /** An ingest applied disk bytes into this doc that no `ingestNow()` caller has
   *  been told about yet. `hydrate` arms a DEBOUNCED ingest (150ms) to reconcile
   *  a doc whose file moved on while it was closed, and nothing owns that merge:
   *  if it fires while `ContentUploader.pushOne` is still awaiting its own
   *  `readFile` (one slow IPC round trip, or a `hydrate`-time `compact()`), the
   *  uploader's `ingestNow()` then finds the file already merged, exits through
   *  the converged branch with false, and — the doc being `isPushed` — marks it
   *  synced WITHOUT opening a socket. The external edit is then local-only until
   *  the next write to that file drags it along (#104). The two sibling ingests
   *  both report their merge (`divergedDocs` via `handleLocalFileChanged` and
   *  `onExternalMerge`); this flag is how the hydrate one does. */
  private diskMergedUnreported = false;
  /** True once a recovery snapshot has been taken for a large diff. */
  private recoverySnapshotTaken = false;
  /** True once this doc has held non-empty text in this session. Guards egest:
   *  a doc that was "born empty" (never hydrated — e.g. a doc_id mismatch or an
   *  empty server doc) must never write its emptiness over a file that still has
   *  content. A genuine clear-all (editor or remote) sets this first, so real
   *  deletions still egest. */
  private everHadContent = false;

  private ingestTimer: number | null = null;
  private egestTimer: number | null = null;
  private ingestDirty = false;
  /** The ingest pass in flight, if any. Two passes that overlap each diff
   *  against the SAME `this.text` and each apply their own result: against an
   *  empty doc that is the whole file inserted twice — the doubling bug through
   *  a second door (`__tests__/doubling-ingest.test.ts`). The debounced watcher
   *  drain and the sync layer's `ingestNow` target the same doc routinely, so
   *  passes are chained here rather than left to interleave. */
  private ingestInFlight: Promise<boolean> | null = null;
  /** The egest pass in flight, if any — the same chain as `ingestInFlight`, for
   *  the same reason: two passes racing `writeFileAtomic` on one path share a
   *  temp file, so an interleave is what lands on the note. See `drainEgest`. */
  private egestInFlight: Promise<void> | null = null;
  /** Appends still in flight. Updates are persisted fire-and-forget and
   *  `destroy()` is synchronous, so a bridge torn down right after it applied
   *  ops used to drop them — while `flushEgest` had already put the same text in
   *  the `.md`. That leaves the local CRDT BEHIND its own file, which is the
   *  state a diff-and-push cycle turns into duplicated text: the next bridge
   *  reads the file, does not recognise the content as its own, and re-inserts
   *  it under a fresh clientID. `whenPersisted()` is the way to close a bridge
   *  without opening that gap. */
  private persistQueue: Promise<void> = Promise.resolve();
  /** Highest `yjs_updates` row id this bridge has been told about. The
   *  compaction watermark: every row up to it is committed AND folded into the
   *  snapshot a compaction takes after `whenPersisted()`, so deleting `id <=
   *  it` is exactly the set the snapshot covers — while a keystroke appended
   *  during the save gets a higher id and survives. 0 means "nothing known",
   *  which truncates nothing. */
  private maxPersistedRow = 0;
  private destroyed = false;
  /** Consecutive failed egest writes (0 once one lands). Drives the retry
   *  backoff and the `onWriteFailed`/`onWriteRecovered` UI cues. */
  private egestFailures = 0;

  private readonly setT: (fn: () => void, ms: number) => number;
  private readonly clearT: (id: number) => void;

  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onTextChange: (evt: Y.YTextEvent, tr: Y.Transaction) => void;
  private readonly onUndoStackItemAdded: () => void;

  // UndoManager scoped to local editor edits only — 'disk'/'remote' origins are
  // never undoable. y-codemirror's yCollab additionally registers its own sync
  // origin on this manager, so editor keystrokes are tracked in production too.
  readonly undoManager: Y.UndoManager;

  private constructor(io: BridgeIO, opts: NoteBridgeOptions) {
    this.io = io;
    this.docId = opts.docId;
    this._path = opts.path;
    this.seedOnOpen = opts.seedFromFile !== false;
    this.cfg = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([ORIGIN_EDITOR]),
      // Group rapid keystrokes into one undo step (Yjs default, made explicit
      // because the whole bound below is expressed in *steps*).
      captureTimeout: this.cfg.undoCaptureTimeoutMs,
    });
    // Bound the history: without this, one long session in a single note grows
    // the undo stack for every edit AND keeps every deleted struct pinned
    // against garbage collection (Yjs `keepItem(item, true)`).
    this.onUndoStackItemAdded = () => this.trimUndoHistory();
    this.undoManager.on("stack-item-added", this.onUndoStackItemAdded);

    this.setT =
      io.setTimeout ??
      ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearT =
      io.clearTimeout ?? ((id) => globalThis.clearTimeout(id));

    this.onDocUpdate = (update) => {
      // Persist every update regardless of origin — it's part of doc history.
      this.observedUpdates++;
      this.logLength++;
      this.logBytes += update.byteLength;
      // Started eagerly (not chained behind the queue): the store's ordering is
      // its own business, and deferring the call by a microtask changes when a
      // log row exists. The queue only TRACKS completion, for `whenPersisted`.
      const appended = Promise.resolve(
        this.io.persistence.appendUpdate(this.docId, update),
      );
      this.persistQueue = this.persistQueue
        .catch(() => {})
        .then(async () => {
          await appended;
        });
      appended
        .then((rowId) => {
          // Row ids are monotonic in commit order, so the max is the watermark.
          // A store that answers nothing (an older host, a test fake) simply
          // leaves it at 0 and compaction then truncates nothing.
          if (typeof rowId === "number" && rowId > this.maxPersistedRow) {
            this.maxPersistedRow = rowId;
          }
          // Compact LIVE, not only on the next load: one paste or AI rewrite can
          // put megabytes into the log, and until now nothing shrank it until
          // the note was reopened (and the row-count trigger never fired at
          // all). Fire-and-forget — a failed compaction is a slower load, never
          // a lost update: the log it would have replaced is still there.
          if (this.shouldCompact()) void this.compact();
        })
        .catch((e) => this.reportError(e, "appendUpdate"));
      void this.persistQueue;
    };

    this.onTextChange = (_evt, tr) => {
      // Remember the doc has legitimately held content, so a later clear-all is
      // recognised as a real deletion (and not blocked by the born-empty guard).
      if (this.text.length > 0) this.everHadContent = true;
      // A change we applied from the file must not be written back (spec 03 §5.B).
      if (tr.origin === ORIGIN_DISK) return;
      this.scheduleEgest();
    };
  }

  get path(): string {
    return this._path;
  }

  /** Current serialization of the note (raw markdown). */
  serialize(): string {
    return this.text.toString();
  }

  /** For tests/observability: total updates observed since open. */
  get updatesObserved(): number {
    return this.observedUpdates;
  }
  get pendingLogLength(): number {
    return this.logLength;
  }
  /** For tests/observability: bytes in the persisted log since the last
   *  snapshot — the measure the compaction trigger actually watches. */
  get pendingLogBytes(): number {
    return this.logBytes;
  }
  get hasRecoverySnapshot(): boolean {
    return this.recoverySnapshotTaken;
  }
  get lastHash(): string | null {
    return this.lastWrittenHash;
  }

  /**
   * Open a note: hydrate the Y.Doc from persisted CRDT state, or seed it from
   * the current file if there is none, then wire the observers.
   */
  static async open(io: BridgeIO, opts: NoteBridgeOptions): Promise<NoteBridge> {
    const b = new NoteBridge(io, opts);
    await b.hydrate();
    return b;
  }

  private async hydrate(): Promise<void> {
    const loadBase = this.io.persistence.loadDiskBase;
    const [state, base] = await Promise.all([
      this.io.persistence.loadState(this.docId),
      loadBase
        ? Promise.resolve(loadBase.call(this.io.persistence, this.docId)).catch((e) => {
            this.reportError(e, "hydrate:loadDiskBase");
            return null;
          })
        : Promise.resolve(null),
    ]);
    this.diskBase = base ?? null;
    // Until this session reads the file, the disk base is the last thing this
    // device knows was on disk for the doc: a file that moved on since is not
    // overwritten by the first egest, it is read first (#216).
    if (this.diskBase) this.observed = { hash: this.diskBase, state: null };
    const hasPersisted = state.snapshot != null || state.updates.length > 0;

    if (hasPersisted) {
      // Apply persisted state BEFORE subscribing, so we don't re-append what we
      // just loaded. Yjs updates are idempotent, but re-appending grows the log.
      this.doc.transact(() => {
        if (state.snapshot) Y.applyUpdate(this.doc, state.snapshot, "persistence");
        for (const u of state.updates) Y.applyUpdate(this.doc, u, "persistence");
      }, "persistence");
      this.logLength = state.updateCount;
      // The watermark for the rows we just READ: a compaction below (or the
      // first live one) may truncate exactly these and nothing newer.
      this.maxPersistedRow = state.lastUpdateId ?? 0;
      // What the log actually COST to load, which is the number the compaction
      // trigger cares about.
      this.logBytes = state.updates.reduce((sum, u) => sum + u.byteLength, 0);
      if (this.text.length > 0) this.everHadContent = true;
      this.subscribe();
      // Baseline the echo guard at the current content so an identical file
      // doesn't trigger a spurious ingest, but a genuine external change does.
      this.lastWrittenHash = await this.hash(this.text.toString());
      // The file may have moved on while this doc was closed — an AI editing
      // the vault directly, or the app relaunching after external edits. The
      // CRDT we just hydrated describes the LAST session; the .md on disk is
      // the durable source of truth (spec 00), so reconcile against it now
      // rather than waiting for a watcher event that already fired (or never
      // will). Converged content no-ops.
      //
      // A doc that hydrated EMPTY is armed too, but only on a local-only vault
      // (`seedOnOpen`). A signed-in doc must go through the deferred
      // pull-before-seed path, never a pre-sync ingest — that is the
      // note-doubling bug, and `runIngest`'s unseeded-empty refusal is the
      // matching half. But with no server to pull from, "empty doc, persisted
      // log" is an ordinary state: the user cleared the note, closed the app,
      // and something else (an AI, Obsidian, `git checkout`) then wrote the
      // file. Without this the editor paints empty over that file and the first
      // keystroke egests the emptiness away — the file's content destroyed with
      // no trash copy (desktop-audit #2).
      //
      // A SIGNED-IN doc with content is not ingested here at all (#200): its
      // local CRDT may be behind the server, and the file may already hold the
      // server's newer text (egested on an earlier launch) — diffing that file
      // into the older doc re-inserts the server's edit under this device's
      // client id, and the pull then doubles it. It waits for the pull instead
      // (`beginPull` → `reconcileAfterPull`).
      if (this.seedOnOpen) this.ingest();
      else if (this.text.length > 0) this.beginPull();
      if (this.shouldCompact()) await this.compact();
    } else {
      // No CRDT yet. Normally seed Y.Text from the file in a 'disk' transaction
      // (persisted but not echoed back as a write). When `seedOnOpen` is false
      // (signed in) we DEFER: leave the doc empty so the sync layer can pull the
      // server's canonical state first, then call `seedFromFileIfEmpty()` for a
      // genuine orphan (spec 03 §5 startup ordering).
      this.subscribe();
      let fileText = "";
      let fileRead = false;
      try {
        fileText = await this.io.readFile(this._path);
        fileRead = true;
      } catch (e) {
        this.reportError(e, "seed:readFile");
        fileText = "";
      }
      if (this.seedOnOpen && fileText.length > 0) {
        this.doc.transact(() => {
          // Same re-assertion as `seedFromFileIfEmpty`: `subscribe()` is already
          // live and the file read above was awaited, so a remote update can have
          // arrived in between. Seeding on top of it would fork the history and
          // double the text.
          if (this.text.length > 0) return;
          this.text.insert(0, fileText);
        }, ORIGIN_DISK);
      }
      // Baseline the echo guard at the file's current bytes either way, so a
      // later egest of server content is seen as a genuine change and no
      // spurious ingest fires before we've seeded.
      this.lastWrittenHash = await this.hash(fileText);
      // Signed in, no local CRDT, and the file holds bytes this device never
      // agreed on (no disk base, or one they moved on from): an external
      // writer edited a note this device never opened. The pull is about to
      // decide the doc's text, and the orphan seed only runs when the server
      // turns out empty — so save the file aside first. Nothing below may be
      // the only record of those bytes.
      if (
        !this.seedOnOpen &&
        fileRead &&
        fileText.trim().length > 0 &&
        this.diskBase !== this.lastWrittenHash &&
        this.io.saveRecoveryCopy
      ) {
        try {
          await this.io.saveRecoveryCopy(this._path, fileText);
        } catch (e) {
          this.reportError(e, "hydrate:saveRecoveryCopy");
        }
      }
      if (this.seedOnOpen && fileText.length > 0 && this.text.toString() === fileText) {
        this.recordDiskBase(this.lastWrittenHash);
      }
      if (fileRead) this.observe(this.lastWrittenHash, this.stateIfText(fileText));
      else this.observed = null;
    }
  }

  /** Record what this bridge just saw on disk (see {@link observed}). A state
   *  of `undefined` keeps the known base when the hash did not move. */
  private observe(hash: string, state?: Uint8Array | null): void {
    if (state === undefined && this.observed?.hash === hash) return;
    this.observed = { hash, state: state ?? null };
  }

  /** The doc's full state iff its text is exactly `text` right now — the only
   *  moment that state is a valid three-way base for those bytes. */
  private stateIfText(text: string, doc: Y.Doc = this.doc): Uint8Array | null {
    return doc.getText("content").toString() === text ? Y.encodeStateAsUpdate(doc) : null;
  }

  /**
   * Orphan-seed hook for the startup-ordering rule (spec 03 §5). After the sync
   * layer has pulled the server's state, if this doc is STILL empty and the file
   * has content, seed the doc from disk (origin 'disk' → persisted locally and
   * propagated to the server as this device's contribution, but not egested back
   * to the file). Returns true if it seeded.
   */
  async seedFromFileIfEmpty(): Promise<boolean> {
    if (this.destroyed || this.text.length > 0) return false;
    let fileText = "";
    try {
      fileText = await this.io.readFile(this._path);
    } catch (e) {
      this.reportError(e, "seed:readFile");
      return false;
    }
    if (fileText.length === 0) return false;
    // Re-assert emptiness INSIDE the transaction. The check above ran before an
    // `await`, and the server's pull can land during that read — at which point
    // this doc is no longer an orphan and seeding it is not a no-op, it is a
    // SECOND insert history. Yjs merges two independent histories by keeping
    // both, so the note comes back holding the server's text *and* the file's,
    // and every repeat of the race doubles it again. That is the note-doubling
    // bug, and it is how a daily note reached 68 MB / 2.37M lines of 35 distinct
    // lines (two interleaved versions, ~43,000 copies each) in the 2026-09-04
    // vault: not a diff gone wrong, a seed racing a pull.
    let seeded = false;
    this.doc.transact(() => {
      if (this.text.length > 0) return; // the pull won — server state stands
      this.text.insert(0, fileText);
      seeded = true;
    }, ORIGIN_DISK);
    if (!seeded) return false;
    this.lastWrittenHash = await this.hash(fileText);
    this.recordDiskBase(this.lastWrittenHash);
    this.observe(this.lastWrittenHash, this.stateIfText(fileText));
    return true;
  }

  // ---- Pull-before-merge (#200) -----------------------------------------

  /** True while this bridge waits for its first server pull (see {@link prePull}). */
  get awaitingPull(): boolean {
    return this.prePull != null;
  }

  /**
   * Enter the pull wait: remember the doc as it is now (the pre-pull state),
   * stop ingesting and writing the file until {@link reconcileAfterPull}.
   * `hydrate` calls this for every signed-in doc that opened with content; the
   * sync layer calls it before connecting a bridge that was already resident.
   * Idempotent — a second call keeps the FIRST pre-pull state.
   */
  beginPull(): void {
    if (this.destroyed || this.prePull) return;
    this.prePull = Y.encodeStateAsUpdate(this.doc);
    // Nobody has compared this doc with its file yet.
    this.ingestDirty = true;
    if (this.ingestTimer != null) {
      this.clearT(this.ingestTimer);
      this.ingestTimer = null;
    }
    if (this.egestTimer != null) {
      this.clearT(this.egestTimer);
      this.egestTimer = null;
      this.egestDeferred = true;
    }
    if (this.cfg.pullReconcileTimeoutMs > 0) {
      this.pullTimer = this.setT(() => {
        this.pullTimer = null;
        void this.reconcileAfterPull();
      }, this.cfg.pullReconcileTimeoutMs);
    }
  }

  /**
   * End the pull wait: merge the file into the doc ONCE, three-way, against
   * the state the doc had BEFORE the pull. Resolves true iff file bytes entered
   * the doc (a genuine external edit the server does not have yet).
   *
   *  - file == the doc now (post-pull)    ⇒ nothing to do — the file already
   *    held the server's text; ingesting it would have re-inserted that text;
   *  - file == the disk base, or == the pre-pull doc ⇒ the file is merely
   *    BEHIND: write the doc out, never diff the older bytes in;
   *  - anything else ⇒ an edit made outside the app: the diff pre-pull → file
   *    is applied on a branch forked from the pre-pull state and that branch's
   *    ops are merged into the live doc (the same technique a racing ingest
   *    uses), so the server's ops and the file's edit both survive.
   *
   * Call it after the provider's first sync — or after that sync timed out,
   * where it degrades to an ordinary ingest. A no-op (false) when the bridge
   * is not waiting.
   */
  async reconcileAfterPull(): Promise<boolean> {
    if (this.destroyed || !this.prePull) return false;
    const pre = this.prePull;
    this.releasePull();
    if (this.ingestTimer != null) {
      this.clearT(this.ingestTimer);
      this.ingestTimer = null;
    }
    this.ingestDirty = true;
    let changed = false;
    try {
      changed = await this.drainIngest(pre);
    } finally {
      if (this.egestDeferred) {
        this.egestDeferred = false;
        this.scheduleEgest();
      }
    }
    const merged = changed || this.diskMergedUnreported;
    this.diskMergedUnreported = false;
    return merged;
  }

  /**
   * End the pull wait WITHOUT reading the file into the doc. For a caller
   * that must not merge it: a read-only grant (the edit cannot be sent), or a
   * write-through whose caller knows the file is a placeholder. `egest` says
   * whether a write deferred during the wait may now go ahead.
   */
  abandonPull(egest = true): void {
    if (!this.prePull) return;
    this.releasePull();
    const deferred = this.egestDeferred;
    this.egestDeferred = false;
    if (deferred && egest) this.scheduleEgest();
  }

  private releasePull(): void {
    this.prePull = null;
    if (this.pullTimer != null) {
      this.clearT(this.pullTimer);
      this.pullTimer = null;
    }
  }

  /**
   * Does the file hold bytes the doc has not taken in? A read-only probe (no
   * merge) for the sync layer's no-socket fast path: false for our own egest
   * echo and for a file equal to the doc; true for anything else, including a
   * doc that is merely ahead of its file (the reconcile then writes it out).
   */
  async hasUnmergedFileChange(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.diskMergedUnreported) return true;
    let fileText: string;
    try {
      fileText = await this.io.readFile(this._path);
    } catch {
      return false;
    }
    const fileHash = await this.hash(fileText);
    if (fileHash === this.lastWrittenHash || fileHash === this.pendingMergedFileHash) return false;
    return fileText !== this.text.toString();
  }

  /** Persist the disk base. Fire-and-forget: a lost record only means the next
   *  launch treats a differing file as an edit, which is the older behaviour. */
  private recordDiskBase(hash: string): void {
    if (this.diskBase === hash) return;
    this.diskBase = hash;
    const save = this.io.persistence.saveDiskBase;
    if (!save) return;
    Promise.resolve(save.call(this.io.persistence, this.docId, hash)).catch((e) =>
      this.reportError(e, "saveDiskBase"),
    );
  }

  private subscribe(): void {
    this.doc.on("update", this.onDocUpdate);
    this.text.observe(this.onTextChange);
  }

  // ---- A. DISK → CRDT (ingest) -----------------------------------------

  /**
   * Signal that the file changed. Debounced (~150ms) with a dirty flag so a
   * burst of watcher events drains as one read against the CRDT's *current*
   * serialization (spec 03 §5.A).
   */
  ingest(): void {
    if (this.destroyed) return;
    this.ingestDirty = true;
    // Waiting for the first pull: remember that the file moved, merge it in
    // `reconcileAfterPull` — never against a doc the pull has not caught up.
    if (this.prePull) return;
    if (this.ingestTimer != null) this.clearT(this.ingestTimer);
    this.ingestTimer = this.setT(() => {
      this.ingestTimer = null;
      void this.drainIngest();
    }, this.cfg.ingestDebounceMs);
  }

  /**
   * Merge the file's current bytes into the CRDT immediately (no debounce), for
   * the background sync of a note nobody has open: an external writer (an AI
   * working in the vault folder, another editor) changed the file, and the sync
   * layer needs the diff in the doc NOW so it can push it. Returns true iff the
   * doc actually changed — false covers our own egest echoing back and an
   * already-converged file, which is what lets the caller skip the network
   * round-trip entirely.
   *
   * "Changed" means "disk bytes reached this doc and nobody has been told",
   * not "changed inside this call": a debounced ingest (the one `hydrate` arms)
   * can have merged the same file moments earlier, and reporting false for it
   * strands the merge locally while the badge says synced — see
   * {@link diskMergedUnreported}.
   */
  async ingestNow(): Promise<boolean> {
    if (this.destroyed) return false;
    // A bridge waiting for its pull merges through the three-way reconcile:
    // same caller contract ("did disk bytes reach the doc?"), right base.
    if (this.prePull) return this.reconcileAfterPull();
    if (this.ingestTimer != null) {
      this.clearT(this.ingestTimer);
      this.ingestTimer = null;
    }
    this.ingestDirty = true;
    const changed = await this.drainIngest();
    const merged = changed || this.diskMergedUnreported;
    this.diskMergedUnreported = false;
    return merged;
  }

  /**
   * Run one ingest pass, never overlapping another. A queued pass re-reads the
   * dirty flag when its turn comes, so a file change that arrived mid-pass is
   * still merged (against the doc as the earlier pass left it) and one that was
   * already covered costs nothing.
   */
  private async drainIngest(base?: Uint8Array): Promise<boolean> {
    const prior = this.ingestInFlight;
    const run = (async () => {
      if (prior) {
        try {
          await prior;
        } catch {
          // A failed pass must not strand the queue behind it.
        }
      }
      return this.runIngest(base);
    })();
    this.ingestInFlight = run;
    try {
      return await run;
    } finally {
      if (this.ingestInFlight === run) this.ingestInFlight = null;
    }
  }

  private async runIngest(base?: Uint8Array): Promise<boolean> {
    if (this.destroyed || !this.ingestDirty) return false;
    this.ingestDirty = false;

    if (base) {
      // The post-pull reconcile: the base is fixed (the pre-pull state), so the
      // file is diffed against THAT and replayed on a branch of it, whatever
      // the pull and any later transaction did to the live doc.
      const branch = new Y.Doc();
      Y.applyUpdate(branch, base);
      try {
        return await this.mergeDiskRead(() => branch, () => {}, this.everHadContent);
      } finally {
        branch.destroy();
      }
    }

    // The file read, hash and recovery snapshot cross async boundaries. If a
    // peer edits during any of them, diffing the older file against the NEW
    // live text turns the peer's additions into local deletions. Retain the
    // pre-read CRDT only when a transaction actually races us; ordinary echo
    // reads allocate no second document. Replay the disk diff on that branch
    // and merge its operations into the live doc, preserving concurrent edits.
    let baseline: Y.Doc | null = null;
    const hadContent = this.everHadContent;
    const capture = () => {
      if (baseline) return;
      baseline = new Y.Doc();
      Y.applyUpdate(baseline, Y.encodeStateAsUpdate(this.doc));
    };
    const stopTracking = () => this.doc.off("beforeTransaction", capture);
    this.doc.on("beforeTransaction", capture);
    try {
      return await this.mergeDiskRead(() => baseline ?? this.doc, stopTracking, hadContent);
    } finally {
      stopTracking();
      (baseline as Y.Doc | null)?.destroy();
    }
  }

  private async mergeDiskRead(
    getBaseline: () => Y.Doc,
    stopTracking: () => void,
    hadContent: boolean,
  ): Promise<boolean> {
    let fileText: string;
    try {
      fileText = await this.io.readFile(this._path);
    } catch (e) {
      this.reportError(e, "ingest:readFile");
      // What is on disk is unknown now (usually: nothing), so the next write is
      // unconditional again, exactly as before the compare-and-swap existed.
      this.observed = null;
      return false;
    }

    // Size ceiling BEFORE the echo guard and the diff: a file this big is damage,
    // not content, and ingesting it would pull that damage into the CRDT and from
    // there onto every other device and the server. Reported once per drain so
    // the user learns which file to fix; the doc keeps whatever it already holds.
    // See `maxIngestBytes`.
    if (this.cfg.maxIngestBytes > 0 && fileText.length > this.cfg.maxIngestBytes) {
      if (!this.oversizeReported) {
        this.oversizeReported = true;
        const mb = (fileText.length / (1024 * 1024)).toFixed(1);
        const cap = Math.round(this.cfg.maxIngestBytes / (1024 * 1024));
        this.reportError(
          new Error(`${this._path} is ${mb} MB (> ${cap} MB): refusing to ingest it`),
          "ingest:oversize",
        );
      }
      // Seen, and deliberately NOT merged: the doc's text is still meant to
      // replace this damage, so the compare-and-swap must not stop that write.
      this.observe(await this.hash(fileText));
      return false;
    }
    this.oversizeReported = false;

    const fileHash = await this.hash(fileText);
    // Every refusal below still SAW these bytes; the doc either holds them, is
    // meant to replace them, or was merged with them.
    this.observe(fileHash);
    if (fileHash === this.lastWrittenHash || fileHash === this.pendingMergedFileHash) {
      return false; // our own write or an already-merged disk input
    }

    if (this.text.toString() === fileText) {
      // Already converged (e.g. we ingested this exact change already).
      this.lastWrittenHash = fileHash;
      this.recordDiskBase(fileHash);
      this.observe(fileHash, Y.encodeStateAsUpdate(this.doc));
      return false;
    }
    if (this.diskBase != null && fileHash === this.diskBase) {
      // The file is exactly what this device last synced with the doc, and the
      // doc has moved on since: the FILE is behind (a write that failed, or a
      // quit inside the egest debounce), not edited. Diffing it in would turn
      // the doc's newest text into deletions (#200) — write the doc out instead.
      this.lastWrittenHash = fileHash;
      this.scheduleEgest();
      return false;
    }
    const current = getBaseline().getText("content").toString();
    if (current === fileText) {
      // The file matches the doc as it was before a racing transaction or a
      // pull: it is behind, and the doc's newer text must reach it.
      if (getBaseline() !== this.doc) {
        this.lastWrittenHash = fileHash;
        this.scheduleEgest();
      }
      return false;
    }

    // The ingest twin of the empty-egest clobber guard. A file that is
    // COMPLETELY empty against a doc that still holds text is not an edit we can
    // safely believe: the registry materializes a server-only note as a 0-byte
    // placeholder, and on a device that already holds that note's CRDT the
    // placeholder used to be diff-merged as a delete-all and then PUSHED — the
    // server's copy of the note destroyed by a file the app itself had just
    // created (#93). A genuine partial truncation still applies below; only
    // all-or-nothing is refused. See `allowTruncateFromDisk`.
    if (fileText.length === 0 && current.length > 0 && !this.cfg.allowTruncateFromDisk) {
      if (!this.truncateReported) {
        this.truncateReported = true;
        this.reportError(
          new Error(
            `${this._path} is 0 bytes: refusing to clear a doc holding ${current.length} chars`,
          ),
          "ingest:truncate",
        );
      }
      return false;
    }
    this.truncateReported = false;

    // A diff against an EMPTY doc is not a merge, it is a seed: every byte of
    // the file is inserted as this device's own history. Seeding is ordered —
    // pull the server's canonical state FIRST, then `seedFromFileIfEmpty` only
    // if the doc is still empty (spec 03 §5) — and this path is not in that
    // order. `docSession.handleLocalFileChanged` ingests any resident bridge
    // the watcher names, including one whose first pull has not landed, so
    // without this the file's text and the server's text both end up in the
    // doc: the note-doubling bug through the ingest door. A doc that has held
    // content this session (`everHadContent`) is past its seed and a genuine
    // clear-all still ingests; a local-only vault seeds on open and never gets
    // here empty.
    if (current.length === 0 && !hadContent && !this.seedOnOpen) {
      return false;
    }

    const diffs = computeDiff(current, fileText);
    const ratio = changeRatio(diffs, current.length, fileText.length);

    if (ratio > this.cfg.largeDiffRatio) {
      // A coarse whole-file rewrite (e.g. an AI edit) can merge badly against a
      // concurrent edit. Snapshot the pre-diff state first so it's recoverable
      // (spec 02 §6, spec 03 §5). The snapshot row IS the recovery point; the
      // diff then lands as fresh updates on top of it.
      try {
        // Same watermarked order as `compact()`: flush the appends we know
        // about, snapshot, then truncate only up to the last of them — an
        // update appended while this save is in flight is not in the snapshot
        // and must not be deleted with the log it describes.
        await this.whenPersisted();
        const upTo = this.maxPersistedRow;
        const rows = this.logLength;
        const bytes = this.logBytes;
        const snapshot = Y.encodeStateAsUpdate(this.doc);
        const stateVector = Y.encodeStateVector(this.doc);
        await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector, upTo);
        this.logLength = Math.max(0, this.logLength - rows);
        this.logBytes = Math.max(0, this.logBytes - bytes);
        this.recoverySnapshotTaken = true;
      } catch (e) {
        this.reportError(e, "ingest:recoverySnapshot");
      }
    }

    if (this.destroyed) return false;
    // A pull may have delivered exactly these file bytes during the snapshot.
    if (this.text.toString() === fileText) {
      this.lastWrittenHash = fileHash;
      return false;
    }
    stopTracking();
    const target = getBaseline();
    const vector = target === this.doc ? null : Y.encodeStateVector(target);
    target.transact(() => {
      applyDiff(target.getText("content"), diffs);
    }, ORIGIN_DISK);
    // `target` now reads exactly the file: the three-way base for a later
    // stale write (the branch's ops are all merged into the live doc below).
    this.observe(fileHash, this.stateIfText(fileText, target));
    if (vector) {
      Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(target, vector), ORIGIN_DISK);
      // The peer's previous egest may already have finished while the read was
      // pending. Persist the merged result and do not re-ingest the same disk
      // input while that write is pending (including across retries).
      if (this.text.toString() !== fileText) {
        this.pendingMergedFileHash = fileHash;
        this.scheduleEgest();
      }
    }
    // The ONLY place disk bytes enter the doc. Every refusal above (echo hash,
    // converged, 0-byte, oversize, unseeded-empty) returns before this, so the
    // no-socket fast path in `ContentUploader.pushOne` keeps firing for our own
    // egest echoes — the flag is set strictly for merges that really happened.
    this.diskMergedUnreported = true;
    this.recordDiskBase(fileHash);
    return true;
  }

  // ---- B. CRDT → DISK (egest) ------------------------------------------

  private scheduleEgest(): void {
    if (this.destroyed) return;
    // Waiting for the first pull: the file has not been reconciled yet, and a
    // write now would overwrite an edit made outside the app before it is read.
    if (this.prePull) {
      this.egestDeferred = true;
      return;
    }
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.egestTimer = this.setT(() => {
      this.egestTimer = null;
      void this.drainEgest();
    }, this.cfg.egestDebounceMs);
  }

  /**
   * Run one egest pass, never overlapping another — the twin of
   * {@link drainIngest}'s chain.
   *
   * Two overlapping passes both write the SAME file through
   * `write_note`'s temp-file-and-rename, and neither holds a lock: they
   * interleave in the temp file and the loser's rename fails (a spurious egest
   * failure + backoff). `writeThrough` calling `drainEgest` while a debounced
   * one is still awaiting its write is the routine way in — the registry's
   * `materializeContent` does exactly that. Serialized here, so the second pass
   * writes the doc as the first left it (and usually finds the echo hash
   * already matching, so it writes nothing at all).
   */
  private drainEgest(): Promise<void> {
    const prior = this.egestInFlight;
    const run = (async () => {
      if (prior) {
        try {
          await prior;
        } catch {
          // A failed pass must not strand the queue behind it.
        }
      }
      return this.runEgest();
    })();
    this.egestInFlight = run;
    return run.finally(() => {
      if (this.egestInFlight === run) this.egestInFlight = null;
    });
  }

  private async runEgest(): Promise<void> {
    if (this.destroyed) return;
    const content = this.text.toString();
    // Data-loss guard: a doc that has never held content this session is either
    // un-hydrated or bound to the wrong doc_id. Writing its emptiness would wipe
    // a file that still has real bytes on disk, so refuse (a genuine clear-all
    // sets everHadContent first, so real deletions are unaffected). This closes
    // the import/background-feed clobber that zeroed notes on disk.
    if (content.length === 0 && !this.everHadContent) {
      let current = "";
      try {
        current = await this.io.readFile(this._path);
      } catch {
        current = "";
      }
      if (current.length > 0) {
        console.warn(
          `[bridge] refusing to egest empty over non-empty file: ${this._path} (doc ${this.docId})`,
        );
        return;
      }
    }
    // Hash first, assign only once the bytes are CONFIRMED on disk. The guard
    // used to be primed before the write; a failed write (disk full, permission
    // lost, path gone) then left it pointing at bytes that never landed, so the
    // next watcher read of the still-stale file was judged against the wrong
    // baseline. Assigning after is still in time for the echo: the watcher's
    // event is debounced ~150ms in Rust and ~150ms more here, while this
    // assignment runs the moment the IPC resolves (spec 03 §5).
    const hash = await this.hash(content);
    // Nothing to write: the file already holds exactly these bytes. That is what
    // `lastWrittenHash` means on both sides — egest sets it once a write is
    // CONFIRMED on disk, ingest and the seed paths set it to the hash of the
    // file they just read. Writing anyway costs a real atomic write, a watcher
    // event, an index pass and a fresh mtime — and the mtime is the sidebar's
    // "Recently modified" sort key, so a no-op write reshuffles the rows under
    // the user's pointer for nothing. A failed write does NOT set the guard, so
    // a retry still writes.
    if (hash === this.lastWrittenHash) {
      // A write that had been failing no longer needs to land: the bytes it was
      // retrying to put on disk are already there.
      this.clearWriteFailure();
      return;
    }
    // Compare-and-swap (#216): only replace the bytes this bridge last saw.
    const blind = this.blindNextWrite;
    this.blindNextWrite = false;
    const expected = blind ? null : (this.observed?.hash ?? null);
    // The state these bytes come from, taken synchronously with the check that
    // the doc still reads `content` (the awaits above may have let an edit in).
    const writtenState = this.stateIfText(content);
    let result: Awaited<ReturnType<BridgeIO["writeFileAtomic"]>>;
    try {
      result = await this.io.writeFileAtomic(this._path, content, this.docId, expected);
    } catch (e) {
      // The .md on disk is the durable source of truth, so a lost write is a
      // data-safety event, not a log line: tell the UI, and retry with backoff
      // until it lands (the CRDT still holds the text; nothing is dropped).
      this.egestFailures++;
      this.reportError(e, "egest:write");
      try {
        this.io.onWriteFailed?.(this._path, e, this.egestFailures);
      } catch (hookErr) {
        this.reportError(hookErr, "egest:onWriteFailed");
      }
      this.scheduleEgestRetry();
      return;
    }
    if (result === "stale") {
      this.mergeStaleFile();
      return;
    }
    this.lastWrittenHash = hash;
    // `writeFileAtomic` recorded it durably along with the write.
    this.diskBase = hash;
    this.observe(hash, writtenState);
    if (this.text.toString() === content) this.pendingMergedFileHash = null;
    this.clearWriteFailure();
    // Indexing is derived state: a failure here is worth a log, not a re-write.
    if (this.io.reindex) {
      try {
        await this.io.reindex(this._path);
      } catch (e) {
        this.reportError(e, "egest:reindex");
      }
    }
  }

  /**
   * The compare-and-swap refused: the file moved on since this bridge last saw
   * it, so writing would have replaced someone else's newer text (#216). Nothing
   * was written. Merge the file in instead — three-way against the doc state
   * that last matched the file when there is one (the doc's own edits since then
   * and the file's both survive), else the ordinary ingest — and let that merge
   * schedule the fresh egest if the doc still differs from the file. Not a
   * write FAILURE: no toast, no backoff. Timings are the ingest's own.
   */
  private mergeStaleFile(): void {
    if (this.destroyed) return;
    // The echo guard named bytes that are no longer on disk.
    this.lastWrittenHash = null;
    const base = this.observed?.state ?? undefined;
    if (this.ingestTimer != null) {
      this.clearT(this.ingestTimer);
      this.ingestTimer = null;
    }
    this.ingestDirty = true;
    void this.drainIngest(base).catch((e) => this.reportError(e, "egest:stale"));
  }

  /** Retract a standing write failure: the file on disk now holds what the doc
   *  says, whether because a retry landed or because the doc came back around to
   *  the bytes already there. */
  private clearWriteFailure(): void {
    if (this.egestFailures === 0) return;
    this.egestFailures = 0;
    try {
      this.io.onWriteRecovered?.(this._path);
    } catch (hookErr) {
      this.reportError(hookErr, "egest:onWriteRecovered");
    }
  }

  /** Re-arm the egest after a failed write: 1s, 2s, 4s… capped (`egestRetryMaxMs`).
   *  Reuses `egestTimer`, so `flushEgest` (close/save) still forces an attempt
   *  and `destroy` still cancels it. */
  private scheduleEgestRetry(): void {
    if (this.destroyed) return;
    const delay = Math.min(
      this.cfg.egestRetryMaxMs,
      this.cfg.egestRetryBaseMs * 2 ** Math.max(0, this.egestFailures - 1),
    );
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.egestTimer = this.setT(() => {
      this.egestTimer = null;
      void this.drainEgest();
    }, delay);
  }

  /** Consecutive failed disk writes for this note (tests / observability). */
  get pendingWriteFailures(): number {
    return this.egestFailures;
  }

  /**
   * Flush a pending egest now (used on close / explicit save). No-op when
   * nothing is pending, so closing an untouched note performs no write.
   */
  async flushEgest(): Promise<void> {
    // A write deferred by the pull wait: reconcile first (it re-arms the egest).
    if (this.prePull && this.egestDeferred) await this.reconcileAfterPull();
    if (this.egestTimer == null) return;
    this.clearT(this.egestTimer);
    this.egestTimer = null;
    await this.drainEgest();
  }

  /** Cancel a pending CRDT→disk write without changing either surface.
   *
   * Used only when a read-only pull found divergent local file bytes and the
   * recovery copy could not be written. The file remains the durable copy; the
   * transient bridge may still persist/destroy normally without its retire path
   * overwriting those bytes with the Remote Vault's text. */
  cancelEgest(): void {
    this.egestDeferred = false;
    if (this.egestTimer == null) return;
    this.clearT(this.egestTimer);
    this.egestTimer = null;
  }

  /**
   * Resolve once every update this doc has produced is in the local CRDT store.
   *
   * Call it before `destroy()` on any bridge that applied ops — a cold apply, an
   * LRU retire — or the doc goes away holding updates the store never got. See
   * {@link persistQueue}.
   */
  async whenPersisted(): Promise<void> {
    try {
      await this.persistQueue;
    } catch {
      // Already reported by the append's own catch; a failed persist must not
      // stop a teardown.
    }
  }

  /**
   * Write the doc's text to disk NOW, whether or not an egest is pending.
   *
   * `flushEgest` deliberately no-ops with no timer armed, and after `hydrate`
   * there is none: applying persisted CRDT state fires no text observer, and the
   * echo hash is baselined at the doc's own text. Both are right for the normal
   * flow and wrong for the one case that has to write anyway — the registry
   * materializing a note this device already holds the content for, where the
   * file on disk is a 0-byte placeholder the doc must fill in
   * (`SyncManager.materializeContent`).
   *
   * Still goes through `drainEgest`, so the empty-over-non-empty guard, the
   * atomic write, the retry backoff and the echo-hash bookkeeping all apply.
   * Resolves true iff the file now holds the doc's bytes.
   */
  async writeThrough(): Promise<boolean> {
    if (this.destroyed) return false;
    // The caller wants the doc on disk now (a placeholder to fill): that ends
    // any pull wait without merging the placeholder's bytes in.
    this.abandonPull(false);
    if (this.egestTimer != null) {
      this.clearT(this.egestTimer);
      this.egestTimer = null;
    }
    // Force the write past the "the file already holds these bytes" shortcut:
    // that answer comes from `lastWrittenHash`, which hydrate set from the DOC,
    // not from the file.
    this.lastWrittenHash = null;
    // Unconditional (#216): the caller is filling a file it just created.
    this.blindNextWrite = true;
    await this.drainEgest();
    // A pass that returned before writing must not leave a later, ordinary
    // egest unconditional.
    this.blindNextWrite = false;
    return this.egestFailures === 0;
  }

  // ---- Edit entry points -----------------------------------------------

  /** Apply a local editor edit (origin 'editor'); schedules an egest. */
  edit(mutator: (text: Y.Text) => void): void {
    this.doc.transact(() => mutator(this.text), ORIGIN_EDITOR);
  }

  /** Apply a remote update from the network provider (Phase 2). */
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, ORIGIN_REMOTE);
  }

  // ---- Undo history bound -----------------------------------------------

  /** Retained undo steps (for tests/observability). */
  get undoDepth(): number {
    return this.undoManager.undoStack.length;
  }

  /**
   * Drop the oldest undo steps once the stack exceeds `cfg.undoStackLimit`.
   *
   * Two things grow per step, and both have to be released:
   *   1. the `StackItem` itself, and
   *   2. the GC pin Yjs puts on every struct that step deleted —
   *      `UndoManager`'s afterTransaction handler calls `keepItem(item, true)`
   *      so undo can restore the text, which makes the deleted content
   *      un-collectable for the lifetime of the doc.
   *
   * Yjs releases (2) in `clear()` but exposes no "forget the oldest step" API,
   * so we mirror its `clearUndoManagerStackItem` with the public primitives
   * (`iterateDeletedStructs` + `Item.keep` + `tryGc`). Steps are dropped from
   * the FRONT, so recent history — the only history a user actually reaches —
   * is untouched.
   */
  private trimUndoHistory(): void {
    const limit = this.cfg.undoStackLimit;
    if (limit <= 0) return;
    const stack = this.undoManager.undoStack;
    const excess = stack.length - limit;
    if (excess <= 0) return;
    const dropped = stack.splice(0, excess);

    // Un-pin what the dropped steps were holding. A step's `deletions` set is
    // disjoint from every other step's (a struct can only be deleted once), so
    // this can never un-pin content a retained step still needs to restore.
    this.doc.transact((tr) => {
      for (const item of dropped) {
        Y.iterateDeletedStructs(tr, item.deletions, (struct) => {
          // `keepItem` also walks parents, but this doc's scope is a ROOT
          // Y.Text, so a struct's parent has no `_item` to un-pin.
          if (struct instanceof Y.Item && this.inUndoScope(tr, struct)) {
            struct.keep = false;
          }
        });
      }
    });
    // The current transaction's own deletions are GC'd by Yjs at cleanup, but
    // these were deleted long ago — collect them explicitly now that nothing
    // pins them. (This transaction changes no content, so it emits no update.)
    if (this.doc.gc) {
      for (const item of dropped) {
        Y.tryGc(item.deletions, this.doc.store, this.doc.gcFilter);
      }
    }
  }

  private inUndoScope(tr: Y.Transaction, struct: Y.Item): boolean {
    return this.undoManager.scope.some(
      (type) =>
        type === tr.doc ||
        (type instanceof Y.AbstractType && Y.isParentOf(type, struct)),
    );
  }

  // ---- Compaction -------------------------------------------------------

  /**
   * Is the pending log worth replacing with a snapshot?
   *
   * Either measure alone is incomplete: many tiny updates (a long typing
   * session) and a few enormous ones (a paste, an AI whole-file rewrite) both
   * make a log that is slower to load than the snapshot it describes.
   */
  private shouldCompact(): boolean {
    if (this.compacting || this.destroyed) return false;
    if (this.cfg.compactBytes > 0 && this.logBytes > this.cfg.compactBytes) return true;
    return this.logLength > this.cfg.compactThreshold;
  }

  /**
   * Merge the log into one snapshot and truncate it (spec 02 §4).
   *
   * Watermarked, and in this order: settle every append we have issued
   * (`whenPersisted`), THEN encode, THEN delete only up to the highest row id
   * we were told about. Compaction fires mid-typing (64 rows), and the awaited
   * `saveSnapshot` is a window in which `onDocUpdate` keeps appending; those
   * rows are not in the snapshot, and a log truncation that took them too left
   * the doc loading short — later updates referencing a missing item stay
   * pending in Yjs forever. See {@link CrdtPersistence.saveSnapshot}.
   */
  async compact(): Promise<void> {
    this.compacting = true;
    try {
      await this.whenPersisted();
      // Taken together, and only after the flush: every row at or below this id
      // is committed, and every update it holds is already in the doc we are
      // about to encode.
      const upTo = this.maxPersistedRow;
      const rows = this.logLength;
      const bytes = this.logBytes;
      const snapshot = Y.encodeStateAsUpdate(this.doc);
      const stateVector = Y.encodeStateVector(this.doc);
      await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector, upTo);
      // Subtracted, never zeroed: what this snapshot replaced is what it
      // covered, and anything appended during the save is still in the log.
      this.logLength = Math.max(0, this.logLength - rows);
      this.logBytes = Math.max(0, this.logBytes - bytes);
    } finally {
      this.compacting = false;
    }
  }

  // ---- Teardown ---------------------------------------------------------

  /** True once `destroy()` has run — a destroyed bridge must not be reused. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ingestTimer != null) this.clearT(this.ingestTimer);
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.ingestTimer = null;
    this.egestTimer = null;
    this.releasePull();
    this.text.unobserve(this.onTextChange);
    this.doc.off("update", this.onDocUpdate);
    this.undoManager.off("stack-item-added", this.onUndoStackItemAdded);
    this.undoManager.destroy();
    this.doc.destroy();
  }

  // ---- helpers ----------------------------------------------------------

  private async hash(text: string): Promise<string> {
    return await this.io.sha256(text);
  }

  private reportError(err: unknown, context: string): void {
    if (this.io.onError) this.io.onError(err, context);
    else console.error(`[bridge:${context}]`, err);
  }
}
