// The honest fallback: a file the app will not pretend to render.
//
// Two audiences, one card. A `pptx` or a `zip` reaches it by design (no OSS
// renderer we would trust with untrusted input), and EVERY other viewer falls
// back to it when the bytes, the decoder or the size cap say no — that is the
// rule the whole viewer family is built on: a leaf that fails shows the card
// with a reason, never a blank pane or a thrown boundary.
//
// It never reads the file. `ipc.fileStat` answers size + mtime from a stat, so
// opening a 25 MB archive costs nothing but the row it prints.

import { useEffect, useState } from "react";
import { formatFor, type FormatCategory } from "../../lib/formats";
import { formatBytes } from "../../lib/health/format";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";

/** Attachment names are `<sha256-first-16-hex>.<ext>` (see `attachments.ts`). */
const HASH_NAME = /^([0-9a-f]{16})\.[^.]+$/i;

function CardSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="file-card-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A page outline, the shared silhouette every category glyph sits inside. */
const PAGE = (
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </>
);

/** Category → glyph. Deliberately a small local set: importing the sidebar's
 *  icons would pull `FileTree` (and react-arborist) into this chunk. */
function iconFor(category: FormatCategory | null) {
  switch (category) {
    case "archive":
      return (
        <CardSvg>
          {PAGE}
          <path d="M11 6h2M11 9h2M11 12h2M11 15h2" />
        </CardSvg>
      );
    case "presentation":
      return (
        <CardSvg>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M12 16v4M8 20h8" />
        </CardSvg>
      );
    case "spreadsheet":
      return (
        <CardSvg>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 10v10M3 15h18" />
        </CardSvg>
      );
    case "office-doc":
      return (
        <CardSvg>
          {PAGE}
          <path d="M8 13h8M8 17h5" />
        </CardSvg>
      );
    case "video":
      return (
        <CardSvg>
          <rect x="3" y="5" width="13" height="14" rx="2" />
          <path d="m16 10 5-3v10l-5-3Z" />
        </CardSvg>
      );
    case "audio":
      return (
        <CardSvg>
          <path d="M9 18V6l10-2v12" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="16" r="2.5" />
        </CardSvg>
      );
    case "image":
      return (
        <CardSvg>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="m4 18 5-5 4 4 3-3 4 4" />
        </CardSvg>
      );
    case "pdf":
      return (
        <CardSvg>
          {PAGE}
          <path d="M8 14h1.5a1.5 1.5 0 0 1 0 3H8v-3ZM13 14h2M13 17h2M13 14v3" />
        </CardSvg>
      );
    case "data":
      return (
        <CardSvg>
          {PAGE}
          <path d="m9 12-2 2.5L9 17M15 12l2 2.5-2 2.5" />
        </CardSvg>
      );
    default:
      return <CardSvg>{PAGE}</CardSvg>;
  }
}

export interface FileCardProps {
  /** Vault-relative path. */
  path: string;
  /** Absolute on-disk path — what the opener plugin takes. */
  abs: string;
  /** Why the app is showing a card instead of the file, if it is a failure. */
  reason?: string;
}

/**
 * Name, size, and the two things the OS can still do with the file.
 *
 * "Open externally" and "Reveal" go through `ipc.openInFileManager` /
 * `ipc.revealInFileManager`, which already carry the `openPath` ↔
 * `revealItemInDir` fallback for a vault outside `$HOME` (the `open_path`
 * scope in `capabilities/default.json`) — so no capability had to widen for
 * this card.
 */
export function FileCard({ path, abs, reason }: FileCardProps) {
  const [size, setSize] = useState<number | null>(null);
  const name = path.split("/").pop() ?? path;
  const format = formatFor(path);
  const hash = HASH_NAME.exec(name)?.[1] ?? null;

  useEffect(() => {
    let cancelled = false;
    setSize(null);
    void ipc
      .fileStat(path, useStore.getState().vault?.epoch)
      .then((stat) => {
        if (!cancelled) setSize(stat.size);
      })
      // A card whose stat failed still names the file and still opens it; the
      // size line simply stays out.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="file-preview file-preview-card" data-viewer="card">
      <div className="file-preview-body">
        <div className="file-card">
          {iconFor(format?.category ?? null)}
          <div className="file-card-name" title={path}>
            {name}
          </div>
          <div className="file-card-meta">
            {[
              format ? format.exts[0].toUpperCase() : "File",
              size == null ? null : formatBytes(size),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {hash && (
            <div className="file-card-hash" title="Content hash (first 16 hex)">
              {hash}
            </div>
          )}
          {reason && <p className="file-card-reason">{reason}</p>}
          <div className="file-card-actions">
            <button
              type="button"
              className="ghost-pill sm"
              onClick={() => void ipc.openInFileManager(abs)}
            >
              Open externally
            </button>
            <button
              type="button"
              className="ghost-pill sm"
              onClick={() => void ipc.revealInFileManager(abs)}
            >
              {ipc.revealLabel()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
