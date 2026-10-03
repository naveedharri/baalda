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

/** Rows in a column with no interactive ancestor in the same column. */
export function topLevelRows(column: readonly BoardRow[]): AccessRow[] {
  const live = new Set(column.filter((r) => !r.grey).map((r) => r.row.path));
  return column
    .filter((r) => !r.grey && !ancestorPaths(r.row.path).some((p) => live.has(p)))
    .map((r) => r.row);
}

/** "Lee", from the member's name, else the email's local part. */
export function firstName(member: Pick<MemberOverview, "name" | "email" | "userId">): string {
  const name = member.name?.trim();
  if (name) return name.split(/\s+/)[0];
  const local = member.email?.split("@")[0];
  return local || member.userId;
}

/** The undo bar's sentence: "Lee can now view Hiring loop." */
export function moveMessage(who: string, self: boolean, what: string, mode: TeamAccessMode): string {
  const subject = self ? "You" : who;
  if (mode === "open") return `${subject} can now edit ${what}.`;
  if (mode === "readonly") return `${subject} can now view ${what}.`;
  return `${subject} can no longer open ${what}.`;
}
