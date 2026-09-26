// The file↔CRDT bridge — dependency-injected I/O surface (spec 03 §5).
//
// The bridge is a PURE TypeScript module: it never imports Tauri or the DOM, so
// it runs under vitest in Node against an in-memory fake. Production wires these
// ports to `ipc.ts` (see `adapter.ts`).

/** Transaction origins that flow through the CRDT (spec 03 §5). */
export const ORIGIN_DISK = "disk"; // a file change we read in and diffed
export const ORIGIN_EDITOR = "editor"; // a local user edit (via y-codemirror binding)
export const ORIGIN_REMOTE = "remote"; // reserved for the Phase-2 network provider

export type Origin =
  | typeof ORIGIN_DISK
  | typeof ORIGIN_EDITOR
  | typeof ORIGIN_REMOTE;

/** A doc's persisted CRDT state, as returned by `load_yjs_state`. */
export interface YjsPersistedState {
  /** Latest merged snapshot as raw Yjs update bytes, or null if none. */
  snapshot: Uint8Array | null;
  /** Every update logged since that snapshot, oldest first. */
  updates: Uint8Array[];
  /** `updates.length` — we compact when this exceeds the threshold after load. */
  updateCount: number;
  /**
   * The highest row id among `updates` (SQLite rowid), when the store can say.
   *
   * The compaction watermark for a log this bridge did not append itself: a
   * load-time compaction has to truncate exactly the rows it just read and
   * nothing newer. Absent (an older host that doesn't report it) means "no
   * watermark", and a compaction then writes the snapshot without truncating —
   * a log that is read twice, never an update that is deleted unseen.
   */
  lastUpdateId?: number;
}

/** Durable CRDT store. Production maps this to the SQLite-backed Rust commands. */
export interface CrdtPersistence {
  loadState(docId: string): Promise<YjsPersistedState>;
  /** Append one update to the doc's log and answer the row it landed in. Row
   *  ids are monotonic in commit order, which is what makes them a usable
   *  compaction watermark (see {@link saveSnapshot}). */
  appendUpdate(docId: string, update: Uint8Array): Promise<number>;
  /**
   * Write a merged snapshot + state vector, truncating the doc's update log up
   * to `upTo` — and NO further.
   *
   * The watermark is the whole point. A snapshot is encoded from the doc as it
   * was, then written; updates issued during that await (every keystroke of an
   * ordinary typing session — the trigger fires at 64 rows) are NOT in it. A
   * blanket `DELETE FROM yjs_updates WHERE doc_id = ?` deleted them anyway, and
   * the doc then loaded SHORT: the surviving later updates reference the missing
   * one's items, so Yjs parks them as pending and never integrates them.
   * `upTo` is the highest row id the caller knows is both committed and folded
   * into this snapshot; omitting it deletes NOTHING (snapshot only).
   */
  saveSnapshot(
    docId: string,
    snapshot: Uint8Array,
    stateVector: Uint8Array,
    upTo?: number,
  ): Promise<void>;
  /**
   * The doc's DISK BASE (#200): sha256 of the bytes this device last synced
   * between the doc's file and its CRDT — last written by egest (recorded by
   * `writeFileAtomic` when it is given the doc id) or last read into the doc
   * by an ingest or a seed. Null when none was ever recorded. Optional: a
   * store without it leaves the bridge on its older rule (every differing
   * file is diffed).
   */
  loadDiskBase?(docId: string): Promise<string | null>;
  /** Record the disk base after the bridge read a file INTO the doc. */
  saveDiskBase?(docId: string, sha256: string): Promise<void>;
}

/** What a compare-and-swap write did. */
export type WriteResult = "written" | "stale";

/** All I/O the bridge depends on, injected so it is testable in isolation. */
export interface BridgeIO {
  readFile(path: string): Promise<string>;
  /**
   * Atomic write. `docId` is passed by the bridge's egest so the store can
   * record the written bytes as that doc's disk base with the write.
   *
   * Compare-and-swap (#216): with `expectedSha` (sha256 of the file bytes this
   * bridge last observed; the empty-string hash for "no file"), the store must
   * NOT write when the file no longer hashes to it, and resolve `"stale"`
   * instead. `undefined`/`null` is an unconditional write. Resolving nothing
   * (`void`) means written, so a store without CAS support stays valid.
   */
  writeFileAtomic(
    path: string,
    content: string,
    docId?: string,
    expectedSha?: string | null,
  ): Promise<void | WriteResult>;
  /** SHA-256 hex of `text`. May be sync (Node) or async (Web Crypto). */
  sha256(text: string): Promise<string> | string;
  persistence: CrdtPersistence;
  /**
   * Optional: preserve `content` (bytes found at `path`) as a recovery copy
   * under `.context/trash`, resolving to where it landed. Used before a
   * signed-in open whose file the doc cannot take in yet — no local CRDT, and
   * bytes that differ from the disk base — so the first pull's egest can never
   * be the only thing that ever happened to them.
   */
  saveRecoveryCopy?(path: string, content: string): Promise<string | null>;
  /** Optional: re-index a written file if `writeFileAtomic` doesn't itself. */
  reindex?(path: string): Promise<void> | void;
  /** Optional error sink (defaults to console.error). */
  onError?(err: unknown, context: string): void;
  /**
   * Optional: an egest (CRDT → disk) write FAILED. `attempt` counts consecutive
   * failures for this note; the bridge retries with backoff on its own, so this
   * is the UI's cue to say "couldn't save" — never a place to retry from.
   */
  onWriteFailed?(path: string, err: unknown, attempt: number): void;
  /** Optional: an egest write succeeded after one or more failures. */
  onWriteRecovered?(path: string): void;
  /** Optional timer injection; defaults to global setTimeout/clearTimeout. */
  setTimeout?(fn: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

/** Per-note tuning (defaults follow spec 03 §5). */
export interface BridgeConfig {
  /** Debounce before draining a file→CRDT ingest. */
  ingestDebounceMs: number;
  /** Debounce before a CRDT→file egest write. */
  egestDebounceMs: number;
  /** Compact the update log when it exceeds this many rows. */
  compactThreshold: number;
  /**
   * Compact the update log when it exceeds this many BYTES, whatever the row
   * count.
   *
   * The row count alone never fires on a real vault: the trigger was 64 rows and
   * the busiest doc on a 5,933-note vault held 58 — while 28 individual updates
   * were over 1 MB each (a paste, an AI rewrite, an image data-URI). So the log
   * a launch has to read back, and every doc load has to apply, grew without
   * bound under a threshold that was never reached. Bytes are what cost time
   * here, so bytes are what we count. 0 disables the check.
   */
  compactBytes: number;
  /** Take a recovery snapshot before a diff that churns this fraction of the doc. */
  largeDiffRatio: number;
  /**
   * Refuse to ingest a file larger than this many bytes.
   *
   * A note has no business being this big, and a file that gets there is almost
   * always damage rather than content — on 2026-09-04 a daily note reached
   * 68 MB (2.37M lines, 35 distinct) from the seed-vs-pull race that used to
   * double a doc's text. Ingesting such a file pulls the damage INTO the CRDT,
   * where it then propagates to every device and to the server. Matching the
   * sync layer's `MAX_NOTE_BYTES` keeps one rule: a note too big to upload is a
   * note we also refuse to read back in. 0 disables the check.
   */
  maxIngestBytes: number;
  /**
   * Allow a 0-byte file to clear a doc that still holds text (default false).
   *
   * The ingest-side twin of the egest clobber guard. A file that reads as
   * COMPLETELY empty against a populated doc is almost never an edit: it is the
   * registry's own 0-byte placeholder landing on a note whose content this
   * device already has (issue #93 — the placeholder was diff-merged as a
   * delete-all and pushed, destroying the server's copy), or a truncated write
   * caught mid-flight. Refusing costs a log line and a re-read; accepting costs
   * the note, on every device.
   *
   * A PARTIAL truncation still applies — this is only the all-or-nothing case.
   * Set true where clearing a note from disk must be honoured verbatim.
   */
  allowTruncateFromDisk: boolean;
  /** First retry delay after a failed egest write; doubles per consecutive
   *  failure up to `egestRetryMaxMs`. */
  egestRetryBaseMs: number;
  egestRetryMaxMs: number;
  /**
   * Undo grouping window: local edits landing within this many ms of each other
   * merge into ONE undo step (Yjs `UndoManager.captureTimeout`). This is what
   * keeps a burst of keystrokes from becoming one stack item per character.
   */
  undoCaptureTimeoutMs: number;
  /**
   * Hard cap on retained undo steps for one open note. Past this, the OLDEST
   * steps are dropped and their GC pins released (see
   * `NoteBridge.trimUndoHistory`) so a long session in one note cannot grow the
   * undo stack — or the deleted content it keeps un-collectable — without bound.
   * 0 disables trimming.
   */
  undoStackLimit: number;
  /**
   * Upper bound on how long a signed-in bridge waits for its first server pull
   * before it reconciles the file anyway (#200). While the pull is pending the
   * bridge neither ingests the file nor writes it; the sync layer normally
   * ends the wait itself (`reconcileAfterPull`) within a few seconds, and this
   * only guarantees no caller can leave a note unreconciled forever.
   */
  pullReconcileTimeoutMs: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  ingestDebounceMs: 150,
  egestDebounceMs: 300,
  compactThreshold: 64,
  // 1 MB of pending updates is already more than a snapshot of almost any note
  // would cost, so past this the log is pure overhead on every load.
  compactBytes: 1024 * 1024,
  largeDiffRatio: 0.6,
  maxIngestBytes: 10 * 1024 * 1024,
  allowTruncateFromDisk: false,
  egestRetryBaseMs: 1_000,
  egestRetryMaxMs: 30_000,
  // 500ms matches Yjs' own default and CodeMirror's `newGroupDelay`, so undo
  // granularity feels the same as the non-collab editor.
  undoCaptureTimeoutMs: 500,
  // 500 grouped steps ≈ 500 distinct edit bursts in a single note without
  // switching away — far past any realistic Ctrl+Z run (CodeMirror's own
  // history keeps ~100), while still bounding the stack.
  undoStackLimit: 500,
  pullReconcileTimeoutMs: 20_000,
};

export interface NoteBridgeOptions {
  docId: string;
  /** Vault-relative path of the note file. */
  path: string;
  config?: Partial<BridgeConfig>;
  /**
   * Seed the Y.Doc from the file on open when there is no persisted CRDT
   * (default true). Set false when signed in so the sync layer can pull from the
   * server FIRST and only seed an orphan afterwards (spec 03 §5 ordering rule);
   * the sync layer then calls `seedFromFileIfEmpty()`.
   */
  seedFromFile?: boolean;
}
