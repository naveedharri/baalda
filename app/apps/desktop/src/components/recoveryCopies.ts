/* Pure helpers behind Vault Health's recovery-copy actions: which reconcile
   rows carry a local copy, where it lives, what a sibling restore is called,
   and how the `.context/trash` listing groups. No I/O, so it runs under vitest. */
import type { ReconcileItem, ReconcileKind } from "../lib/sync/reconcileReport";
import type { TrashCopy } from "../lib/ipc";

export const TRASH_PREFIX = ".context/trash/";

/** A copy's address: the stamp directory and the path under it. */
export interface CopyRef {
  stamp: string;
  relPath: string;
}

/** Kinds whose `detail` MAY be a recovery copy's vault-relative path. */
const COPY_KINDS: ReadonlySet<ReconcileKind> = new Set<ReconcileKind>([
  "deletedByTeammate",
  "keptLocally",
  "externalEditSaved",
]);

const STAMP_RE = /^[A-Za-z0-9_-]+$/;

/**
 * `.context/trash/<stamp>/<rel>` → `{stamp, relPath}`. Anything else (a prose
 * detail like the read-only rejection's, a traversal, an empty rest) is null:
 * Rust re-validates, but a row should not offer actions it cannot perform.
 */
export function parseTrashPath(p: string | null | undefined): CopyRef | null {
  if (!p || !p.startsWith(TRASH_PREFIX)) return null;
  const rest = p.slice(TRASH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const stamp = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  if (!STAMP_RE.test(stamp) || stamp.startsWith(".")) return null;
  const segs = relPath.split("/");
  if (!relPath || segs.some((s) => s === "" || s === "." || s === "..") || relPath.includes("\\")) {
    return null;
  }
  return { stamp, relPath };
}

/** The recovery copy a reconcile row points at, or null when it has none. */
export function reconcileCopyRef(item: Pick<ReconcileItem, "kind" | "detail">): CopyRef | null {
  if (!COPY_KINDS.has(item.kind)) return null;
  return parseTrashPath(item.detail);
}

/** A copy stored under a collision name (`plan (2).md`) belongs to `plan.md`. */
export function originalPathOf(relPath: string): string {
  return relPath.replace(/ \((\d+)\)(\.[^./]+)?$/, (_m, _n, ext: string | undefined) => ext ?? "");
}

export interface CopyActions {
  open: boolean;
  compare: boolean;
  restoreReplace: boolean;
  restoreSibling: boolean;
  delete: boolean;
}

/**
 * Which actions a copy row offers. Compare and Replace need a live note at the
 * original path; a read-only vault can open and delete but not restore.
 */
export function copyActions(opts: {
  hasCopy: boolean;
  liveNoteExists: boolean;
  canWrite: boolean;
}): CopyActions {
  const { hasCopy, liveNoteExists, canWrite } = opts;
  return {
    open: hasCopy,
    compare: hasCopy && liveNoteExists,
    restoreReplace: hasCopy && liveNoteExists && canWrite,
    restoreSibling: hasCopy && canWrite,
    delete: hasCopy,
  };
}

function splitName(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { dir, stem: name, ext: "" };
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * `<stem> (recovered).<ext>` beside `path`, then `(recovered 2)`, … until a
 * name `taken` does not claim. Case-insensitive, like every path compare here.
 */
export function siblingRecoveredPath(path: string, taken: (p: string) => boolean): string {
  const { dir, stem, ext } = splitName(path);
  for (let n = 1; n < 1000; n++) {
    const label = n === 1 ? "recovered" : `recovered ${n}`;
    const candidate = `${dir}${stem} (${label})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${dir}${stem} (recovered ${Date.now()})${ext}`;
}

/** Set of lower-cased paths, for `siblingRecoveredPath`'s `taken`. */
export function caseInsensitiveSet(paths: Iterable<string>): (p: string) => boolean {
  const set = new Set<string>();
  for (const p of paths) set.add(p.toLowerCase());
  return (p) => set.has(p.toLowerCase());
}

export interface CopyGroup {
  stamp: string;
  /** Newest modification time in the group. */
  at: number;
  copies: TrashCopy[];
}

/** Group a listing by stamp, newest group first, paths sorted within one. */
export function groupCopies(copies: readonly TrashCopy[]): CopyGroup[] {
  const by = new Map<string, CopyGroup>();
  for (const c of copies) {
    const g = by.get(c.stamp);
    if (g) {
      g.copies.push(c);
      g.at = Math.max(g.at, c.modified);
    } else {
      by.set(c.stamp, { stamp: c.stamp, at: c.modified, copies: [c] });
    }
  }
  const groups = [...by.values()];
  for (const g of groups) g.copies.sort((a, b) => a.relPath.localeCompare(b.relPath));
  groups.sort((a, b) => b.at - a.at || b.stamp.localeCompare(a.stamp));
  return groups;
}

/** The stamp the app writes is `toISOString()` with `:` and `.` as `-`. */
export function stampTime(stamp: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(stamp);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Tab title for an opened copy: `plan (copy from 26 Sep, 10:00)`. */
export function copyTabTitle(relPath: string, at: number): string {
  const { stem } = splitName(originalPathOf(relPath));
  const when = new Date(at).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${stem} (copy from ${when})`;
}
