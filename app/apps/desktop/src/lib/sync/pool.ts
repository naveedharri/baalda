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

/** How many LOCAL (IPC) operations run at once.
 *
 *  8, above {@link REGISTRY_CONCURRENCY}, because a unit here is not an HTTP
 *  request against one host but a call across the Tauri bridge into Rust — a
 *  disk read, a `trashNote`/`deleteFile`, an existence check. The ceiling is
 *  Rust's own file work and its index mutex, not the webview's six connections
 *  per host, so the six that sizes the registry pool just leaves the bridge
 *  idle. Not raised further: past this the calls only queue behind the index
 *  lock, where we can neither see nor cancel them.
 *
 *  One constant rather than the five identical local ones this replaces
 *  (inbound removals, binary existence checks, disk deletes, the two bare
 *  literals in the store and the session), so the number moves in one place. */
export const IPC_CONCURRENCY = 8;

/** How many docs the BATCH pusher packs at once.
 *
 *  8, deliberately higher than {@link UPLOAD_CONCURRENCY}, because the two
 *  pools measure different things. The uploader's unit is a WebSocket plus a
 *  resident `NoteBridge`; the batch pusher opens no socket at all — its unit is
 *  a bridge hydrate (one SQLite read through the IPC bridge) plus a `Y.Doc`
 *  serialize, i.e. work that is latency-bound on the Rust side and finishes in
 *  milliseconds. Sizing it at 4 left the packer waiting on IPC while the one
 *  in-flight `docs/batch` request (the pusher serializes its sends, so at most
 *  ONE request is ever on the wire) had nothing queued behind it.
 *
 *  It is not raised further because peak heap is one bridge per lane plus the
 *  open chunk, and the chunk bounds ({@link BATCH_MAX_DOCS} /
 *  {@link BATCH_MAX_DECODED_BYTES}) are what actually cap the request — a wider
 *  pool past this point only buys memory. */
export const BULK_PACK_CONCURRENCY = 8;

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

// ---- Bulk sync engine thresholds & batch bounds --------------------------
//
// Mirrored (env-overridable) by the server's `src/config.ts`. The client's
// copies are the ones that decide how a request is PACKED; the server's are the
// ones that decide whether it is accepted, so a client that drifts above them
// gets `batch_too_large` rather than silent truncation.

/**
 * At or above this many docs, a bulk path is used instead of the per-doc one.
 *
 * 25, one number for register, push and bootstrap alike:
 *  (1) it is already the vault's durability quantum — `checkpointBatchFor`
 *      floors at 25 — so below it a run is one checkpoint and the resume
 *      machinery buys nothing;
 *  (2) 25 token mints + 25 WS handshakes at width 4 and ~150 ms RTT is ≈2 s
 *      against ONE request; below that the saving is sub-second and not worth a
 *      second, rarely-exercised code path (a rarely-exercised safety path IS
 *      the bug);
 *  (3) the per-request fixed cost (`getSession` + `vaultOrg` + `orgRole`)
 *      amortises to <12 % at 25;
 *  (4) it makes the batch path the COMMON one — every real vault is >25 notes —
 *      so it is exercised constantly.
 *
 * The per-doc `DocSync` path survives only where it is semantically required:
 * the conflict/merge case, the open note, the local-change drain, and items over
 * {@link BULK_ITEM_MAX_BYTES}. Never as a size fallback.
 */
export const BULK_THRESHOLD_DOCS = 25;

/**
 * A single item larger than this leaves the batch for its own `DocSync` socket.
 *
 * A byte budget EXCLUDES, it never triggers: one 3 MB doc must not be allowed to
 * dominate (or blow) a 4 MiB request that a hundred ordinary notes would share.
 * Anything over `MAX_NOTE_BYTES` (contentUpload.ts, = the server's `maxNoteMb`)
 * is a permanent failure as before, and that check still comes first.
 */
export const BULK_ITEM_MAX_BYTES = 1 * 1024 * 1024;

/** Items per `POST /notes/batch` request. */
export const BATCH_MAX_NOTES = 200;
/** Items per `POST /folders/batch` request. */
export const BATCH_MAX_FOLDERS = 500;
/** Items per `POST /files/batch` request. */
export const BATCH_MAX_FILES = 200;
/** Docs per `POST /docs/batch` request. */
export const BATCH_MAX_DOCS = 100;
/** Total DECODED Yjs bytes per `POST /docs/batch` request (4 MiB). */
export const BATCH_MAX_DECODED_BYTES = 4 * 1024 * 1024;

/**
 * Does a run of `count` items take the batch path?
 *
 * One pure function, applied at all three sites (the two reconcile pools and the
 * content run) so the threshold cannot drift between them — and so a test can
 * pin 24 ⇒ per-doc, 25 ⇒ batch without touching the network.
 */
export function useBulkPath(count: number): boolean {
  return count >= BULK_THRESHOLD_DOCS;
}
