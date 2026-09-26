/* The right panel's Activity feed: ONE chronological list merged from three
   sources, newest first.
   - reconcile items (this session's reconnect report, deduped),
   - server-Trash notes (a synced vault's soft-deleted notes),
   - local recovery copies in .context/trash NOT already named by a reconcile
     row (those carry their copy's actions on the reconcile row itself).
   Pure, so the merge and the de-duplication are tested without a DOM. */
import type { TrashItem } from "../lib/api";
import type { TrashCopy } from "../lib/ipc";
import type { ReconcileItem } from "../lib/sync/reconcileReport";
import { RECONCILE_KIND_LABEL, dedupeReconcileItems } from "../lib/reconcileSummary";
import { reconcileCopyRef, stampTime } from "./recoveryCopies";

export type ActivityRow =
  | { type: "reconcile"; key: string; at: number; label: string; path: string; item: ReconcileItem }
  | { type: "trash"; key: string; at: number; label: string; path: string; item: TrashItem }
  | { type: "copy"; key: string; at: number; label: string; path: string; copy: TrashCopy };

/** Row tooltips: the short explanations the old section descriptions gave. */
export const ACTIVITY_HINT = {
  reconcile: "What sync changed for you after being offline, since Baalda launched.",
  trash: "Deleted on the server. It stays in Trash until purged; Restore brings it back for everyone.",
  copy: "Local text sync set aside on this device, in .context/trash. It never syncs.",
} as const;

const copyId = (stamp: string, relPath: string) => `${stamp}/${relPath}`;

export function buildActivity(input: {
  reconcile: readonly ReconcileItem[];
  trash: readonly TrashItem[];
  copies: readonly TrashCopy[];
}): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const claimed = new Set<string>();
  for (const it of dedupeReconcileItems(input.reconcile)) {
    const ref = reconcileCopyRef(it);
    if (ref) claimed.add(copyId(ref.stamp, ref.relPath));
    rows.push({
      type: "reconcile",
      key: `r:${it.kind}:${it.docId ?? it.path}`,
      at: it.at,
      label: RECONCILE_KIND_LABEL[it.kind],
      path: it.path,
      item: it,
    });
  }
  for (const t of input.trash) {
    const at = Date.parse(t.deletedAt);
    rows.push({
      type: "trash",
      key: `t:${t.docId}`,
      at: Number.isFinite(at) ? at : 0,
      label: "Deleted",
      path: t.relPath,
      item: t,
    });
  }
  for (const c of input.copies) {
    if (claimed.has(copyId(c.stamp, c.relPath))) continue;
    rows.push({
      type: "copy",
      key: `c:${copyId(c.stamp, c.relPath)}`,
      at: stampTime(c.stamp) ?? c.modified,
      label: "Copy",
      path: c.relPath,
      copy: c,
    });
  }
  // Newest first; ties by key so the order is stable across refreshes.
  rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  return rows;
}
