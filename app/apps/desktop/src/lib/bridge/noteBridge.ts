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

  /** Count of updates in the persisted log since the last snapshot/compaction. */
  private logLength = 0;
  /** Monotonic count of every update ever observed on this doc (for assertions). */
  private observedUpdates = 0;
  /** Whether the oversize refusal has already been reported for the current
   *  run of oversized reads, so one runaway file logs once, not per watcher
   *  event. Cleared as soon as a normal-sized read comes through. */
  private oversizeReported = false;
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
      void Promise.resolve(this.io.persistence.appendUpdate(this.docId, update)).catch(
        (e) => this.reportError(e, "appendUpdate"),
      );
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
    const state = await this.io.persistence.loadState(this.docId);
    const hasPersisted = state.snapshot != null || state.updates.length > 0;

    if (hasPersisted) {
      // Apply persisted state BEFORE subscribing, so we don't re-append what we
      // just loaded. Yjs updates are idempotent, but re-appending grows the log.
      this.doc.transact(() => {
        if (state.snapshot) Y.applyUpdate(this.doc, state.snapshot, "persistence");
        for (const u of state.updates) Y.applyUpdate(this.doc, u, "persistence");
      }, "persistence");
      this.logLength = state.updateCount;
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
      // will). Converged content no-ops. Guarded on a non-empty doc: an empty
      // doc must go through the deferred pull-before-seed path, never a
      // pre-sync ingest (that's the note-doubling bug).
      if (this.text.length > 0) this.ingest();
      if (state.updateCount > this.cfg.compactThreshold) await this.compact();
    } else {
      // No CRDT yet. Normally seed Y.Text from the file in a 'disk' transaction
      // (persisted but not echoed back as a write). When `seedOnOpen` is false
      // (signed in) we DEFER: leave the doc empty so the sync layer can pull the
      // server's canonical state first, then call `seedFromFileIfEmpty()` for a
      // genuine orphan (spec 03 §5 startup ordering).
      this.subscribe();
      let fileText = "";
      try {
        fileText = await this.io.readFile(this._path);
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
    }
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
    return true;
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
   */
  async ingestNow(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.ingestTimer != null) {
      this.clearT(this.ingestTimer);
      this.ingestTimer = null;
    }
    this.ingestDirty = true;
    return this.drainIngest();
  }

  private async drainIngest(): Promise<boolean> {
    if (this.destroyed || !this.ingestDirty) return false;
    this.ingestDirty = false;

    let fileText: string;
    try {
      fileText = await this.io.readFile(this._path);
    } catch (e) {
      this.reportError(e, "ingest:readFile");
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
      return false;
    }
    this.oversizeReported = false;

    const fileHash = await this.hash(fileText);
    if (fileHash === this.lastWrittenHash) return false; // our own write echoing back → DROP

    const current = this.text.toString();
    if (current === fileText) {
      // Already converged (e.g. we ingested this exact change already).
      this.lastWrittenHash = fileHash;
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
        const snapshot = Y.encodeStateAsUpdate(this.doc);
        const stateVector = Y.encodeStateVector(this.doc);
        await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector);
        this.logLength = 0;
        this.recoverySnapshotTaken = true;
      } catch (e) {
        this.reportError(e, "ingest:recoverySnapshot");
      }
    }

    this.doc.transact(() => {
      applyDiff(this.text, diffs);
    }, ORIGIN_DISK);
    return true;
  }

  // ---- B. CRDT → DISK (egest) ------------------------------------------

  private scheduleEgest(): void {
    if (this.destroyed) return;
    if (this.egestTimer != null) this.clearT(this.egestTimer);
    this.egestTimer = this.setT(() => {
      this.egestTimer = null;
      void this.drainEgest();
    }, this.cfg.egestDebounceMs);
  }

  private async drainEgest(): Promise<void> {
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
    try {
      await this.io.writeFileAtomic(this._path, content);
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
    this.lastWrittenHash = hash;
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
    if (this.egestTimer == null) return;
    this.clearT(this.egestTimer);
    this.egestTimer = null;
    await this.drainEgest();
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

  /** Merge the log into one snapshot and truncate it (spec 02 §4). */
  async compact(): Promise<void> {
    const snapshot = Y.encodeStateAsUpdate(this.doc);
    const stateVector = Y.encodeStateVector(this.doc);
    await this.io.persistence.saveSnapshot(this.docId, snapshot, stateVector);
    this.logLength = 0;
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
