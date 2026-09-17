// Spreadsheets (`.xlsx` / `.xlsm`), one tab per sheet.
//
// `read-excel-file` is browser-first, read-only and small — and specifically
// NOT SheetJS, whose npm package is frozen at 0.18.5 with two unpatched CVEs
// and whose fixed builds ship only from the vendor's own CDN.
//
// v9 of the package changed the shape this depends on: `readSheetNames()` is
// gone and the default export now returns EVERY sheet at once
// (`[{ sheet, data }]`), so one call gives both the tab strip and the cells.
// The import is the `/browser` entry (the package has no root export) and is
// memoised, so the chunk is fetched the first time someone opens a workbook
// and never at startup.
//
// Cells become TEXT NODES, always. A spreadsheet is untrusted input; nothing
// here goes near `innerHTML`.

import { useEffect, useState } from "react";
import { maxBytesFor } from "../../lib/formats";
import { formatBytes } from "../../lib/health/format";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import { DataTable, MAX_TABLE_COLS, MAX_TABLE_ROWS } from "./DataTable";
import { FileCard } from "./FileCard";
import type { ViewerProps } from "./types";

/** Same ask-first threshold as the docx viewer, for the same reason: parsing a
 *  workbook is synchronous and a big one stalls the window. */
export const XLSX_CONFIRM_BYTES = 10 * 1024 * 1024;

type Cell = string | number | boolean | Date | null;
interface RawSheet {
  sheet: string;
  data: Cell[][];
}
type ReadXlsx = (input: ArrayBuffer) => Promise<RawSheet[]>;

let readerPromise: Promise<ReadXlsx> | null = null;

/** The ONLY reference to the package in the app. */
function loadReader(): Promise<ReadXlsx> {
  if (!readerPromise) {
    readerPromise = import("read-excel-file/browser").then(
      (m) => (m as unknown as { default: ReadXlsx }).default,
    );
  }
  return readerPromise;
}

/** One cell as the file spells it. Dates get the locale's short form; numbers
 *  and booleans their plain `String()`, which is what the sheet showed. */
function cellText(value: Cell): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

interface Sheet {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
}

function toSheet(raw: RawSheet): Sheet {
  const data = raw.data ?? [];
  let totalCols = 0;
  for (const row of data) if (row.length > totalCols) totalCols = row.length;
  return {
    name: raw.sheet,
    rows: data
      .slice(0, MAX_TABLE_ROWS)
      .map((row) => row.slice(0, MAX_TABLE_COLS).map(cellText)),
    totalRows: data.length,
    totalCols,
  };
}

export function XlsxView({ path, abs }: ViewerProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [askSize, setAskSize] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setActive(0);
    setError(null);
    setAskSize(null);
    const epoch = useStore.getState().vault?.epoch;

    void (async () => {
      try {
        const stat = await ipc.fileStat(path, epoch);
        if (cancelled) return;
        const hardCap = maxBytesFor("xlsx");
        if (stat.size > hardCap) {
          setError(
            `This workbook is ${formatBytes(stat.size)} — over the ${formatBytes(hardCap)} limit.`,
          );
          return;
        }
        if (stat.size > XLSX_CONFIRM_BYTES && !confirmed) {
          setAskSize(stat.size);
          return;
        }
        const [bytes, readXlsx] = await Promise.all([
          ipc.readBinaryFile(path, epoch),
          loadReader(),
        ]);
        if (cancelled) return;
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const raw = await readXlsx(buffer);
        if (cancelled) return;
        setSheets(raw.map(toSheet));
      } catch (e) {
        if (!cancelled) {
          console.error("xlsx preview failed", e);
          setError("Couldn't read this workbook.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, confirmed]);

  if (error) return <FileCard path={path} abs={abs} reason={error} />;

  const sheet = sheets?.[active] ?? null;

  return (
    <div className="file-preview file-preview-xlsx" data-viewer="xlsx">
      <div className="file-preview-body">
        {askSize != null ? (
          <div className="file-ask">
            <p>This workbook is {formatBytes(askSize)}. Reading it may take a few seconds.</p>
            <button type="button" className="primary sm" onClick={() => setConfirmed(true)}>
              Open anyway
            </button>
          </div>
        ) : sheets == null ? (
          <div className="editor-empty">Loading…</div>
        ) : sheet == null ? (
          <div className="editor-empty">This workbook has no sheets.</div>
        ) : (
          <>
            {sheets.length > 1 && (
              <div className="file-sheet-tabs">
                <div className="segmented">
                  {sheets.map((s, i) => (
                    <button
                      type="button"
                      key={s.name + i}
                      className={i === active ? "active" : ""}
                      onClick={() => setActive(i)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <DataTable
              rows={sheet.rows}
              totalRows={sheet.totalRows}
              totalCols={sheet.totalCols}
            />
          </>
        )}
      </div>
    </div>
  );
}
