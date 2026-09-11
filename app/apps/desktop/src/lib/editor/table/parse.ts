/**
 * A GFM pipe table, read out of the document with doc-absolute offsets.
 *
 * Pure: no DOM, no CodeMirror view. Everything the editable table widget does
 * to a table — set a cell, add a column, change an alignment — is a minimal
 * span replacement planned against the spans this module hands out, so a cell
 * edit touches the cell's bytes and nothing else. Padding spaces deliberately
 * live OUTSIDE a cell's span: `| a  |` keeps its two trailing spaces when `a`
 * becomes `b`.
 *
 * GFM rules honoured here:
 *  - `\|` is a LITERAL pipe, not a cell separator (the only escape that matters
 *    inside a table row).
 *  - the leading and trailing `|` of a row are both optional, and when present
 *    they are delimiters, not empty cells.
 *  - the delimiter row's colons carry the column alignment.
 *
 * Ragged rows are described, never repaired: a row with fewer or more cells
 * than the header keeps exactly the cells it has, and the widget pads on
 * render. Rewriting someone's table because a row is short is not an edit they
 * asked for.
 */

import type { Text } from "@codemirror/state";

export interface Span {
  from: number;
  to: number;
}

export type CellAlign = "left" | "center" | "right" | null;

export interface TableCell {
  /** Doc-absolute span of the TRIMMED content; padding stays outside it. */
  span: Span;
  /** The trimmed source of the cell, `\|` escapes intact. */
  raw: string;
  /** Doc-absolute span of the whole segment between two pipes, padding included. */
  segment: Span;
}

export interface TableRow {
  /** Doc-absolute start and end of the row's LINE (no newline). */
  from: number;
  to: number;
  cells: TableCell[];
  /** Doc-absolute positions of this line's unescaped `|` characters. */
  pipes: number[];
  leadingPipe: boolean;
  trailingPipe: boolean;
}

export interface TableModel {
  /** Doc-absolute range of the whole table. */
  from: number;
  to: number;
  header: TableRow;
  /** `null` only for a malformed table with no `---` row. */
  delimiter: TableRow | null;
  /** One entry per delimiter cell. */
  aligns: CellAlign[];
  /** Body rows, in document order. The delimiter row is not one of them. */
  rows: TableRow[];
  /** The widest row, so a ragged table shows every cell somebody typed. */
  columns: number;
}

/** Positions of the `|` characters that actually separate cells. */
function pipePositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++; // `\|` is a literal pipe; `\\` eats itself the same way
      continue;
    }
    if (text[i] === "|") out.push(i);
  }
  return out;
}

/**
 * Split one row into cells. `lineFrom` is the line's doc offset, so every span
 * this returns is doc-absolute.
 */
export function parseRow(text: string, lineFrom: number): TableRow {
  const pipes = pipePositions(text);
  const firstInk = text.search(/\S/);
  const lastInk = text.search(/\s*$/);
  const leadingPipe = firstInk >= 0 && pipes.includes(firstInk);
  const trailingPipe = lastInk > 0 && pipes.includes(lastInk - 1);

  const segments: Array<[number, number]> = [];
  let start = 0;
  for (const p of pipes) {
    segments.push([start, p]);
    start = p + 1;
  }
  segments.push([start, text.length]);
  // A leading/trailing pipe is a delimiter, so the whitespace outside it is not
  // a cell. An empty FIRST cell (`|  | b |`) survives: the dropped segment is
  // the run before the pipe, not the one after it.
  if (leadingPipe && segments.length > 1) segments.shift();
  if (trailingPipe && segments.length > 1) segments.pop();

  const cells: TableCell[] = segments.map(([s, e]) => {
    let a = s;
    while (a < e && /\s/.test(text[a]!)) a++;
    let b = e;
    while (b > a && /\s/.test(text[b - 1]!)) b--;
    if (a === b) {
      // An empty cell has no content to point at. Anchoring one character in
      // keeps `|  |` writing as `| x |` rather than `|  x|` — the padding is
      // preserved instead of being eaten by the first thing typed.
      a = b = s + Math.min(1, e - s);
    }
    return {
      span: { from: lineFrom + a, to: lineFrom + b },
      raw: text.slice(a, b),
      segment: { from: lineFrom + s, to: lineFrom + e },
    };
  });

  return {
    from: lineFrom,
    to: lineFrom + text.length,
    cells,
    pipes: pipes.map((p) => lineFrom + p),
    leadingPipe,
    trailingPipe,
  };
}

/** `---`, `:--`, `--:`, `:-:` — the row that makes the one above it a header. */
export function isDelimiterRow(row: TableRow): boolean {
  return row.cells.length > 0 && row.cells.every((c) => /^:?-+:?$/.test(c.raw));
}

export function alignOf(raw: string): CellAlign {
  const left = raw.startsWith(":");
  const right = raw.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

const EMPTY_ROW = (at: number): TableRow => ({
  from: at,
  to: at,
  cells: [],
  pipes: [],
  leadingPipe: false,
  trailingPipe: false,
});

/**
 * Read the table covering `[from, to)`. Total: a range that is not a table
 * comes back as a one-row model with no delimiter, which every planner then
 * declines to touch.
 */
export function parseTable(doc: Text, from: number, to: number): TableModel {
  const firstLine = doc.lineAt(Math.max(0, Math.min(from, doc.length))).number;
  const lastLine = doc.lineAt(Math.max(0, Math.min(Math.max(from, to), doc.length))).number;

  const lines: TableRow[] = [];
  for (let n = firstLine; n <= lastLine; n++) {
    const line = doc.line(n);
    // A trailing newline in the node's range resolves to the next (blank) line;
    // a blank line is never part of a table.
    if (line.text.trim() === "") continue;
    lines.push(parseRow(line.text, line.from));
  }

  const header = lines[0] ?? EMPTY_ROW(from);
  let delimiter: TableRow | null = null;
  let rows: TableRow[] = [];
  if (lines.length > 1 && isDelimiterRow(lines[1]!)) {
    delimiter = lines[1]!;
    rows = lines.slice(2);
  } else {
    rows = lines.slice(1);
  }

  const columns = Math.max(
    header.cells.length,
    delimiter?.cells.length ?? 0,
    ...rows.map((r) => r.cells.length),
  );

  return {
    from: header.from,
    to: lines.length > 0 ? lines[lines.length - 1]!.to : to,
    header,
    delimiter,
    aligns: delimiter ? delimiter.cells.map((c) => alignOf(c.raw)) : [],
    rows,
    columns,
  };
}

/**
 * Rows as the widget shows them: index 0 is the header, 1..n the body. The
 * delimiter row is never displayed, so it is never addressable by index.
 */
export function rowOf(model: TableModel, displayRow: number): TableRow | null {
  if (displayRow === 0) return model.header;
  return model.rows[displayRow - 1] ?? null;
}

/** How many rows the widget draws (header + body). */
export function displayRowCount(model: TableModel): number {
  return 1 + model.rows.length;
}
