// SPDX-License-Identifier: Apache-2.0
// Pure rules behind the member profile's Access board: three columns (Can
// edit / Can view / No access) that one person's folders and notes are sorted
// into. Kept out of the component so the placement rules can be pinned by tests.

import type { MemberOverview, TeamAccessMode } from "./api";
import { ancestorPaths, type AccessRow } from "./accessTree";

/** What the summary route answers for one row (a folder's subtree can be mixed). */
export type SummaryMode = TeamAccessMode | "mixed";

/** Left to right, widest first: the arrows move one step along this. */
export const BOARD_COLUMNS: ReadonlyArray<{ mode: TeamAccessMode; title: string }> = [
  { mode: "open", title: "Can edit" },
  { mode: "readonly", title: "Can view" },
  { mode: "private", title: "No access" },
];

/** Indent levels drawn; deeper rows flatten at the last one. */
export const BOARD_MAX_DEPTH = 5;

export function columnIndex(mode: TeamAccessMode): number {
  return BOARD_COLUMNS.findIndex((c) => c.mode === mode);
}

/** The column one step left (-1) or right (+1), or null at the ends. */
export function neighbourMode(mode: TeamAccessMode, step: -1 | 1): TeamAccessMode | null {
  return BOARD_COLUMNS[columnIndex(mode) + step]?.mode ?? null;
}

const parentPath = (path: string): string | null => {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : path.slice(0, i);
};

/**
 * Each row's OWN level for the board. A note or file's summary is its level.
 * A folder's summary covers its whole subtree, so a folder whose contents
 * differ answers "mixed": its own level is then taken from what most of its
 * direct children have (that is what they inherit from it unless moved out),
 * else `fallback`. Rows with no answer yet are left out.
 */
export function ownModes(
  rows: readonly AccessRow[],
  summaries: ReadonlyMap<string, SummaryMode>,
  fallback: TeamAccessMode,
): Map<string, TeamAccessMode> {
  const out = new Map<string, TeamAccessMode>();
  const byParent = new Map<string, AccessRow[]>();
  for (const row of rows) {
    const parent = parentPath(row.path);
    if (parent === null) continue;
    const list = byParent.get(parent) ?? [];
    list.push(row);
    byParent.set(parent, list);
  }
  // Deepest first, so a mixed folder can look at its child folders' own levels.
  const deepestFirst = [...rows].sort((a, b) => b.depth - a.depth);
  for (const row of deepestFirst) {
    const summary = summaries.get(row.key);
    if (summary === undefined) continue;
    if (summary !== "mixed") {
      out.set(row.key, summary);
      continue;
    }
    const tally = new Map<TeamAccessMode, number>();
    for (const child of row.kind === "folder" ? byParent.get(row.path) ?? [] : []) {
      const m = out.get(child.key);
      if (m) tally.set(m, (tally.get(m) ?? 0) + 1);
    }
    let best: TeamAccessMode | null = null;
    for (const col of BOARD_COLUMNS) {
      const n = tally.get(col.mode) ?? 0;
      if (n > 0 && (best === null || n > (tally.get(best) ?? 0))) best = col.mode;
    }
    out.set(row.key, best ?? fallback);
  }
  return out;
}

export interface BoardRow {
  row: AccessRow;
  /** A path-only ancestor: shown so the tree reads, never interactive. */
  grey: boolean;
  /** Indent level, capped at BOARD_MAX_DEPTH - 1. */
  indent: number;
}

/**
 * The rows one column shows, in tree order: every row whose own level is
 * `mode`, plus the ancestors that lead to it (grey when they live elsewhere).
 */
export function columnRows(
  rows: readonly AccessRow[],
  own: ReadonlyMap<string, TeamAccessMode>,
  mode: TeamAccessMode,
): BoardRow[] {
  const members = new Set<string>();
  const paths = new Set<string>();
  for (const row of rows) {
    if (own.get(row.key) !== mode) continue;
    members.add(row.key);
    for (const a of ancestorPaths(row.path)) paths.add(a);
  }
  return rows
    .filter((row) => members.has(row.key) || (row.kind === "folder" && paths.has(row.path)))
    .map((row) => ({
      row,
      grey: !members.has(row.key),
      indent: Math.min(row.depth, BOARD_MAX_DEPTH - 1),
    }));
}

/**
 * Float this session's moves to the top WITHOUT leaving the tree: at every
 * level, siblings whose subtree holds a recently moved row come first (newest
 * move first), then the rest in their normal order. A moved row keeps its
 * indentation and its grey ancestors, which rise with it. `recentKeys` is
 * newest first; only interactive rows count, so a grey path row whose folder
 * was moved to ANOTHER column does not rise here.
 */
export function orderByRecent(column: readonly BoardRow[], recentKeys: readonly string[]): BoardRow[] {
  if (recentKeys.length === 0) return [...column];
  const recency = new Map(recentKeys.map((k, i) => [k, i]));
  const byPath = new Map(column.map((r) => [r.row.path, r]));
  const children = new Map<BoardRow | null, BoardRow[]>();
  for (const r of column) {
    const parentPath = [...ancestorPaths(r.row.path)].reverse().find((p) => byPath.has(p));
    const parent = parentPath === undefined ? null : byPath.get(parentPath)!;
    const list = children.get(parent) ?? [];
    list.push(r);
    children.set(parent, list);
  }
  const rank = new Map<BoardRow, number>();
  const rankOf = (r: BoardRow): number => {
    const known = rank.get(r);
    if (known !== undefined) return known;
    let best = r.grey ? Infinity : recency.get(r.row.key) ?? Infinity;
    for (const c of children.get(r) ?? []) best = Math.min(best, rankOf(c));
    rank.set(r, best);
    return best;
  };
  const out: BoardRow[] = [];
  const walk = (parent: BoardRow | null) => {
    const kids = (children.get(parent) ?? [])
      .map((r, i) => ({ r, i, k: rankOf(r) }))
      .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k - b.k));
    for (const { r } of kids) {
      out.push(r);
      walk(r);
    }
  };
  walk(null);
  return out;
}

/** One row a column actually draws, after collapsed folders hide their contents. */
export interface BoardViewRow {
  item: BoardRow;
  /** Position in the full column list (the leaving gap is measured there). */
  index: number;
  /** An interactive folder with rows under it in this column: it gets a toggle. */
  expandable: boolean;
  /** Interactive rows under it in this column (shown beside a collapsed folder). */
  descendants: number;
}

/**
 * What a column draws: interactive folders are collapsed unless their key is
 * in `expanded`, and a collapsed folder hides every row under it in this
 * column. Grey path rows never collapse, so the path to an item that lives
 * here stays visible. `column` is in tree order (columnRows / orderByRecent
 * both keep a folder's subtree right after it), so two linear passes do it:
 * a depth stack closes each row's subtree to count it, then one hidden depth
 * skips whatever sits under a collapsed folder. O(n), no ancestor scans.
 */
export function visibleBoardRows(column: readonly BoardRow[], expanded: ReadonlySet<string>): BoardViewRow[] {
  const n = column.length;
  // live[i] = interactive rows among the first i.
  const live = new Array<number>(n + 1);
  live[0] = 0;
  for (let i = 0; i < n; i++) live[i + 1] = live[i] + (column[i].grey ? 0 : 1);
  // end[i] = first index after row i's subtree.
  const end = new Array<number>(n);
  const open: number[] = [];
  for (let i = 0; i <= n; i++) {
    const depth = i < n ? column[i].row.depth : -1;
    while (open.length > 0 && column[open[open.length - 1]].row.depth >= depth) end[open.pop()!] = i;
    if (i < n) open.push(i);
  }
  const out: BoardViewRow[] = [];
  let hiddenBelow = Infinity;
  for (let i = 0; i < n; i++) {
    const item = column[i];
    if (item.row.depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    const expandable = !item.grey && item.row.kind === "folder" && end[i] > i + 1;
    out.push({ item, index: i, expandable, descendants: live[end[i]] - live[i + 1] });
    if (expandable && !expanded.has(item.row.key)) hiddenBelow = item.row.depth;
  }
  return out;
}

/** Every folder in a column that can be expanded ("Expand all"). */
export function expandableKeys(column: readonly BoardRow[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < column.length; i++) {
    const r = column[i];
    if (!r.grey && r.row.kind === "folder" && (column[i + 1]?.row.depth ?? -1) > r.row.depth) out.push(r.row.key);
  }
  return out;
}

/** Rows in a column with no interactive ancestor in the same column. */
export function topLevelRows(column: readonly BoardRow[]): AccessRow[] {
  const live = new Set(column.filter((r) => !r.grey).map((r) => r.row.path));
  return column
    .filter((r) => !r.grey && !ancestorPaths(r.row.path).some((p) => live.has(p)))
    .map((r) => r.row);
}

/**
 * How long one bulk access write may take before the board gives up and puts
 * its rows back. Without it a stalled connection leaves rows moved locally,
 * and the board busy, while the server has nothing.
 */
export const BULK_WRITE_TIMEOUT_MS = 30_000;

/** The toast when a write never reached the server or its answer was lost. */
export const ACCESS_WRITE_FAILED = "Couldn't update access, check your connection";

/**
 * What to tell the owner when a bulk write fails. A refusal the server
 * explained (4xx with a message) is shown as is; a network error, a timeout
 * or a server failure gets the connection sentence.
 */
export function accessWriteFailureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.name === "ApiError") {
    const status = (cause as Error & { status?: number }).status ?? 0;
    if (status >= 400 && status < 500 && cause.message) return cause.message;
  }
  return ACCESS_WRITE_FAILED;
}

/**
 * Undo an optimistic write: only the rows it touched go back to what they
 * read before it (or to unknown, if they had no answer then). Rows answered
 * meanwhile by other reads keep their newer value.
 */
export function revertModes<V>(
  current: ReadonlyMap<string, V>,
  before: ReadonlyMap<string, V>,
  keys: Iterable<string>,
): Map<string, V> {
  const next = new Map(current);
  for (const key of keys) {
    if (before.has(key)) next.set(key, before.get(key)!);
    else next.delete(key);
  }
  return next;
}

/** "Lee", from the member's name, else the email's local part. */
export function firstName(member: Pick<MemberOverview, "name" | "email" | "userId">): string {
  const name = member.name?.trim();
  if (name) return name.split(/\s+/)[0];
  const local = member.email?.split("@")[0];
  return local || member.userId;
}

/** Said when the server's answer after a move disagrees with it. */
export function notAppliedMessage(what: string, actual: SummaryMode): string {
  if (actual === "mixed") return `Couldn't apply everywhere — part of ${what} kept its level`;
  const label = BOARD_COLUMNS.find((c) => c.mode === actual)?.title ?? actual;
  return `Couldn't apply — ${what} is still ${label}`;
}

/** The toast's sentence: "Lee can now view Hiring loop." */
export function moveMessage(who: string, self: boolean, what: string, mode: TeamAccessMode): string {
  const subject = self ? "You" : who;
  if (mode === "open") return `${subject} can now edit ${what}.`;
  if (mode === "readonly") return `${subject} can now view ${what}.`;
  return `${subject} can no longer open ${what}.`;
}
