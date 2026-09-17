// Word documents, converted to HTML and rendered as real DOM.
//
// Three deliberate choices:
//
//  1. NOT an iframe. mammoth's output is HTML derived from a file a teammate
//     dropped, so it goes through the editor's one sanitizer
//     (`editor/sanitizeHtml.ts`) — the same rules that render an inline `<div>`
//     in a note: script/style/frame tags dropped, `on*` and `javascript:`
//     stripped, anchors rewired so a click cannot navigate the app away.
//  2. The image resolver accepts `data:image/*` and NOTHING else. mammoth
//     inlines a document's own pictures as base64 data URIs, which is exactly
//     what we want to show; any other `src` in that markup came from the file
//     and would be an outbound request the moment it rendered, so it is
//     blanked.
//  3. The package is loaded by ONE memoised dynamic import, like
//     `editor/mermaid/renderer.ts`. mammoth carries jszip + xmldom; it must
//     never land in the startup bundle, and it is listed with mermaid in the
//     "deliberately not warmed" note in `lib/prefetch.ts`.

import { useEffect, useRef, useState } from "react";
import { renderEmbeddedHtml } from "../../lib/editor/sanitizeHtml";
import { maxBytesFor } from "../../lib/formats";
import { formatBytes } from "../../lib/health/format";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import { FileCard } from "./FileCard";
import type { ViewerProps } from "./types";

/** Above this we ask first. Converting a document is synchronous work inside
 *  mammoth: a 40 MB file with 300 images freezes the window while it runs, and
 *  a person who opened it by mis-clicking the sidebar never asked for that. */
export const DOCX_CONFIRM_BYTES = 10 * 1024 * 1024;

interface MammothMessage {
  type: string;
  message: string;
}
interface MammothResult {
  value: string;
  messages: MammothMessage[];
}
interface MammothApi {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}

let mammothPromise: Promise<MammothApi> | null = null;

/** The ONLY reference to the package in the app. */
function loadMammoth(): Promise<MammothApi> {
  if (!mammothPromise) {
    mammothPromise = import("mammoth").then((m) => {
      const mod = m as unknown as { default?: MammothApi } & MammothApi;
      return (mod.default ?? mod) as MammothApi;
    });
  }
  return mammothPromise;
}

/** Only a document's own inlined pictures render; everything else is dropped. */
const resolveDocxImage = (src: string) => (/^data:image\//i.test(src) ? src : "");

export function DocxView({ path, abs }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<MammothMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Set once the user answers the "large file" prompt for this path. */
  const [confirmed, setConfirmed] = useState(false);
  const [askSize, setAskSize] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setWarnings([]);
    setError(null);
    setAskSize(null);
    const epoch = useStore.getState().vault?.epoch;

    void (async () => {
      try {
        const stat = await ipc.fileStat(path, epoch);
        if (cancelled) return;
        const hardCap = maxBytesFor("docx");
        if (stat.size > hardCap) {
          setError(
            `This document is ${formatBytes(stat.size)} — over the ${formatBytes(hardCap)} limit.`,
          );
          return;
        }
        if (stat.size > DOCX_CONFIRM_BYTES && !confirmed) {
          setAskSize(stat.size);
          return;
        }
        const [bytes, mammoth] = await Promise.all([
          ipc.readBinaryFile(path, epoch),
          loadMammoth(),
        ]);
        if (cancelled) return;
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        if (cancelled) return;
        setHtml(result.value);
        setWarnings(result.messages ?? []);
      } catch (e) {
        if (!cancelled) {
          console.error("docx preview failed", e);
          setError("Couldn't read this document.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, confirmed]);

  useEffect(() => {
    if (html == null || !hostRef.current) return;
    renderEmbeddedHtml(hostRef.current, html, resolveDocxImage);
  }, [html]);

  if (error) return <FileCard path={path} abs={abs} reason={error} />;

  return (
    <div className="file-preview file-preview-docx" data-viewer="docx">
      <div className="file-preview-body">
        {askSize != null ? (
          <div className="file-ask">
            <p>
              This document is {formatBytes(askSize)}. Rendering it may take a few seconds.
            </p>
            <button type="button" className="primary sm" onClick={() => setConfirmed(true)}>
              Render anyway
            </button>
          </div>
        ) : html == null ? (
          <div className="editor-empty">Loading…</div>
        ) : (
          <div className="file-doc">
            {warnings.length > 0 && (
              <details className="file-doc-warnings">
                <summary>
                  {warnings.length} conversion{" "}
                  {warnings.length === 1 ? "note" : "notes"}
                </summary>
                <ul>
                  {warnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="file-doc-body" ref={hostRef} />
          </div>
        )}
      </div>
    </div>
  );
}
