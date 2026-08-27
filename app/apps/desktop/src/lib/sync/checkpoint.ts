// Coalesced single-writer checkpointing for `.context/config.json`.
//
// The doc-id map used to be written EXACTLY ONCE, after every server row had
// been created. Two consequences, both of which this module removes:
//
//   • A run that died at note 200/500 persisted NOTHING. The next launch redid
//     the whole vault and leaned on a fragile "adopt the org's oldest vault"
//     heuristic to find its way back.
//   • `registerNote` (⌘N) read the file, merged one key, and wrote the whole
//     thing back — O(N) bytes per note, O(N²) for a vault being filled in.
//
// The fix is a checkpointer: callers mutate their in-memory maps and `touch()`,
// and the map is flushed when a batch fills OR a time window closes, whichever
// comes first. A kill -9 therefore loses at most one batch, and `registerNote`
// costs O(1) amortized (no read at all, and a write only once per batch/window).
//
// Single writer: every flush is chained behind the previous one, so two
// overlapping flushes can never interleave and write a torn map. Pure — timers
// injectable — so it is unit-testable without Tauri.

/**
 * Flush batch for a vault with `mapped` notes in its doc map.
 *
 * config.json is not a small file: it carries a `docs` entry, a `baseline` entry
 * and (once pushed) a `pushed` entry per note, so a 5,000-note vault writes
 * ~megabytes per flush. A fixed 25-item batch therefore turns a big backfill into
 * ~200 whole-file rewrites — hundreds of megabytes of disk churn on the very
 * vaults that are already struggling. Scaling the batch with the map keeps the
 * number of writes roughly constant (~50 per full run) instead of the SIZE of
 * each write being the only thing that grows.
 *
 * Never below 25: a small vault must still checkpoint often enough that a kill -9
 * loses under a second of work.
 */
export function checkpointBatchFor(mapped: number): number {
  return Math.max(25, Math.floor(mapped / 50));
}

export interface CheckpointOptions<T> {
  /** Serialize + persist the value. Must not throw for a normal failure — the
   *  checkpointer logs and keeps the dirty flag so the next window retries. */
  write: (value: T) => Promise<void>;
  /** Snapshot the caller's current in-memory state, at flush time. */
  snapshot: () => T;
  /** Flush once this many `touch()` units have accumulated. Default 25. */
  everyItems?: number;
  /** Flush at most this long after the first pending `touch()`. Default 750ms. */
  everyMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * A batching, single-writer flusher for one derived-state file.
 *
 * Defaults (25 items / 750ms) are chosen so a kill -9 during a big backfill
 * loses under a second of progress, while a 500-note run writes config.json
 * ~20 times instead of ~500 (or, before this, once — at the very end).
 */
export class Checkpointer<T> {
  private readonly writeFn: (value: T) => Promise<void>;
  private readonly snapshotFn: () => T;
  /** Not readonly: {@link Checkpointer.setEveryItems} retunes it once the caller
   *  knows how big this vault's map actually is. */
  private everyItems: number;
  private readonly everyMs: number;
  private readonly setT: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearT: (h: ReturnType<typeof setTimeout>) => void;

  private pending = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** The write chain. Every flush queues behind it, so there is one writer. */
  private chain: Promise<void> = Promise.resolve();
  /** Completed flushes, for tests ("did we checkpoint incrementally?"). */
  writes = 0;

  constructor(opts: CheckpointOptions<T>) {
    this.writeFn = opts.write;
    this.snapshotFn = opts.snapshot;
    this.everyItems = Math.max(1, opts.everyItems ?? 25);
    this.everyMs = Math.max(0, opts.everyMs ?? 750);
    this.setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  }

  /**
   * Retune the batch size mid-life — the caller only learns the vault's size
   * after it has read config.json, which is already past construction.
   *
   * Flushes immediately if the new (smaller) batch is already full, so lowering
   * it can't leave a write owed indefinitely.
   */
  setEveryItems(n: number): void {
    this.everyItems = Math.max(1, Math.floor(n));
    if (!this.disposed && this.pending >= this.everyItems) void this.flush();
  }

  /** Note that `n` units of work happened. Flushes when the batch fills, else
   *  arms the time window. Never awaited by the caller — that's the point. */
  touch(n = 1): void {
    if (this.disposed) return;
    this.pending += n;
    this.dirty = true;
    if (this.pending >= this.everyItems) {
      void this.flush();
      return;
    }
    if (this.timer == null) {
      this.timer = this.setT(() => {
        this.timer = null;
        void this.flush();
      }, this.everyMs);
    }
  }

  /**
   * Flush now and resolve once the write has landed. Safe to call when nothing is
   * dirty (it still waits out an in-flight write, which is what makes it usable
   * as an end-of-phase barrier).
   */
  flush(): Promise<void> {
    if (this.disposed) return this.chain;
    if (this.timer != null) {
      this.clearT(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    this.pending = 0;
    const run = this.chain.then(async () => {
      if (this.disposed) return; // vault switched while we were queued
      // Snapshot INSIDE the chain, not at call time: the value written is then
      // always the newest state, so a coalesced burst collapses into one write of
      // the final map rather than a series of stale ones.
      try {
        await this.writeFn(this.snapshotFn());
        this.writes++;
      } catch (e) {
        // Keep the run going but remember we still owe a write.
        this.dirty = true;
        console.warn("[checkpoint] flush failed", e);
      }
    });
    this.chain = run;
    return run;
  }

  /** True while a write is owed (tests / teardown assertions). */
  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Abandon everything pending, synchronously.
   *
   * MUST be called on a vault switch, and it must be synchronous: a queued flush
   * that ran after the switch would snapshot the vault we left and write it into
   * the folder we just opened, which is the exact cross-vault corruption the
   * scope guards exist to prevent.
   */
  dispose(): void {
    this.disposed = true;
    this.dirty = false;
    this.pending = 0;
    if (this.timer != null) {
      this.clearT(this.timer);
      this.timer = null;
    }
  }
}
