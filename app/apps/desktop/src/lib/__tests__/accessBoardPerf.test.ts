// SPDX-License-Identifier: Apache-2.0
// The Access board's model must stay linear for a vault of tens of thousands
// of rows: a 14,675-row column used to feel laggy. These bounds are generous
// (CI machines vary); they catch a quadratic regression, not a slow laptop.

import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, columnRows, orderByRecent, ownModes, visibleBoardRows, type SummaryMode } from "../accessBoard";
import { entriesFromServer, rowsFromEntries } from "../accessTree";

/** A vault of `n` rows: folders three deep, ten notes per leaf folder. */
function syntheticTree(n: number) {
  const folders: Array<{ id: string; path: string }> = [];
  const notes: Array<{ id: string; relPath: string }> = [];
  let i = 0;
  for (let a = 0; folders.length + notes.length < n; a++) {
    const top = `Area ${a}`;
    folders.push({ id: `f${i++}`, path: top });
    for (let b = 0; b < 10 && folders.length + notes.length < n; b++) {
      const mid = `${top}/Project ${b}`;
      folders.push({ id: `f${i++}`, path: mid });
      for (let c = 0; c < 10 && folders.length + notes.length < n; c++) {
        notes.push({ id: `n${i++}`, relPath: `${mid}/Note ${c}.md` });
      }
    }
  }
  return { folders, notes };
}

const modesCycle: SummaryMode[] = ["open", "readonly", "private"];

/** Everything the board computes from a fresh tree and every row's answer. */
function buildBoard(n: number): number {
  const tree = syntheticTree(n);
  const entries = entriesFromServer(tree);
  const rows = rowsFromEntries(entries, new Set(entries.filter((e) => e.kind === "folder").map((e) => e.path)));
  const summaries = new Map<string, SummaryMode>(rows.map((r, i) => [r.key, modesCycle[i % 3]]));
  const own = ownModes(rows, summaries, "private");
  const recent = rows.slice(0, 5).map((r) => r.key);
  let drawn = 0;
  for (const c of BOARD_COLUMNS) {
    const column = orderByRecent(columnRows(rows, own, c.mode), recent);
    drawn += visibleBoardRows(column, new Set()).length;
  }
  return drawn;
}

function fastest(n: number, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    buildBoard(n);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe("Access board model at scale", () => {
  it("builds a 15,000-row board well under the bound, and grows linearly", () => {
    buildBoard(2000); // warm the JIT
    const small = fastest(15_000);
    const large = fastest(30_000);
    // eslint-disable-next-line no-console
    console.log(`[accessBoardPerf] 15k rows ${small.toFixed(1)} ms, 30k rows ${large.toFixed(1)} ms`);
    expect(small).toBeLessThan(400);
    expect(large / small).toBeLessThan(3);
  });
});
