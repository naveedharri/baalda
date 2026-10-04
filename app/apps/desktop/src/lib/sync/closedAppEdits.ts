/**
 * Closed-app edits (#284).
 *
 * A mapped note edited on disk while the app was shut (a script, an AI agent)
 * produced no watcher event, so nothing pushed it: it went up only when someone
 * opened it. At launch, once the session is LIVE (vault channel `synced` + one
 * completed pull), this pass asks the Rust index which mapped notes have a file
 * hash (`notes.sha256`, refreshed by the open-time rebuild) that differs from
 * their recorded disk base (`yjs_disk_base`: the bytes this device and the CRDT
 * last agreed on). Those notes join the SAME queue a running app's watcher feeds
 * (`localChanges` → `runLocalChangePush`: `force` + `ingestFromFile`, batched
 * above `BULK_THRESHOLD_DOCS`), so the file is diff-merged into the local CRDT,
 * which still holds the last synced state, and pushed. Records of `ackedSv` and
 * `diskBase` happen on that path exactly as for a live edit.
 *
 * Fed in chunks: each chunk waits for the drain that carries it, so a vault an
 * agent rewrote overnight never promotes thousands of CRDTs at once.
 *
 * Never pushes what cannot or need not go up, so it can never cause a read-only
 * rejection (and its recovery copy + reconcile entry) on its own:
 *  - a note under a lock or the vault's Read-only posture (the editor's own
 *    padlock source) is skipped, and so is one the server's resolver says this
 *    user cannot edit (the same per-doc answer the editor's read-only mode uses);
 *    an unanswered check counts as "cannot edit";
 *  - a note whose file text already equals its local CRDT text is skipped and
 *    its disk base re-recorded, so a stale base alone never triggers a push.
 * This pass itself writes no recovery copy and records no reconcile entry.
 *
 * Pure and dependency-injected so it runs under vitest.
 */

/** sha256 of zero bytes. A 0-byte file never clears a populated doc. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Per-doc permission + text checks in flight at once. */
const CHECK_CONCURRENCY = 6;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Notes handed to one drain. */
export const CLOSED_EDIT_CHUNK = 50;

export interface DiskDrift {
  docId: string;
  path: string;
  sha256: string;
}

export interface ClosedAppEditsDeps {
  /** Vault channel synced AND one pull completed. */
  isLive: () => boolean;
  /** The pass's vault is still the open one. */
  isCurrent: () => boolean;
  mappedNotes: () => Array<{ docId: string; relPath: string }>;
  /** Mapped notes whose indexed hash differs from their disk base. */
  listDrift: (entries: Array<{ docId: string; path: string }>) => Promise<DiskDrift[]>;
  /** The note open in the editor: its bridge already ingests the file. */
  openDocId: () => string | null;
  /** Refused for good this session (e.g. over `MAX_NOTE_BYTES`). */
  isPermanentFailure: (docId: string) => boolean;
  /** Current mapping, so a note renamed since the listing is pushed at its path. */
  pathForDocId: (docId: string) => string | null;
  /**
   * The editor's lock view (locks + vault Read-only posture, minus lifts),
   * fetched fresh. A throw aborts the pass: no answer means push nothing.
   */
  readOnlyPaths?: () => Promise<(relPath: string) => boolean>;
  /** The server's per-doc answer: may this user edit it? A throw counts as no. */
  canEdit: (docId: string) => Promise<boolean>;
  /** The local CRDT text, or null when this device holds no CRDT for it. */
  docText: (docId: string) => Promise<string | null>;
  /** The file's current text, or null when it cannot be read. */
  fileText: (relPath: string) => Promise<string | null>;
  /** File and CRDT already agree: record the file's hash as the disk base. */
  recordBase: (docId: string, sha256: string) => Promise<void>;
  /** Put a chunk on the local-change queue and arm its drain. */
  enqueue: (chunk: Array<{ docId: string; relPath: string }>) => void;
  /** Resolves when the drain that carries the last enqueue has run. */
  waitForDrain: () => Promise<void>;
  chunkSize?: number;
  log?: (message: string) => void;
}

export interface ClosedAppEditsResult {
  /** Notes whose file left their disk base. */
  drifted: number;
  /** Of those, queued for ingest + push. */
  queued: number;
  /** Skipped: 0-byte file, the open note, a permanent failure, or unmapped. */
  skipped: number;
  /** Skipped because this user cannot edit the note. */
  readOnly: number;
  /** Skipped because the file already equals the local CRDT (base re-recorded),
   *  or because there is no local CRDT to merge into. */
  converged: number;
  chunks: number;
}

/** Which drifted notes to push, in listing order. */
export function planClosedAppEdits(
  drift: DiskDrift[],
  deps: Pick<ClosedAppEditsDeps, "openDocId" | "isPermanentFailure" | "pathForDocId">,
): { push: Array<{ docId: string; relPath: string }>; skipped: number } {
  const open = deps.openDocId();
  const push: Array<{ docId: string; relPath: string }> = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const d of drift) {
    if (seen.has(d.docId)) continue;
    seen.add(d.docId);
    const relPath = deps.pathForDocId(d.docId);
    if (
      relPath == null ||
      d.sha256 === EMPTY_SHA256 ||
      d.docId === open ||
      deps.isPermanentFailure(d.docId)
    ) {
      skipped++;
      continue;
    }
    push.push({ docId: d.docId, relPath });
  }
  return { push, skipped };
}

export async function runClosedAppEdits(deps: ClosedAppEditsDeps): Promise<ClosedAppEditsResult | null> {
  if (!deps.isLive() || !deps.isCurrent()) return null;
  const mapped = deps.mappedNotes();
  const none: ClosedAppEditsResult = { drifted: 0, queued: 0, skipped: 0, readOnly: 0, converged: 0, chunks: 0 };
  if (mapped.length === 0) return none;
  const drift = await deps.listDrift(mapped.map((n) => ({ docId: n.docId, path: n.relPath })));
  if (!deps.isCurrent()) return null;
  if (drift.length === 0) return none;
  const planned = planClosedAppEdits(drift, deps);
  let skipped = planned.skipped;
  let readOnly = 0;
  // The lock view first: it costs one request for the whole vault.
  let lockedPath: (relPath: string) => boolean = () => false;
  if (deps.readOnlyPaths) {
    try {
      lockedPath = await deps.readOnlyPaths();
    } catch (e) {
      deps.log?.(`closed-app edits: could not read locks, pushing nothing (${String(e)})`);
      return null;
    }
    if (!deps.isCurrent()) return null;
  }
  const push = planned.push.filter((n) => {
    if (!lockedPath(n.relPath)) return true;
    readOnly++;
    return false;
  });
  const shaOf = new Map(drift.map((d) => [d.docId, d.sha256]));
  deps.log?.(
    `${drift.length} ${drift.length === 1 ? "note" : "notes"} changed on disk while Baalda was closed; checking ${push.length}`,
  );
  const size = Math.max(1, deps.chunkSize ?? CLOSED_EDIT_CHUNK);
  let chunks = 0;
  let queued = 0;
  let converged = 0;
  for (let i = 0; i < push.length; i += size) {
    if (!deps.isCurrent()) break;
    // Re-check the open note per chunk: the user may have opened one meanwhile.
    const open = deps.openDocId();
    const candidates = push.slice(i, i + size).filter((n) => n.docId !== open);
    const verdicts = await mapLimit(
      candidates,
      CHECK_CONCURRENCY,
      async (n): Promise<"push" | "readOnly" | "converged"> => {
        let editable = false;
        try {
          editable = await deps.canEdit(n.docId);
        } catch {
          editable = false;
        }
        if (!editable) return "readOnly";
        const [doc, file] = await Promise.all([
          deps.docText(n.docId).catch(() => null),
          deps.fileText(n.relPath).catch(() => null),
        ]);
        // No local CRDT: no common base to merge against. Opening the note
        // reconciles it (hydrate + pull-first), which is the safe order.
        if (doc == null || file == null) return "converged";
        if (doc === file) {
          const sha = shaOf.get(n.docId);
          if (sha) await deps.recordBase(n.docId, sha).catch(() => {});
          return "converged";
        }
        return "push";
      },
    );
    if (!deps.isCurrent()) break;
    const chunk = candidates.filter((_, k) => verdicts[k] === "push");
    readOnly += verdicts.filter((v) => v === "readOnly").length;
    converged += verdicts.filter((v) => v === "converged").length;
    skipped += push.slice(i, i + size).length - candidates.length;
    if (chunk.length === 0) continue;
    deps.enqueue(chunk);
    queued += chunk.length;
    chunks++;
    await deps.waitForDrain();
  }
  return { drifted: drift.length, queued, skipped, readOnly, converged, chunks };
}
