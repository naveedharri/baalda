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
  | "folderKept" // D8: teammate deleted a folder but B's new notes inside it kept it alive
  | "externalEditSaved"; // another app edited a never-opened note offline; the server's text won, the file went to trash (detail = trash path)

export interface ReconcileItem {
  kind: ReconcileKind;
  docId?: string;
  path: string;
  newPath?: string;
  detail?: string;
  at: number;
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
  record(item: Omit<ReconcileItem, "at">): void;
  items(): ReconcileItem[];
  drain(): ReconcileItem[];
  subscribe(cb: ReconcileListener): () => void;
  clear(): void;
} = {
  record(item) {
    all.push({ ...item, at: Date.now() });
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
};
