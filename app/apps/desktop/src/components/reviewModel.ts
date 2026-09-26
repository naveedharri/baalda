/* The "Review changes" tab's model: which reconnect-report items can be
   reviewed, their pending/resolved state for this app session, and what
   Resolve all does. Pure data plus a tiny module store beside the report
   (`sync/reconcileReport.ts` records; this only remembers the user's answers). */
import type { ReconcileItem, ReconcileKind } from "../lib/sync/reconcileReport";
import { dedupeReconcileItems } from "../lib/reconcileSummary";
import { reconcileCopyRef, type CopyRef } from "./recoveryCopies";

export type Resolution = "kept" | "restored" | "restoredSibling" | "skipped";

export interface ReviewItem {
  key: string;
  kind: ReconcileKind;
  path: string;
  /** The local copy this item carries, if any. */
  copy: CopyRef | null;
  /** renamedConflict: the other note of the pair. */
  otherPath: string | null;
  at: number;
}

/** Stable across retried records of the same outcome, like the dedupe. */
export function reviewKey(it: Pick<ReconcileItem, "kind" | "docId" | "path">): string {
  return `${it.kind}\u0000${it.docId ?? it.path}`;
}

/**
 * The reviewable items, newest first: every item with a local copy, every
 * clash rename (two sibling notes to compare), and every note restored from the
 * server (shown on its own). Folder notices have nothing to compare.
 */
export function reviewItems(items: readonly ReconcileItem[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const it of dedupeReconcileItems(items)) {
    const copy = reconcileCopyRef(it);
    if (copy) {
      out.push({ key: reviewKey(it), kind: it.kind, path: it.path, copy, otherPath: null, at: it.at });
    } else if (it.kind === "renamedConflict" && it.newPath) {
      out.push({ key: reviewKey(it), kind: it.kind, path: it.path, copy: null, otherPath: it.newPath, at: it.at });
    } else if (it.kind === "restoredFromServer") {
      out.push({ key: reviewKey(it), kind: it.kind, path: it.path, copy: null, otherPath: null, at: it.at });
    }
  }
  return out.reverse();
}

export type ResolvedMap = ReadonlyMap<string, Resolution>;

export function pendingItems(items: readonly ReviewItem[], resolved: ResolvedMap): ReviewItem[] {
  return items.filter((it) => !resolved.has(it.key));
}

export function withResolution(resolved: ResolvedMap, key: string, how: Resolution): Map<string, Resolution> {
  const next = new Map(resolved);
  next.set(key, how);
  return next;
}

/**
 * Resolve all = Keep current for every pending item. Returns the copies that
 * will be deleted (what the confirm dialog counts) and the resulting map.
 * Items without a copy are simply marked kept.
 */
export function planResolveAll(
  items: readonly ReviewItem[],
  resolved: ResolvedMap,
): { copiesToDelete: CopyRef[]; next: Map<string, Resolution> } {
  const next = new Map(resolved);
  const copiesToDelete: CopyRef[] = [];
  for (const it of pendingItems(items, resolved)) {
    if (it.copy) copiesToDelete.push(it.copy);
    next.set(it.key, "kept");
  }
  return { copiesToDelete, next };
}

/** The first pending item after `key` (wrapping), else any pending, else null. */
export function nextPendingKey(
  items: readonly ReviewItem[],
  resolved: ResolvedMap,
  key: string | null,
): string | null {
  const pending = pendingItems(items, resolved);
  if (pending.length === 0) return null;
  const i = items.findIndex((it) => it.key === key);
  for (let j = 1; j <= items.length; j++) {
    const cand = items[(i + j + items.length) % items.length];
    if (cand && !resolved.has(cand.key)) return cand.key;
  }
  return pending[0].key;
}

// ── Session store ────────────────────────────────────────────────────────────

let resolvedState: Map<string, Resolution> = new Map();
const listeners = new Set<(m: ResolvedMap) => void>();

export const reviewState = {
  get(): ResolvedMap {
    return resolvedState;
  },
  set(next: Map<string, Resolution>): void {
    resolvedState = next;
    for (const l of [...listeners]) l(resolvedState);
  },
  resolve(key: string, how: Resolution): void {
    reviewState.set(withResolution(resolvedState, key, how));
  },
  subscribe(cb: (m: ResolvedMap) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  /** Tests only. */
  reset(): void {
    reviewState.set(new Map());
  },
};
