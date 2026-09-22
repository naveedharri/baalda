import * as Y from "yjs";
import type { LocalTransactionOrigin, Server } from "@hocuspocus/server";
import { formatDocName } from "./doc-name.js";
import type { SyncContext } from "./hocuspocus.js";
import { appendUpdate, compareStateVectors, loadDocState } from "../yjs/persistence.js";
import { indexDoc, scheduleIndex } from "../index/indexer.js";

/**
 * The server-side CRDT write path, shared by the MCP tools (`mcp/doc-writer.ts`)
 * and the bulk `POST /vaults/:id/docs/batch` route.
 *
 * Both do the same two things in the same order — take the doc's write lock,
 * then either mutate the LIVE Hocuspocus document (so the change persists,
 * re-indexes and fans out to every open editor exactly like a human edit) or, if
 * nobody has it open, hydrate a detached `Y.Doc`, apply, and persist the single
 * incremental update ourselves. Having two copies of that would be fine right up
 * until one of them lost the subtlety at `applyDetached`'s observer registration
 * (below), which is the difference between persisting one edit and persisting
 * the whole note's history as a "change".
 *
 * `content` matches the desktop bridge and the indexer's CONTENT_FIELD.
 */

const CONTENT_FIELD = "content";

/** Transaction origin tag for a bulk push. Distinct from `mcp` so `onChange`'s
 *  attribution and any future origin-based filter can tell them apart. */
export const BULK_ORIGIN = "bulk";

/**
 * Origin tag for a bulk **seed** — a `docs/batch` item the server accepted under
 * `expectEmpty`, i.e. one whose doc provably held NO text immediately before the
 * write (re-checked under the per-doc lock, on both the live and the detached
 * path).
 *
 * Split out from {@link BULK_ORIGIN} because "came in through the batch route"
 * and "has no prior state" stopped being the same thing: the desktop now routes
 * its LIVE local-change drain through the same endpoint once enough notes
 * changed at once, with `expectEmpty: false` — a real diff-merge into docs that
 * already hold server state. Only a seed may skip version capture
 * (`versions/capture.ts NO_VERSION_SOURCES`); a merge captures exactly like a
 * single Hocuspocus write, however many notes a tool touched in one go.
 */
export const BULK_SEED_ORIGIN = "bulk-seed";

/** Who is behind a server-side write, for attribution (versions, last-edited). */
export interface DocActor {
  userId?: string | null;
  /**
   * Where the write came from — {@link BULK_ORIGIN} for a `docs/batch` push,
   * `mcp` for a tool call, absent for anything else.
   *
   * Carried so the version machinery can tell a person typing from a client
   * uploading a file it already has: a bulk SEED ({@link BULK_SEED_ORIGIN}) arms
   * no idle-capture timer, because a doc that just received its first copy of
   * its own `.md` has no PRIOR state worth versioning and 5,000 of those armed
   * 5,000 ten-minute timers that all fired at once. A non-seed bulk write
   * ({@link BULK_ORIGIN}) is an ordinary merge and versions like any other edit.
   * Attribution (`last_edited_by`) is unchanged either way.
   */
  source?: string | null;
}

/**
 * Called after a DETACHED write (no client connected), with the writer's
 * identity. The live path needs no equivalent: it goes through Hocuspocus, whose
 * `onChange` already reports the editor via the transaction origin's context.
 */
export type DocWrittenHook = (
  vaultId: string,
  docId: string,
  userId: string | null,
  source?: string | null,
) => void;

/**
 * Publishes a doc update to background vault subscribers — the same fan-out the
 * sync server's `onChange` performs for a live document.
 *
 * The detached path needs this explicitly: it deliberately never touches
 * Hocuspocus, so without it an edit to a note nobody has open is persisted
 * correctly and announced to no one.
 *
 * Returns `void | Promise<void>` so the contract itself is safe: the real
 * publisher fans out over pub/sub and can REJECT (a Redis blip), and a rejection
 * nobody awaits is an unhandled rejection. Declaring the promise here means
 * `applyDetached` awaits and swallows it once, for every injection site.
 */
export type DocUpdatePublisher = (
  vaultId: string,
  docId: string,
  update: Uint8Array,
) => void | Promise<void>;

export interface DetachedHooks {
  publishUpdate?: DocUpdatePublisher;
  onDocWritten?: DocWrittenHook;
}

// ── per-doc write lock ─────────────────────────────────────────────────────

/**
 * Per-doc write serialisation, process-wide.
 *
 * The detached path awaits between reading the stored state and appending its
 * update, so two concurrent writes to one note each hydrate the SAME state and
 * each apply a whole-body delete+insert — Yjs merges both inserts and the note
 * holds the text twice (#78's "duplicated" outcome). Chaining per docId makes
 * the second write see the first's result, which is also what makes a
 * precondition — a revision check for MCP, `expectEmpty` for a bulk push — mean
 * anything at all: check and apply are one atomic step only because of this.
 *
 * Module-level rather than per-writer deliberately. An MCP `update_note` and a
 * bulk push can target the same doc in the same second, and a lock each would
 * serialise neither against the other. Self-cleaning: an entry is removed once
 * its chain settles.
 */
const locks = new Map<string, Promise<unknown>>();

export async function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(docId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(docId, chain);
  try {
    return await run;
  } finally {
    if (locks.get(docId) === chain) locks.delete(docId);
  }
}

// ── the detached apply ─────────────────────────────────────────────────────

/** What one apply did. `skipped` means the merge captured NO update — the store
 *  already held every op, which is the idempotency proof a retried push rides
 *  on. `conflict` means the precondition failed and nothing was written. */
export type ApplyOutcome = "applied" | "skipped" | "conflict";

export interface DetachedOptions {
  hooks?: DetachedHooks;
  /**
   * Checked AFTER hydration and BEFORE `mutate`, under the caller's lock.
   * Returning false aborts with `conflict` and writes nothing.
   */
  precondition?: (doc: Y.Doc) => boolean;
  /**
   * Hand the re-index to the debounced queue instead of awaiting it here.
   *
   * The bulk push path sets this. Awaiting `indexDoc` inline costs a SECOND
   * full `loadDocState` (another pool checkout, another REPEATABLE READ
   * transaction, another `Y.mergeUpdates`, another `Y.Doc`) plus a synchronous
   * `embed()` and one INSERT per wikilink — per doc, on the request's event
   * loop, which is why other clients' sync stalled during an import. The LIVE
   * Hocuspocus write path has always used `scheduleIndex` (`hocuspocus.ts`
   * onChange); this makes the two write paths consistent rather than divergent.
   *
   * Search is then eventually consistent for a batch push — a test that needs a
   * quiet point calls `flushIndexQueue()`. MCP writes deliberately keep the
   * inline await: a tool that writes and then searches must see its own write.
   */
  deferIndex?: boolean;
}

/**
 * Hydrate a detached `Y.Doc` from storage, run `mutate`, persist whatever the
 * mutation produced, and announce it.
 *
 * The one thing to preserve if this is ever rewritten: the update observer is
 * registered **after** hydration. Register it before, and `Y.applyUpdate(doc,
 * state)` fires it too — so the "incremental update" appended to the log is the
 * entire doc, on every write, and the log grows quadratically until compaction
 * cannot keep up.
 *
 * The caller owns the lock (`withDocLock`). This function takes none, because a
 * precondition has to be evaluated inside the SAME critical section as the
 * write, and only the caller knows where that section begins.
 */
export async function applyDetached(
  vaultId: string,
  docId: string,
  mutate: (doc: Y.Doc) => void,
  actor?: DocActor,
  opts: DetachedOptions = {},
): Promise<ApplyOutcome> {
  const userId = actor?.userId ?? null;
  const state = await loadDocState(docId);
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  const capture = (u: Uint8Array) => updates.push(u);
  try {
    if (state) Y.applyUpdate(doc, state);
    if (opts.precondition && !opts.precondition(doc)) return "conflict";
    // Register AFTER hydration so we capture only our own edit.
    doc.on("update", capture);
    try {
      mutate(doc);
    } finally {
      doc.off("update", capture);
    }
    if (updates.length === 0) return "skipped";
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    await appendUpdate(docId, merged);
    // Fan out to background subscribers, which the live path gets free from
    // Hocuspocus's onChange. Best-effort like the re-index: the write is already
    // durable, and failing it here would turn a delivery problem into a lost
    // edit. `await` inside the try so this covers BOTH failure shapes — a
    // synchronous throw AND a rejected promise.
    try {
      await opts.hooks?.publishUpdate?.(vaultId, docId, merged);
    } catch (err) {
      console.warn(`[doc-batch] failed to publish update for ${docId}`, err);
    }
    // Keep search/graph in sync (best-effort; never fail the write on it).
    if (opts.deferIndex) scheduleIndex(docId);
    else await indexDoc(docId).catch(() => {});
    // Attribution + version capture, the detached counterpart of the sync
    // server's `onDocEdited`.
    try {
      opts.hooks?.onDocWritten?.(vaultId, docId, userId, actor?.source ?? null);
    } catch (err) {
      console.warn(`[doc-batch] onDocWritten hook failed for ${docId}`, err);
    }
    return "applied";
  } finally {
    doc.destroy();
  }
}

// ── the bulk applier ───────────────────────────────────────────────────────

/**
 * What the batch applier needs from the running process: the Hocuspocus server
 * (to find a LIVE doc) and the detached path's hooks.
 *
 * Registered by `createDocWriter`, which is the one place that already holds all
 * three, rather than threaded through `AppDeps`. There is exactly one sync
 * server per process — the same assumption `sync/hocuspocus.ts` and the MCP
 * writer already make — so a module-level binding is the honest shape, and it
 * keeps the HTTP layer from having to know that a batch push and an MCP write
 * are the same machine. Unset (a unit test that built an app with a memory
 * writer) simply means no live docs and no fan-out: the detached path still
 * persists correctly.
 */
export interface DocBatchRuntime {
  server: Server<SyncContext>;
  hooks: DetachedHooks;
}

let runtime: DocBatchRuntime | null = null;

export function setDocBatchRuntime(next: DocBatchRuntime | null): void {
  runtime = next;
}

export function docBatchRuntime(): DocBatchRuntime | null {
  return runtime;
}

/**
 * Whether the server already covers a submitted update without applying it.
 *
 * State vectors alone are insufficient for this question: Yjs deletions live
 * in the update's delete set and do not advance a client's struct clock. An
 * older update can therefore have the exact same state vector as the server
 * while rendering different text. Decode both states and compare the canonical
 * `content` text as well as proving the client has no structs the server lacks.
 *
 * Prefer the live Hocuspocus document when one is open. Its latest transactions
 * may not have reached detached persistence yet, and acknowledging an older
 * submission against that stale store would falsely settle the client.
 */
export async function serverDocCoversUpdate(
  vaultId: string,
  docId: string,
  update: Uint8Array,
): Promise<boolean> {
  return withDocLock(docId, async () => {
    const submitted = new Y.Doc();
    const canonical = new Y.Doc();
    try {
      Y.applyUpdate(submitted, update);
      const live = runtime?.server.hocuspocus.documents.get(formatDocName(vaultId, docId));
      const state = live ? Y.encodeStateAsUpdate(live) : await loadDocState(docId);
      if (!state) return false;
      Y.applyUpdate(canonical, state);

      const relation = compareStateVectors(
        Y.encodeStateVector(submitted),
        Y.encodeStateVector(canonical),
      );
      return (
        !relation.clientAhead &&
        submitted.getText(CONTENT_FIELD).toString() ===
          canonical.getText(CONTENT_FIELD).toString()
      );
    } finally {
      submitted.destroy();
      canonical.destroy();
    }
  });
}

/** One doc's push, already decoded and already permitted. */
export interface DocApplyItem {
  docId: string;
  update: Uint8Array;
  /**
   * The client seeded this update from its local FILE because the server said
   * the doc was empty. Re-checked here, under the lock: if the stored state now
   * has content, the answer is `conflict` and nothing is applied. Without it a
   * slow client would paste a stale file over a teammate's live text.
   */
  expectEmpty?: boolean;
}

export interface DocApplyResult {
  docId: string;
  outcome: ApplyOutcome | "error";
  error?: string;
}

/** Is a doc's shared text empty? The one question `expectEmpty` asks, asked the
 *  same way on both paths so they cannot disagree. */
function isEmpty(doc: Y.Doc): boolean {
  return doc.getText(CONTENT_FIELD).length === 0;
}

/**
 * Apply ONE doc's update. Live document first — a bulk push then lands in every
 * open editor the same second, exactly like a teammate's keystroke — else
 * detached.
 *
 * Serialised per doc against MCP writes and against other pushes to the same
 * doc, which is what makes `expectEmpty` a real precondition rather than a
 * hopeful one.
 */
export async function applyDocPush(
  vaultId: string,
  item: DocApplyItem,
  actor?: DocActor,
): Promise<DocApplyResult> {
  const { docId, update, expectEmpty } = item;
  // A SEED is precisely the `expectEmpty` case, and that claim is re-checked
  // below inside the lock (live: the text must still be empty; detached: the
  // `isEmpty` precondition) — so if this write lands at all, the doc held no
  // text before it. Everything else through this route is a merge into prior
  // state and must version like a single live write. See {@link BULK_SEED_ORIGIN}.
  const source = expectEmpty ? BULK_SEED_ORIGIN : BULK_ORIGIN;
  try {
    const outcome = await withDocLock(docId, async () => {
      const live = runtime?.server.hocuspocus.documents.get(formatDocName(vaultId, docId));
      if (live) {
        if (expectEmpty && live.getText(CONTENT_FIELD).length > 0) return "conflict" as const;
        // The origin is a Hocuspocus `LocalTransactionOrigin` object rather than
        // a bare string, because that is the ONLY channel carrying an identity
        // into `onChange`: Hocuspocus resolves `origin.source === "local" ?
        // origin.context : {}`, so a string origin is permanently anonymous.
        const origin: LocalTransactionOrigin = {
          source: "local",
          context: { source, userId: actor?.userId ?? null },
        };
        const captured: Uint8Array[] = [];
        const capture = (u: Uint8Array) => captured.push(u);
        live.on("update", capture);
        try {
          // Synchronous, so no foreign transaction can interleave between the
          // observer going on and coming off.
          Y.applyUpdate(live, update, origin);
        } finally {
          live.off("update", capture);
        }
        return captured.length === 0 ? ("skipped" as const) : ("applied" as const);
      }
      return applyDetached(
        vaultId,
        docId,
        (doc) => Y.applyUpdate(doc, update, BULK_ORIGIN),
        { ...actor, source },
        {
          hooks: runtime?.hooks,
          precondition: expectEmpty ? isEmpty : undefined,
          // See `DetachedOptions.deferIndex`: a 100-doc batch must not do a
          // second CRDT load + merge + synchronous embed per doc inline.
          deferIndex: true,
        },
      );
    });
    return { docId, outcome };
  } catch (err) {
    // Per item, never fatal to the batch: one malformed update must not cost the
    // other 99 docs their pass, and the client retries by doc id.
    return { docId, outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apply a batch, one doc at a time.
 *
 * Deliberately sequential. Each item takes a per-doc lock and does a
 * `loadDocState` (one pooled connection in a REPEATABLE READ transaction) plus
 * an `appendUpdate` that may trigger a `compact()`; running 100 of those at once
 * would hold most of `PG_POOL_MAX` for one request while the vault channel's
 * backfill is competing for the same pool. The win here was never per-item
 * latency — it was deleting 100 HTTP round trips and 100 WebSocket handshakes.
 */
export async function applyDocPushBatch(
  vaultId: string,
  items: DocApplyItem[],
  actor?: DocActor,
): Promise<DocApplyResult[]> {
  const out: DocApplyResult[] = [];
  for (const item of items) out.push(await applyDocPush(vaultId, item, actor));
  return out;
}
