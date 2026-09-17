// A delimited-text reader for the CSV/TSV viewer: RFC 4180, one pass, capped.
//
// Hand-rolled on purpose (no dependency): the whole grammar is quotes,
// doubled quotes and line endings, and a viewer needs exactly one thing a
// library would not give for free — a HARD CEILING. A 40 MB export must not
// become 40 MB of JS strings plus a million DOM nodes just because someone
// clicked it, so the caps are applied WHILE parsing: past `maxRows` the rows
// are still *counted* (the footer says "the first 2 000 of 184 219") but never
// materialised, and past `maxCols` the extra fields are dropped the same way.
//
// Everything comes back as a string. A viewer renders text nodes; guessing
// numbers or dates here would only mean re-deriving the original spelling to
// display it, and the file is the source of truth.

/** The result of one parse — rows are already capped, the counts are not. */
export interface ParsedTable {
  /** At most `maxRows` rows, each at most `maxCols` fields. */
  readonly rows: readonly (readonly string[])[];
  /** Rows in the FILE, including the ones past the cap. */
  readonly totalRows: number;
  /** Widest row in the file, including fields past the cap. */
  readonly totalCols: number;
  /** True when a cap dropped something — the footer's cue. */
  readonly truncated: boolean;
}

export interface ParseOptions {
  /** `","` (default) or `"\t"` for `.tsv`. */
  delimiter?: string;
  maxRows?: number;
  maxCols?: number;
}

/** `.tsv` is tab-delimited; everything else in the `csv` viewer is a comma. */
export function delimiterFor(path: string): string {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}

/**
 * Parse `text` as RFC 4180 delimited data.
 *
 * The rules, all of which the suite pins:
 *  - a field wrapped in `"` may contain the delimiter, `\r`/`\n` and `""` (one
 *    literal quote);
 *  - `\r\n`, `\n` and a lone `\r` all end a row;
 *  - a trailing newline does NOT invent a final empty row, but a blank line in
 *    the middle IS a row (one empty field) — dropping it would silently change
 *    a file's row numbering;
 *  - rows may be ragged; nothing is padded, so a short row stays short and the
 *    viewer fills the gap.
 * A leading UTF-8 BOM is stripped (Excel writes one).
 */
export function parseDelimited(text: string, opts: ParseOptions = {}): ParsedTable {
  const delimiter = opts.delimiter ?? ",";
  const maxRows = opts.maxRows ?? Infinity;
  const maxCols = opts.maxCols ?? Infinity;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let totalRows = 0;
  let totalCols = 0;
  let colsDropped = false;

  // The row under construction. `fieldCount` counts every field the row has,
  // including the ones past `maxCols` that never reach `row`.
  let row: string[] = [];
  let fieldCount = 0;
  let field = "";
  let started = false; // this row has seen at least one character or delimiter
  // A `"` only opens a quoted field at the START of one. Mid-field (`a"b`) it
  // is a literal character, which is what Excel writes and what every reader
  // has to cope with.
  let atFieldStart = true;

  const keepingRow = () => rows.length < maxRows;

  const endField = () => {
    fieldCount += 1;
    if (fieldCount <= maxCols) {
      if (keepingRow()) row.push(field);
    } else {
      colsDropped = true;
    }
    field = "";
    atFieldStart = true;
  };

  const endRow = () => {
    endField();
    totalRows += 1;
    if (fieldCount > totalCols) totalCols = fieldCount;
    if (keepingRow()) rows.push(row);
    row = [];
    fieldCount = 0;
    started = false;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    if (ch === '"' && atFieldStart) {
      // A quoted field. Scan to the closing quote, collapsing `""` to `"`.
      started = true;
      i += 1;
      let chunkStart = i;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q === -1) {
          // Unterminated quote: take the rest of the file as the field rather
          // than throwing. A truncated download must still show its rows.
          field += src.slice(chunkStart);
          i = n;
          break;
        }
        if (src[q + 1] === '"') {
          field += src.slice(chunkStart, q + 1); // keep one of the pair
          i = q + 2;
          chunkStart = i;
          continue;
        }
        field += src.slice(chunkStart, q);
        i = q + 1;
        break;
      }
      atFieldStart = false;
      continue;
    }

    if (src.startsWith(delimiter, i)) {
      started = true;
      endField();
      i += delimiter.length;
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      endRow();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    // Unquoted run: copy up to the next character that means something.
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === "\n" || c === "\r" || src.startsWith(delimiter, j)) break;
      j += 1;
    }
    field += src.slice(i, j);
    started = true;
    atFieldStart = false;
    i = j;
  }

  // EOF: a file that ended with a newline has nothing pending; one that ended
  // mid-row still owes its last row.
  if (started || field !== "" || fieldCount > 0) endRow();

  return {
    rows,
    totalRows,
    totalCols,
    truncated: colsDropped || totalRows > rows.length,
  };
}
