/**
 * Offline-reconciliation report: an in-memory, per-app-session list of the
 * things sync did on the user's behalf that they should hear about (a file
 * restored from the server, a teammate's delete that sent their unsent edits
 * to `.context/trash`, a same-path create renamed aside, ...).
 *
 * The sync layer RECORDS; the UI subscribes / drains. Nothing here persists.
 */
export type ReconcileKind =
  | "restoredFromServer" // D5/D8: a file missing locally was re-materialised from the server (B's closed-app delete undone)
  | "deletedByTeammate" // D1: a teammate deleted a note B had unseen edits to; B's version went to trash (local and/or server)
  | "renamedConflict" // D4: same-path create; B's later note renamed to newPath
  | "keptLocally" // D7: access revoked while B had unsent edits; kept under .context/trash, no longer synced
  | "selfRevoked" // D7, but B removed their OWN access from this device moments before; same copy, quiet notice
  | "folderKept" // D8: teammate deleted a folder but B's new notes inside it kept it alive
  | "externalEditSaved"; // another app edited a never-opened note offline; the server's text won, the file went to trash (detail = trash path)

export interface ReconcileItem {
  kind: ReconcileKind;
  docId?: string;
  path: string;
  newPath?: string;
  detail?: string;
  at: number;
  /**
   * Re-recorded from the last session's saved review on vault open, not
   * something sync just did. The review and Activity list it; the banner never
   * announces it again (it already did, the session it happened in).
   */
  seeded?: boolean;
}

export interface ReconcileListener {
  (items: ReconcileItem[]): void;
}

const all: ReconcileItem[] = [];
let drainedUpTo = 0;
const listeners = new Set<ReconcileListener>();

function notify(): void {
  const snapshot = all.slice();
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (e) {
      console.warn("[reconcileReport] listener threw", e);
    }
  }
}

export const reconcileReport: {
  record(item: Omit<ReconcileItem, "at" | "seeded">, opts?: { at?: number; seeded?: boolean }): void;
  items(): ReconcileItem[];
  drain(): ReconcileItem[];
  subscribe(cb: ReconcileListener): () => void;
  clear(): void;
  forgetReadable(docIds: ReadonlySet<string>): number;
} = {
  record(item, opts) {
    // A seeded item keeps the time it HAPPENED: stamping it with now made the
    // same rename look new (unread, bannered) on every launch.
    const at = opts?.at && Number.isFinite(opts.at) && opts.at > 0 ? opts.at : Date.now();
    all.push({ ...item, at, ...(opts?.seeded ? { seeded: true } : {}) });
    notify();
  },
  items() {
    return all.slice();
  },
  drain() {
    const out = all.slice(drainedUpTo);
    drainedUpTo = all.length;
    return out;
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  clear() {
    all.length = 0;
    drainedUpTo = 0;
    notify();
  },
  /**
   * Access came back: drop this session's "you lost this note" entries for
   * docs the server lists as readable again, so the banner shrinks instead of
   * claiming a loss that no longer holds. The recovery copy itself stays in
   * `.context/trash`; only the report line goes. A read-only refusal (the note
   * was readable all along) and items seeded from an earlier session are kept.
   */
  forgetReadable(docIds) {
    if (docIds.size === 0 || all.length === 0) return 0;
    let removed = 0;
    let removedBeforeDrain = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const it = all[i];
      if (!isForgettable(it, docIds)) continue;
      all.splice(i, 1);
      removed++;
      if (i < drainedUpTo) removedBeforeDrain++;
    }
    if (removed === 0) return 0;
    drainedUpTo -= removedBeforeDrain;
    notify();
    return removed;
  },
};

/** Mirrors `READ_ONLY_DETAIL` (readOnlyRejections.ts), inlined to avoid an import cycle. */
const READ_ONLY_PREFIX = "read-only";

function isForgettable(it: ReconcileItem, docIds: ReadonlySet<string>): boolean {
  if (it.seeded || !it.docId || !docIds.has(it.docId)) return false;
  if (it.kind === "deletedByTeammate" || it.kind === "selfRevoked") return true;
  return it.kind === "keptLocally" && !(it.detail ?? "").startsWith(READ_ONLY_PREFIX);
}
