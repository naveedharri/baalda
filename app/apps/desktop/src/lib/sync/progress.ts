// Throttled sync-progress reporting: the observable half of a vault's bulk sync
// run (spec contract `SyncProgress` / `DocSyncState`, declared in `vaultScope.ts`).
//
// Two problems this solves.
//
//  1. There was NO progress at all. A multi-minute backfill of a 500-note vault
//     rendered one static "Syncing…", which is why the app read as hung.
//  2. Reporting it naively is worse than not reporting it: a `set()` per note
//     over 500 notes (times two — the counter and the per-doc badge) is 1,000
//     React renders of the sidebar. So every emission here is coalesced onto a
//     leading-edge + trailing-flush throttle, capped at ~10 emissions/second, and
//     per-doc transitions accumulate into ONE batched patch per emission.
//
// Keyed by `docId`, never by path — see the `DocSyncState` doc comment.
//
// Pure: all timers are injectable, so the unit tests drive it deterministically.

import type { DocSyncState, SyncProgress, SyncProgressPhase } from "./vaultScope";

/** The write surface a bulk phase uses to report itself. */
export interface SyncProgressSink {
  /** Enter `phase`, optionally resetting the counters to a fresh `total`. */
  phase(phase: SyncProgressPhase, total?: number): void;
  /** Grow the current phase's denominator (work discovered mid-run). */
  addTotal(n: number): void;
  /** One unit of work finished. `failed` counts it in BOTH `done` and `failed`. */
  item(outcome: "ok" | "failed"): void;
  /** Record a document's state transition (batched). */
  doc(docId: string, state: DocSyncState): void;
  /** Emit everything pending right now (end of a phase / end of the run). */
  flush(): void;
}

/** A sink that discards everything — the default for unit tests and for any
 *  bulk phase constructed without a reporter. */
export const nullProgressSink: SyncProgressSink = {
  phase: () => {},
  addTotal: () => {},
  item: () => {},
  doc: () => {},
  flush: () => {},
};

export interface SyncProgressReporterOptions {
  /** Mirror the counters into the store (`setSyncProgress`). */
  onProgress: (progress: SyncProgress | null) => void;
  /** Mirror a batch of per-doc transitions (`patchDocSyncState`). A `null` value
   *  drops that docId. */
  onDocState: (patch: Record<string, DocSyncState | null>) => void;
  /** Minimum gap between emissions. Default 100ms (≈10 store writes/second). */
  throttleMs?: number;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Accumulates a run's progress and pushes it out at most ~10×/second.
 *
 * One reporter per {@link import("./vaultScope").VaultScope}: `SyncManager`
 * creates it on `enable` and disposes it in `teardown`, so a report can never
 * outlive the vault it describes. The store additionally clears both fields on
 * every vault change (`vaultScopedSyncReset`), which is the second line of
 * defence for the same invariant.
 */
export class SyncProgressReporter implements SyncProgressSink {
  private readonly onProgress: (p: SyncProgress | null) => void;
  private readonly onDocState: (patch: Record<string, DocSyncState | null>) => void;
  private readonly throttleMs: number;
  private readonly nowFn: () => number;
  private readonly setT: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearT: (h: ReturnType<typeof setTimeout>) => void;

  private current: SyncProgress = { phase: "idle", done: 0, total: 0, failed: 0 };
  /** Per-doc transitions not yet pushed. Last write per docId wins — a doc that
   *  went queued→syncing→synced inside one window emits only "synced". */
  private pendingDocs = new Map<string, DocSyncState | null>();
  private dirty = false;
  private lastEmitAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: SyncProgressReporterOptions) {
    this.onProgress = opts.onProgress;
    this.onDocState = opts.onDocState;
    this.throttleMs = opts.throttleMs ?? 100;
    this.nowFn = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  }

  /** Snapshot of the counters (tests / the manager's own honesty checks). */
  snapshot(): SyncProgress {
    return { ...this.current };
  }

  phase(phase: SyncProgressPhase, total?: number): void {
    if (total === undefined) {
      this.current = { ...this.current, phase };
    } else {
      // A new denominator means a new phase of work: reset the numerators too,
      // or "12/500 uploading" would carry the registering phase's count.
      this.current = { phase, done: 0, total, failed: 0 };
    }
    this.dirty = true;
    // Phase changes are rare and are what the UI keys its copy off, so they are
    // never throttled away — they emit on the next tick of the window at worst.
    this.schedule(true);
  }

  addTotal(n: number): void {
    if (n === 0) return;
    this.current = { ...this.current, total: Math.max(0, this.current.total + n) };
    this.dirty = true;
    this.schedule(false);
  }

  item(outcome: "ok" | "failed"): void {
    this.current = {
      ...this.current,
      done: this.current.done + 1,
      failed: this.current.failed + (outcome === "failed" ? 1 : 0),
    };
    this.dirty = true;
    this.schedule(false);
  }

  doc(docId: string, state: DocSyncState): void {
    this.pendingDocs.set(docId, state);
    this.dirty = true;
    this.schedule(false);
  }

  /** Stop tracking a doc (deleted / no longer mapped). */
  forgetDoc(docId: string): void {
    this.pendingDocs.set(docId, null);
    this.dirty = true;
    this.schedule(false);
  }

  flush(): void {
    if (this.disposed) return;
    this.emit();
  }

  /**
   * Drop the reporter and null out the store's progress. Called from
   * `SyncManager.teardown`, so a run for the vault we just left can neither emit
   * again nor leave a half-finished count on screen.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      this.clearT(this.timer);
      this.timer = null;
    }
    this.pendingDocs.clear();
    this.dirty = false;
    this.onProgress(null);
  }

  private schedule(immediate: boolean): void {
    if (this.disposed || this.timer) return;
    const since = this.nowFn() - this.lastEmitAt;
    if (immediate || since >= this.throttleMs) {
      this.emit();
      return;
    }
    // Trailing edge: everything accumulated during the window goes out in one
    // emission when it closes.
    this.timer = this.setT(() => {
      this.timer = null;
      this.emit();
    }, this.throttleMs - since);
  }

  private emit(): void {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    this.lastEmitAt = this.nowFn();
    if (this.pendingDocs.size > 0) {
      const patch: Record<string, DocSyncState | null> = {};
      for (const [docId, state] of this.pendingDocs) patch[docId] = state;
      this.pendingDocs.clear();
      this.onDocState(patch);
    }
    this.onProgress({ ...this.current });
  }
}
