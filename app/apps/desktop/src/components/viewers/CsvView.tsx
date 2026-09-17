// CSV / TSV as a table.
//
// Bytes come through `ipc.readBinaryFile` (epoch-pinned, validated inside the
// vault by Rust) rather than `fetch(convertFileSrc(...))`: the CSP's
// `connect-src` has no `asset:`, so the fetch form only ever worked in dev.
//
// Two ceilings, both applied BEFORE the work they guard: a stat decides whether
// the file is read at all (`MAX_CSV_BYTES`), and the parser itself stops
// materialising rows past `MAX_TABLE_ROWS` while still counting them, so the
// footer can say "the first 2 000 of 184 219 rows" honestly.

import { useEffect, useState } from "react";
import { delimiterFor, parseDelimited, type ParsedTable } from "../../lib/csv";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import { DataTable, MAX_TABLE_COLS, MAX_TABLE_ROWS } from "./DataTable";
import { FileCard } from "./FileCard";
import type { ViewerProps } from "./types";

/** Past this we show the card instead: a text file this big is a data dump,
 *  not something to read in a pane, and decoding it costs its size twice over
 *  (bytes, then the JS string). */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

export function CsvView({ path, abs }: ViewerProps) {
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTable(null);
    setError(null);
    const epoch = useStore.getState().vault?.epoch;

    void (async () => {
      try {
        const stat = await ipc.fileStat(path, epoch);
        if (cancelled) return;
        if (stat.size > MAX_CSV_BYTES) {
          setError(
            `This file is larger than ${Math.round(MAX_CSV_BYTES / (1024 * 1024))} MB, ` +
              `too big to open as a table here.`,
          );
          return;
        }
        const bytes = await ipc.readBinaryFile(path, epoch);
        if (cancelled) return;
        // `fatal: false`: a stray Latin-1 byte in an otherwise fine export
        // becomes U+FFFD rather than throwing away the whole file.
        const text = new TextDecoder("utf-8").decode(bytes);
        setTable(
          parseDelimited(text, {
            delimiter: delimiterFor(path),
            maxRows: MAX_TABLE_ROWS,
            maxCols: MAX_TABLE_COLS,
          }),
        );
      } catch (e) {
        if (!cancelled) {
          console.error("csv preview failed", e);
          setError("Couldn't read this file.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) return <FileCard path={path} abs={abs} reason={error} />;
  if (!table) return <div className="editor-empty">Loading…</div>;

  return (
    <div className="file-preview file-preview-csv" data-viewer="csv">
      <div className="file-preview-body">
        <DataTable
          rows={table.rows}
          totalRows={table.totalRows}
          totalCols={table.totalCols}
        />
      </div>
    </div>
  );
}
