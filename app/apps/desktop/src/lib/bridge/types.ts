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
}

/** Durable CRDT store. Production maps this to the SQLite-backed Rust commands. */
export interface CrdtPersistence {
  loadState(docId: string): Promise<YjsPersistedState>;
  appendUpdate(docId: string, update: Uint8Array): Promise<void>;
  /** Write a merged snapshot + state vector, truncating the doc's update log. */
  saveSnapshot(
    docId: string,
    snapshot: Uint8Array,
    stateVector: Uint8Array,
  ): Promise<void>;
}

/** All I/O the bridge depends on, injected so it is testable in isolation. */
export interface BridgeIO {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  /** SHA-256 hex of `text`. May be sync (Node) or async (Web Crypto). */
  sha256(text: string): Promise<string> | string;
  persistence: CrdtPersistence;
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
  /** Compact the update log when it exceeds this many rows after load. */
  compactThreshold: number;
  /** Take a recovery snapshot before a diff that churns this fraction of the doc. */
  largeDiffRatio: number;
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
}

export const DEFAULT_CONFIG: BridgeConfig = {
  ingestDebounceMs: 150,
  egestDebounceMs: 300,
  compactThreshold: 64,
  largeDiffRatio: 0.6,
  egestRetryBaseMs: 1_000,
  egestRetryMaxMs: 30_000,
  // 500ms matches Yjs' own default and CodeMirror's `newGroupDelay`, so undo
  // granularity feels the same as the non-collab editor.
  undoCaptureTimeoutMs: 500,
  // 500 grouped steps ≈ 500 distinct edit bursts in a single note without
  // switching away — far past any realistic Ctrl+Z run (CodeMirror's own
  // history keeps ~100), while still bounding the stack.
  undoStackLimit: 500,
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
