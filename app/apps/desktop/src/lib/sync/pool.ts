// Bounded-concurrency work pool + bounded retry — the two primitives every bulk
// vault operation is built from (registry structure sync, content upload).
//
// Why this module exists: every bulk path in the sync layer used to be a
// `for (const x of items) await f(x)` — concurrency 1, no cancellation
// checkpoint between items, and one thrown error abandoning the rest of the run.
// A 500-note vault therefore spent minutes in a single un-cancellable await
// while the UI showed a static "Syncing…".
//
// Deliberately a pure leaf module (no imports) so it can be used from any layer
// and unit-tested without Tauri, the network, or fake timers.

/** How many vault-registry HTTP writes we keep in flight at once.
 *
 *  6, matching the per-host connection limit browsers (and therefore the Tauri
 *  webview's fetch) enforce. Below that we leave the link idle; above it the
 *  extra requests just queue inside the network stack, where we can neither see
 *  them nor cancel them — so the only thing more concurrency buys is a coarser
 *  cancellation checkpoint and more memory held per in-flight request. */
export const REGISTRY_CONCURRENCY = 6;

/** How many notes we push content for at once.
 *
 *  4, deliberately lower than {@link REGISTRY_CONCURRENCY}: each unit here is a
 *  WebSocket + a resident `NoteBridge` (a whole Y.Doc plus its persisted log),
 *  not one small JSON request, so the cost of a wider pool is measured in
 *  sockets and heap rather than in idle link time. 4 keeps the peak at four
 *  documents materialized at once while still hiding per-doc connect latency. */
export const UPLOAD_CONCURRENCY = 4;

export interface PoolOptions {
  /** Maximum items in flight. Clamped to `[1, items.length]`. */
  concurrency: number;
  /**
   * Consulted before every item is picked up. Returning true abandons the rest
   * of the run — this is how a vault switch cancels a 500-item pool mid-flight.
   * Silent: "the user moved on" is not an error.
   */
  shouldStop?: () => boolean;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, in order.
 *
 * Errors are the worker's business: anything it throws is swallowed here so one
 * bad item never abandons the rest of the pool (the worker is expected to record
 * the failure itself — see {@link withRetry}). Resolves once every item has been
 * visited or `shouldStop()` went true.
 */
export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  opts: PoolOptions,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(opts.concurrency, items.length));
  let cursor = 0;
  const lanes = Array.from({ length: width }, async () => {
    // Re-checked per item, not per pool: a 500-note run is 500 chances for the
    // user to switch vaults, and every one of them must drop the remainder.
    while (cursor < items.length) {
      if (opts.shouldStop?.()) return;
      const index = cursor++;
      try {
        await worker(items[index], index);
      } catch {
        /* the worker owns its own error reporting */
      }
    }
  });
  await Promise.all(lanes);
}

/** Outcome of a retried operation. */
export type RetryOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; terminal: boolean; attempts: number };

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff step in ms; doubles per attempt. Default 400. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  maxMs?: number;
  /**
   * "Retrying this can never help" — a 403, a 409 doc-id collision, a 402 plan
   * limit. Such an error is reported immediately as `terminal: true` so the
   * caller can surface it instead of burning the retry budget on it.
   */
  isTerminal?: (err: unknown) => boolean;
  /** Abandon between attempts (vault switch). Reported as terminal. */
  shouldStop?: () => boolean;
  /** Injected in tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; jitter multiplier source. Defaults to `Math.random`. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` with bounded retries and jittered exponential backoff, never
 * throwing: the outcome is returned so the caller can record a terminal per-doc
 * error rather than swallow it into a `console.error` (which is exactly how an
 * arbitrary subset of a vault used to end up silently local-only forever).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 5_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastError: unknown = new Error("no attempt ran");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.shouldStop?.()) {
      return { ok: false, error: lastError, terminal: true, attempts: attempt - 1 };
    }
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      lastError = err;
      if (opts.isTerminal?.(err)) {
        return { ok: false, error: err, terminal: true, attempts: attempt };
      }
      if (attempt === attempts) {
        return { ok: false, error: err, terminal: true, attempts: attempt };
      }
      // 50–100% jitter so N lanes that all hit the same flaky endpoint don't
      // retry in lockstep (same shape as the vault engine's reconnect backoff).
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await sleep(backoff * (0.5 + 0.5 * random()));
    }
  }
  return { ok: false, error: lastError, terminal: true, attempts };
}
