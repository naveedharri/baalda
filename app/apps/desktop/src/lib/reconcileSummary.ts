/**
 * Plain-words summary of what sync did on reconnect (`sync/reconcileReport.ts`).
 *
 * Pure: the banner and Vault Health both render from these, and the tests pin
 * the wording. One line per kind, in a fixed order that puts the ones where the
 * user's own work moved somewhere first.
 */
import type { ReconcileItem, ReconcileKind } from "./sync/reconcileReport";
import { READ_ONLY_DETAIL } from "./sync/readOnlyRejections";

export const RECONCILE_KIND_ORDER: readonly ReconcileKind[] = [
  "deletedByTeammate",
  "keptLocally",
  "externalEditSaved",
  "restoredFromServer",
  "renamedConflict",
  "folderKept",
];

/** Short label for a kind, used in the Health list's first column. */
export const RECONCILE_KIND_LABEL: Record<ReconcileKind, string> = {
  deletedByTeammate: "Deleted by a teammate",
  keptLocally: "Kept on this device",
  restoredFromServer: "Restored",
  renamedConflict: "Renamed",
  folderKept: "Folder kept",
  externalEditSaved: "Saved to trash",
};

export interface ReconcileLine {
  kind: ReconcileKind;
  count: number;
  text: string;
}

function notes(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "note" : "notes"}`;
}

/** The last path segment, so a line names a file rather than a long path. */
function base(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Collapse repeats of the same (kind, doc or path): a retry that records the
 *  same outcome twice must not double a count. Keeps the latest record. */
export function dedupeReconcileItems(items: readonly ReconcileItem[]): ReconcileItem[] {
  const byKey = new Map<string, ReconcileItem>();
  for (const it of items) {
    const key = `${it.kind}\u0000${it.docId ?? it.path}`;
    byKey.delete(key);
    byKey.set(key, it);
  }
  return [...byKey.values()];
}

function lineFor(kind: ReconcileKind, group: ReconcileItem[]): string {
  const n = group.length;
  const one = n === 1;
  switch (kind) {
    case "deletedByTeammate":
      return `${notes(n)} you edited offline ${one ? "was" : "were"} deleted by a teammate. Your ${one ? "version is" : "versions are"} in Trash.`;
    case "restoredFromServer":
      return `${notes(n)} you removed while offline ${one ? "was" : "were"} restored. Delete ${one ? "it" : "them"} again to remove ${one ? "it" : "them"} for everyone.`;
    case "renamedConflict": {
      if (one) {
        const it = group[0];
        return `1 note was renamed to avoid a clash: ${base(it.path)} → ${base(it.newPath ?? it.path)}.`;
      }
      return `${notes(n)} were renamed to avoid a clash with a teammate's note.`;
    }
    case "keptLocally": {
      // Two causes share this kind: access removed (D7), and a read-only note
      // whose edit the server refused. The wording must not claim lost access
      // for the second — the user can still read the note.
      const ro = group.filter((it) => it.detail === READ_ONLY_DETAIL).length;
      if (ro === 0) {
        return `${notes(n)} ${one ? "is" : "are"} kept on this device only: you no longer have access.`;
      }
      if (ro === n) {
        return `${notes(n)} ${one ? "is" : "are"} read-only for you, so your ${one ? "edit was" : "edits were"} not accepted. A copy is in .context/trash.`;
      }
      return `${notes(n)} ${one ? "is" : "are"} kept on this device only: you no longer have access, or can only read ${one ? "it" : "them"}. Copies are in .context/trash.`;
    }
    case "externalEditSaved":
      return `${notes(n)} changed by another app while you were offline could not be merged. Your ${one ? "version was" : "versions were"} saved to .context/trash.`;
    case "folderKept":
      return one
        ? `Folder ${base(group[0].path)} was kept because you added notes to it.`
        : `${n.toLocaleString()} folders were kept because you added notes to them.`;
  }
}

/** One line per kind present, in {@link RECONCILE_KIND_ORDER}. */
export function summarizeReconcile(items: readonly ReconcileItem[]): ReconcileLine[] {
  const groups = new Map<ReconcileKind, ReconcileItem[]>();
  for (const it of dedupeReconcileItems(items)) {
    const g = groups.get(it.kind);
    if (g) g.push(it);
    else groups.set(it.kind, [it]);
  }
  const out: ReconcileLine[] = [];
  for (const kind of RECONCILE_KIND_ORDER) {
    const g = groups.get(kind);
    if (g && g.length > 0) out.push({ kind, count: g.length, text: lineFor(kind, g) });
  }
  return out;
}
