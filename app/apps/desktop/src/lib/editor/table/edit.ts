/**
 * Table edits as minimal span replacements.
 *
 * Same contract as the Properties panel's planners (`lib/frontmatter/edit.ts`):
 * every function here returns CM6 change specs and dispatches nothing. The
 * caller turns them into one ordinary editor transaction, so a table edit is
 * indistinguishable from typing — yCollab puts it in the `Y.Text`, the bridge
 * egests it to the `.md`, Rust re-indexes, and Yjs undo treats it as one step.
 *
 * The invariant the tests assert: apply a planner's changes to the source and
 * every byte outside the intended span is identical. Renaming a header cell
 * cannot reflow the table, re-pad a column, or normalise anybody's `---:`.
 */

import {
  type TableCell,
  type TableModel,
  type TableRow,
  type CellAlign,
} from "./parse";

export interface SpanChange {
  from: number;
  to: number;
  insert: string;
}

/** The cell text a new empty cell is written with: `|  |`. */
const EMPTY_CELL = "  ";
/** The delimiter cell a new column brings with it. */
const EMPTY_DELIMITER = " --- ";

/**
 * Make text safe to sit in a table cell: newlines become spaces (a pipe table
 * row IS a line), and every UNESCAPED `|` gains its backslash. An escape the
 * writer typed themselves (`\|`) is left exactly as it is, so round-tripping a
 * cell through the editor never doubles a backslash.
 */
export function escapeCellText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\\\||\|/g, (m) => (m === "|" ? "\\|" : m));
}

/** Replace one cell's content, and nothing else. */
export function planSetCell(cell: TableCell, text: string): SpanChange[] {
  const insert = escapeCellText(text).trim();
  if (insert === cell.raw) return [];
  return [{ from: cell.span.from, to: cell.span.to, insert }];
}

/**
 * Write into a column this row does not have yet (a ragged row the widget
 * padded on render). The row grows by the missing cells; every other row is
 * untouched, so the table stays exactly as ragged as the writer left it.
 */
export function planFillCell(row: TableRow, col: number, text: string): SpanChange[] {
  if (col < row.cells.length) return planSetCell(row.cells[col]!, text);
  const value = escapeCellText(text).trim();
  const gap = `${EMPTY_CELL}|`.repeat(col - row.cells.length);
  const cell = value === "" ? EMPTY_CELL : ` ${value} `;
  if (row.trailingPipe) {
    return [{ from: row.to, to: row.to, insert: `${gap}${cell}|` }];
  }
  // With no trailing pipe the row's last cell is open-ended; close it first, or
  // the new content joins it instead of starting a cell of its own.
  return [{ from: row.to, to: row.to, insert: ` |${gap}${cell}|` }];
}

function blankRowLine(columns: number): string {
  return `|${`${EMPTY_CELL}|`.repeat(Math.max(1, columns))}`;
}

/**
 * A new empty row after `afterRowIndex` (an index into `model.rows`; `-1` puts
 * it directly under the delimiter, as the first body row).
 */
export function planInsertRow(model: TableModel, afterRowIndex: number): SpanChange[] {
  const anchorRow =
    afterRowIndex < 0
      ? (model.delimiter ?? model.header)
      : (model.rows[Math.min(afterRowIndex, model.rows.length - 1)] ??
        model.delimiter ??
        model.header);
  const at = anchorRow.to;
  return [{ from: at, to: at, insert: `\n${blankRowLine(model.columns)}` }];
}

/**
 * Delete one BODY row (`rowIndex` indexes `model.rows`), taking the newline
 * that ended the line above it so no blank line is left behind. The header and
 * the delimiter are not deletable — a table without them is not a table.
 */
export function planDeleteRow(model: TableModel, rowIndex: number): SpanChange[] {
  const row = model.rows[rowIndex];
  if (!row) return [];
  return [{ from: Math.max(0, row.from - 1), to: row.to, insert: "" }];
}

/** One row's share of a column insert, or `null` when the row is too short. */
function insertCellInRow(
  row: TableRow,
  afterCol: number,
  filler: string,
): SpanChange | null {
  if (afterCol < 0) {
    if (row.leadingPipe) {
      const at = row.pipes[0]! + 1;
      return { from: at, to: at, insert: `${filler}|` };
    }
    return { from: row.from, to: row.from, insert: `|${filler}|` };
  }
  const cell = row.cells[afterCol];
  if (!cell) return null; // ragged row: it has no such column to insert after
  const end = cell.segment.to;
  if (row.pipes.includes(end)) {
    return { from: end + 1, to: end + 1, insert: `${filler}|` };
  }
  // The last cell of a row with no trailing pipe: close it, then add the cell.
  return { from: row.to, to: row.to, insert: ` |${filler}|` };
}

/**
 * A new column after `afterColIndex` (`-1` = before the first). Every row gets
 * ONE insert, including the delimiter row — which gets a delimiter cell, not an
 * empty one, or the table would stop being a table.
 */
export function planInsertColumn(model: TableModel, afterColIndex: number): SpanChange[] {
  const out: SpanChange[] = [];
  const push = (row: TableRow | null, filler: string) => {
    if (!row) return;
    const change = insertCellInRow(row, afterColIndex, filler);
    if (change) out.push(change);
  };
  push(model.header, EMPTY_CELL);
  push(model.delimiter, EMPTY_DELIMITER);
  for (const row of model.rows) push(row, EMPTY_CELL);
  return out.sort((a, b) => a.from - b.from);
}

/** Remove one column from every row that has it. */
export function planDeleteColumn(model: TableModel, col: number): SpanChange[] {
  if (model.columns <= 1) return []; // the last column is the table
  const out: SpanChange[] = [];
  const push = (row: TableRow | null) => {
    if (!row) return;
    const cell = row.cells[col];
    if (!cell) return;
    const s = cell.segment.from;
    const e = cell.segment.to;
    const pipeBefore = row.pipes.includes(s - 1);
    const pipeAfter = row.pipes.includes(e);
    // Take the pipe AFTER the first column, the pipe BEFORE any other: either
    // way the row keeps the leading/trailing pipe style it was written in.
    if (col === 0 && pipeAfter) out.push({ from: s, to: e + 1, insert: "" });
    else if (pipeBefore) out.push({ from: s - 1, to: e, insert: "" });
    else if (pipeAfter) out.push({ from: s, to: e + 1, insert: "" });
    else out.push({ from: s, to: e, insert: "" });
  };
  push(model.header);
  push(model.delimiter);
  for (const row of model.rows) push(row);
  return out.sort((a, b) => a.from - b.from);
}

/** Set one column's alignment by rewriting its delimiter cell's colons. */
export function planSetAlignment(
  model: TableModel,
  col: number,
  align: CellAlign,
): SpanChange[] {
  const cell = model.delimiter?.cells[col];
  if (!cell) return [];
  const dashes = "-".repeat(Math.max(3, (cell.raw.match(/-/g) ?? []).length));
  const insert =
    align === "center"
      ? `:${dashes}:`
      : align === "left"
        ? `:${dashes}`
        : align === "right"
          ? `${dashes}:`
          : dashes;
  if (insert === cell.raw) return [];
  return [{ from: cell.span.from, to: cell.span.to, insert }];
}
