// CRDT garbage collection — the half of the index nothing ever cleaned up.
//
// `Index::rebuild` deliberately preserves the CRDT tables: that is what lets a
// rebuild keep unsynced edits. The cost is that nothing removed a doc's rows
// either, so a vault accumulated the Yjs state of every note it had ever held —
// notes deleted, notes renamed into a fresh id, and every doc forked by a past
// path collision. A production vault reached 953 such docs inside a 900 MB
// `index.sqlite`; none of them were reachable from any note on disk.
//
// ── Why the LIVE set, and not a "dead" set ───────────────────────────────────
// Deletion is driven by an allow-list, never a guess. Two independent id spaces
// can key a local CRDT and a caller must supply both:
//
//   1. the registry's server doc ids (`.context/config.json`), and
//   2. the LOCAL index's `notes.id`.
//
// Those are the same value in a vault registered from a fresh index — the open
// path passes the local id so the server adopts it — but they diverge in a vault
// whose index predates its registration, and there the CRDT is keyed by whichever
// id opened the note first. Passing one and not the other would delete live docs,
// so `collectCrdtGarbage` takes both and unions them; Rust additionally refuses an
// EMPTY live set, because "I know of no live docs" is what a caller looks like
// when its map failed to load, not a request to erase the vault.
//
// Runs at most once per vault open, immediately after the registry reconcile and
// before the download phase — the one moment when the registry map is complete
// and no backfill has begun. Anything created afterwards is therefore younger
// than the sweep and cannot be caught by it.

import * as ipc from "../ipc";
import type { VaultEpoch } from "../ipc";

export interface CrdtGcDeps {
  /** Every doc id the registry has mapped (`registry.allDocIds()`). */
  registryDocIds: () => string[];
  /** Every note in the local index — its `id` is the second live id space. */
  localNotes: (epoch?: VaultEpoch) => Promise<Array<{ id: string }>>;
  prune: (live: string[], epoch?: VaultEpoch) => Promise<ipc.YjsPruneReport>;
}

const defaultDeps: CrdtGcDeps = {
  registryDocIds: () => [],
  localNotes: (epoch) => ipc.listNoteTitles(epoch),
  prune: (live, epoch) => ipc.pruneYjsDocs(live, epoch),
};

/**
 * Sweep unreachable CRDT rows and reclaim the file.
 *
 * `pinned` is anything the caller knows is in use but may not be in either id
 * space yet — the open note, a doc mid-upload. Cheap insurance: a few extra ids
 * in the allow-list cost nothing, while one missing id costs a note's unsynced
 * edits.
 *
 * Never throws. This is maintenance: a vault that cannot be tidied must still
 * open, sync, and be edited.
 */
export async function collectCrdtGarbage(
  deps: Partial<CrdtGcDeps> & Pick<CrdtGcDeps, "registryDocIds">,
  opts: { epoch?: VaultEpoch; pinned?: Iterable<string> } = {},
): Promise<ipc.YjsPruneReport | null> {
  const d = { ...defaultDeps, ...deps };
  try {
    const live = new Set<string>(d.registryDocIds());
    for (const n of await d.localNotes(opts.epoch)) live.add(n.id);
    for (const id of opts.pinned ?? []) live.add(id);
    // Belt and braces around the Rust guard: an empty allow-list here means we
    // failed to learn what is live, and pruning against it would be a wipe.
    if (live.size === 0) return null;
    const report = await d.prune([...live], opts.epoch);
    if (report.docsRemoved > 0 || report.updatesRemoved > 0) {
      console.info(
        `[crdt-gc] removed ${report.docsRemoved} dead doc(s), ` +
          `${report.updatesRemoved} update row(s), reclaimed ` +
          `${(report.bytesReclaimed / (1024 * 1024)).toFixed(1)} MB`,
      );
    }
    return report;
  } catch (e) {
    console.warn("[crdt-gc] sweep skipped", e);
    return null;
  }
}
