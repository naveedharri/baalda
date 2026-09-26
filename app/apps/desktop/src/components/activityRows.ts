/* The right panel's Activity feed: ONE chronological list merged from three
   sources, newest first.
   - reconcile items (this session's reconnect report, deduped),
   - server-Trash notes (a synced vault's soft-deleted notes),
   - local recovery copies in .context/trash NOT already named by a reconcile
     row (those carry their copy's actions on the reconcile row itself),
   - a held bulk delete (the #221 banner's question, also asked here),
   - server `pre-shrink` captures (a note that lost most of its text),
   - this session's access changes,
   - the sync failures Health lists under Needs attention.
   Pure, so the merge and the de-duplication are tested without a DOM. */
import type { ShrinkEvent, TrashItem } from "../lib/api";
import type { HealthFailures } from "../lib/health/model";
import type { AccessEvent } from "../store";
import type { TrashCopy } from "../lib/ipc";
import type { ReconcileItem } from "../lib/sync/reconcileReport";
import { RECONCILE_KIND_LABEL, dedupeReconcileItems } from "../lib/reconcileSummary";
import { reconcileCopyRef, stampTime } from "./recoveryCopies";

export type ActivityRow =
  | { type: "reconcile"; key: string; at: number; label: string; path: string; item: ReconcileItem }
  | { type: "trash"; key: string; at: number; label: string; path: string; item: TrashItem }
  | { type: "copy"; key: string; at: number; label: string; path: string; copy: TrashCopy }
  | { type: "held"; key: string; at: number; label: string; path: string; count: number; text: string }
  | { type: "shrunk"; key: string; at: number; label: string; path: string; event: ShrinkEvent; text: string }
  | { type: "access"; key: string; at: number; label: string; path: string; event: AccessEvent; text: string }
  | { type: "failed"; key: string; at: number; label: string; path: string; failure: FailedEntry; text: string };

/** One Needs-attention failure, flattened from `syncManager.syncFailures()`. */
export interface FailedEntry {
  key: string;
  docId: string | null;
  path: string;
  reason: string;
  /** `syncManager.retryDoc` can help: a doc id, and not a permanent refusal. */
  retryable: boolean;
}

/** Flatten the failures Health's Needs attention is built from. The held
 *  bulk delete's per-note entries are left out: the Held row asks that. */
export function failureEntries(f: HealthFailures | null | undefined): FailedEntry[] {
  if (!f) return [];
  const out: FailedEntry[] = [];
  for (const c of f.content) {
    out.push({
      key: `fc:${c.docId}`,
      docId: c.docId,
      path: c.relPath,
      reason: c.reason,
      retryable: !c.permanent,
    });
  }
  for (const r of f.registry) {
    if (r.kind === "inbound-blocked" && r.code === "delete_decision") continue;
    out.push({
      key: `fr:${r.kind}:${r.docId ?? r.path}`,
      docId: r.docId,
      path: r.path,
      reason: r.reason,
      retryable: r.docId != null,
    });
  }
  return out;
}

const n = (x: number) => x.toLocaleString("en-US");

export function shrinkText(e: Pick<ShrinkEvent, "beforeChars" | "afterChars">): string {
  return `went from ${n(e.beforeChars)} to ${n(e.afterChars)} characters`;
}

export function heldText(count: number): string {
  return `${n(count)} ${count === 1 ? "note" : "notes"} vanished from disk at once`;
}

export function accessText(e: AccessEvent): string {
  if (e.kind === "removed") return "Access to this note was removed";
  return `${n(e.count)} ${e.count === 1 ? "note" : "notes"} became available to you`;
}

/** Row tooltips: the short explanations the old section descriptions gave. */
export const ACTIVITY_HINT = {
  reconcile: "What sync changed for you after being offline, since Baalda launched.",
  trash: "Deleted on the server. It stays in Trash until purged; Restore brings it back for everyone.",
  copy: "Local text sync set aside on this device, in .context/trash. It never syncs.",
  held: "Many notes disappeared from the vault folder at once. Nothing was deleted for your team until you answer.",
  shrunk: "An edit left at most a fifth of this note. The server kept the text from before it.",
  access: "Someone changed who can see this. Only this app session's changes are listed.",
  failed: "Sync could not finish this item. It is also listed in Vault Health.",
} as const;

const copyId = (stamp: string, relPath: string) => `${stamp}/${relPath}`;

export function buildActivity(input: {
  reconcile: readonly ReconcileItem[];
  trash: readonly TrashItem[];
  copies: readonly TrashCopy[];
  /** The held bulk delete, stamped with when this feed first saw it. */
  held?: { count: number; at: number } | null;
  shrinks?: readonly ShrinkEvent[];
  access?: readonly AccessEvent[];
  /** Failures, each stamped with when this feed first saw it. */
  failures?: readonly (FailedEntry & { at: number })[];
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
  if (input.held && input.held.count > 0) {
    rows.push({
      type: "held",
      key: "h:bulk-delete",
      at: input.held.at,
      label: "Held",
      path: "",
      count: input.held.count,
      text: heldText(input.held.count),
    });
  }
  for (const e of input.shrinks ?? []) {
    const at = Date.parse(e.capturedAt);
    rows.push({
      type: "shrunk",
      key: `s:${e.versionId}`,
      at: Number.isFinite(at) ? at : 0,
      label: "Shrunk",
      path: e.relPath,
      event: e,
      text: shrinkText(e),
    });
  }
  (input.access ?? []).forEach((e, i) => {
    rows.push({
      type: "access",
      key: e.kind === "removed" ? `a:r:${e.docId}:${e.at}` : `a:g:${e.at}:${i}`,
      at: e.at,
      label: "Access",
      path: e.kind === "removed" ? e.path : "",
      event: e,
      text: accessText(e),
    });
  });
  for (const f of input.failures ?? []) {
    rows.push({
      type: "failed",
      key: f.key,
      at: f.at,
      label: "Failed",
      path: f.path,
      failure: f,
      text: f.reason,
    });
  }
  // Newest first; ties by key so the order is stable across refreshes.
  rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  return rows;
}
