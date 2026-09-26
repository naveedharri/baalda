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

// ── Persistence (per vault, this device) ─────────────────────────────────────
//
// Pending review items must survive a restart: the report itself is in-memory.
// What is saved is the REVIEWABLE report items recorded since this vault
// opened, plus their resolutions. On the next open, resolved items are dropped
// (they are done), items whose local copy is gone from .context/trash are
// pruned, and the rest are re-recorded into the report so the banner and the
// review tab show them again.

export const REVIEW_STORAGE_PREFIX = "baalda.review.v1:";

export interface PersistedReview {
  items: ReconcileItem[];
  resolved: [string, Resolution][];
}

const KINDS: ReadonlySet<string> = new Set([
  "restoredFromServer",
  "deletedByTeammate",
  "renamedConflict",
  "keptLocally",
  "folderKept",
  "externalEditSaved",
]);
const RESOLUTIONS: ReadonlySet<string> = new Set(["kept", "restored", "restoredSibling", "skipped"]);

/** Only reviewable items are worth saving; everything else is a notice. */
export function serializeReview(items: readonly ReconcileItem[], resolved: ResolvedMap): PersistedReview {
  const reviewable = new Set(reviewItems(items).map((it) => it.key));
  const kept = new Map<string, ReconcileItem>();
  for (const it of items) {
    const k = reviewKey(it);
    if (reviewable.has(k)) kept.set(k, it);
  }
  return {
    items: [...kept.values()],
    resolved: [...resolved].filter(([k]) => kept.has(k)),
  };
}

/** Parse whatever storage held; anything malformed is dropped, never thrown. */
export function parseReview(raw: string | null): PersistedReview | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { items?: unknown; resolved?: unknown };
  const items: ReconcileItem[] = [];
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!it || typeof it !== "object") continue;
    const x = it as Record<string, unknown>;
    if (typeof x.kind !== "string" || !KINDS.has(x.kind) || typeof x.path !== "string") continue;
    items.push({
      kind: x.kind as ReconcileKind,
      path: x.path,
      at: typeof x.at === "number" ? x.at : 0,
      ...(typeof x.docId === "string" ? { docId: x.docId } : {}),
      ...(typeof x.newPath === "string" ? { newPath: x.newPath } : {}),
      ...(typeof x.detail === "string" ? { detail: x.detail } : {}),
    });
  }
  const resolved: [string, Resolution][] = [];
  for (const r of Array.isArray(d.resolved) ? d.resolved : []) {
    if (Array.isArray(r) && typeof r[0] === "string" && RESOLUTIONS.has(r[1])) {
      resolved.push([r[0], r[1] as Resolution]);
    }
  }
  return { items, resolved };
}

/**
 * What to seed on the next open: pending items only, minus any whose local
 * copy no longer exists (`existingCopies` holds `<stamp>/<relPath>`; null
 * means the check could not run, so nothing is pruned for a missing copy).
 */
export function prunePersisted(
  p: PersistedReview,
  existingCopies: ReadonlySet<string> | null,
): ReconcileItem[] {
  const done = new Set(p.resolved.map(([k]) => k));
  const out: ReconcileItem[] = [];
  for (const it of p.items) {
    if (done.has(reviewKey(it))) continue;
    const copy = reconcileCopyRef(it);
    if (copy && existingCopies && !existingCopies.has(`${copy.stamp}/${copy.relPath}`)) continue;
    out.push(it);
  }
  return out;
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function storage(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPersisted(vaultKey: string, kv: KV | null = storage()): PersistedReview | null {
  try {
    return parseReview(kv?.getItem(REVIEW_STORAGE_PREFIX + vaultKey) ?? null);
  } catch {
    return null;
  }
}

export function writePersisted(vaultKey: string, p: PersistedReview, kv: KV | null = storage()): void {
  try {
    if (!kv) return;
    if (p.items.length === 0) kv.removeItem(REVIEW_STORAGE_PREFIX + vaultKey);
    else kv.setItem(REVIEW_STORAGE_PREFIX + vaultKey, JSON.stringify(p));
  } catch {
    // Storage full or blocked: the review still works for this session.
  }
}
