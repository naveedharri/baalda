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
 * Pure and dependency-injected so it runs under vitest.
 */

/** sha256 of zero bytes. A 0-byte file never clears a populated doc. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
  const none: ClosedAppEditsResult = { drifted: 0, queued: 0, skipped: 0, chunks: 0 };
  if (mapped.length === 0) return none;
  const drift = await deps.listDrift(mapped.map((n) => ({ docId: n.docId, path: n.relPath })));
  if (!deps.isCurrent()) return null;
  if (drift.length === 0) return none;
  const { push, skipped } = planClosedAppEdits(drift, deps);
  deps.log?.(
    `${drift.length} ${drift.length === 1 ? "note" : "notes"} changed on disk while Baalda was closed; pushing ${push.length}`,
  );
  const size = Math.max(1, deps.chunkSize ?? CLOSED_EDIT_CHUNK);
  let chunks = 0;
  for (let i = 0; i < push.length; i += size) {
    if (!deps.isCurrent()) break;
    // Re-check the open note per chunk: the user may have opened one meanwhile.
    const open = deps.openDocId();
    const chunk = push.slice(i, i + size).filter((n) => n.docId !== open);
    if (chunk.length === 0) continue;
    deps.enqueue(chunk);
    chunks++;
    await deps.waitForDrain();
  }
  return { drifted: drift.length, queued: push.length, skipped, chunks };
}
