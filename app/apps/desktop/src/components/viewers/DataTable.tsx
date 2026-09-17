// The table both tabular viewers render — CSV/TSV and every sheet of an XLSX.
//
// One component because the caps are the interesting part and they must be the
// same for both: a spreadsheet is the one attachment a person will happily drop
// with 200 000 rows in it, and a viewer that tries to mount them all freezes
// the window for a minute and then dies. First row is treated as a header
// (that is what a data file almost always carries) and everything lands as a
// TEXT NODE — never `innerHTML` — because these cells are untrusted input from
// a file a teammate dropped.
//
// The look comes from the editor's own table tokens (border, `--bg-subtle`
// header, `--sp-*` padding — `editor/theme.ts`'s `.cm-md-table` rules) so a
// CSV reads like a markdown table in a note. The rules are duplicated in
// `App.css` rather than imported: `theme.ts` is a CodeMirror theme extension,
// scoped inside `.cm-editor`, and none of this is in an editor.

/** Ceilings shared by both tabular viewers. */
export const MAX_TABLE_ROWS = 2000;
export const MAX_TABLE_COLS = 200;

export interface DataTableProps {
  rows: readonly (readonly string[])[];
  /** Rows in the FILE, so the footer can say what it is not showing. */
  totalRows: number;
  /** Columns in the file, same reason. */
  totalCols: number;
  /** Extra line for the footer (the sheet name, an encoding note). */
  note?: string;
}

const N = (n: number) => n.toLocaleString();

export function DataTable({ rows, totalRows, totalCols, note }: DataTableProps) {
  const shownCols = Math.min(totalCols, MAX_TABLE_COLS);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const parts: string[] = [];
  if (totalRows > rows.length) {
    parts.push(`Showing the first ${N(rows.length)} of ${N(totalRows)} rows`);
  } else {
    parts.push(`${N(totalRows)} ${totalRows === 1 ? "row" : "rows"}`);
  }
  if (totalCols > shownCols) {
    parts.push(`first ${N(shownCols)} of ${N(totalCols)} columns`);
  }
  if (note) parts.push(note);

  if (rows.length === 0) {
    return (
      <div className="file-table-wrap">
        <p className="file-table-empty">This file has no rows.</p>
      </div>
    );
  }

  return (
    <div className="file-table-wrap">
      <div className="file-table-scroll">
        <table className="file-table">
          <thead>
            <tr>
              {/* A row number column: the answer to "which line is this?" for
                  anyone cross-referencing the file itself. */}
              <th className="file-table-gutter" scope="col">
                #
              </th>
              {header.map((cell, i) => (
                <th key={i} scope="col">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                <td className="file-table-gutter">{r + 2}</td>
                {/* Ragged rows are normal in real exports; pad to the header so
                    the columns stay aligned instead of shifting left. */}
                {Array.from({ length: Math.max(header.length, row.length) }, (_, c) => (
                  <td key={c}>{row[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="file-table-footer">{parts.join(" · ")}</div>
    </div>
  );
}
