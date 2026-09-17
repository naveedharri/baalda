// The pane for everything that is not a CRDT note: the router from a path to
// a viewer, via the format registry's `viewerFor`.
//
// Two shapes of leaf, on purpose:
//   - image and PDF are INLINE here. They are the two the webview renders
//     natively off the asset protocol (no decoder, no parser, no dependency),
//     and they are also the common case — a lazy chunk boundary would only add
//     a flash of "Loading…" to something the browser already draws instantly.
//   - everything else is `React.lazy` (the `App.tsx` pattern), because each
//     leaf carries something real: CodeMirror grammars, mammoth, the xlsx
//     reader. A vault of images must never pay for a docx renderer.
//
// HTML keeps `HtmlView` — a plain read/write page in a sandboxed frame, not a
// CRDT note — reached through the registry's `html` viewer, so this component
// is now the ONE place that answers "what opens this file".
//
// Failure has exactly one shape everywhere: `FileCard` — name, size, "Open
// externally" — with a reason. Each leaf renders it for its own foreseeable
// failures (bad bytes, size cap, missing codec); `ViewerErrorBoundary` catches
// what nothing foresaw, including a lazy chunk that fails to load.

import { lazy, Suspense, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { viewerFor, type ViewerKind } from "../lib/formats";
import { HtmlView } from "./HtmlView";
import { FileCard } from "./viewers/FileCard";
import { ViewerErrorBoundary } from "./viewers/ErrorBoundary";
import type { ViewerProps } from "./viewers/types";

const VideoView = lazy(() =>
  import("./viewers/VideoView").then((m) => ({ default: m.VideoView })),
);
const AudioView = lazy(() =>
  import("./viewers/AudioView").then((m) => ({ default: m.AudioView })),
);
const CsvView = lazy(() => import("./viewers/CsvView").then((m) => ({ default: m.CsvView })));
const CodeView = lazy(() => import("./viewers/CodeView").then((m) => ({ default: m.CodeView })));
const DocxView = lazy(() => import("./viewers/DocxView").then((m) => ({ default: m.DocxView })));
const XlsxView = lazy(() => import("./viewers/XlsxView").then((m) => ({ default: m.XlsxView })));

const LAZY_LEAVES: Partial<Record<ViewerKind, React.ComponentType<ViewerProps>>> = {
  video: VideoView,
  audio: AudioView,
  csv: CsvView,
  code: CodeView,
  docx: DocxView,
  xlsx: XlsxView,
};

/** Image and PDF: streamed straight off the asset protocol, no chunk. */
function NativeView({ path, abs, src, kind }: ViewerProps & { kind: "image" | "pdf" }) {
  const [failed, setFailed] = useState(false);
  const name = path.split("/").pop() ?? path;

  if (failed) {
    return <FileCard path={path} abs={abs} reason={`Couldn't load ${name}.`} />;
  }
  return (
    <div className={`file-preview file-preview-${kind}`} data-viewer={kind}>
      <div className="file-preview-body">
        {kind === "image" ? (
          <img
            className="file-preview-img"
            src={src}
            alt={name}
            onError={() => setFailed(true)}
          />
        ) : (
          <iframe className="file-preview-frame" src={src} title={name} />
        )}
      </div>
    </div>
  );
}

export function FilePreview({ path }: { path: string }) {
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const viewer = viewerFor(path);

  // No vault means no absolute path to stream or open — the pane is mounted
  // from an open note, so this is a torn-down-vault frame, not a real state.
  if (!vaultPath) {
    return (
      <div className="editor-empty">
        <p>Can't preview this file.</p>
      </div>
    );
  }

  const abs = `${vaultPath.replace(/\/$/, "")}/${path}`;
  const src = convertFileSrc(abs);
  const props: ViewerProps = { path, abs, src };

  // HtmlView owns its own chrome (Preview/Source toggle) and fills the pane.
  if (viewer === "html") return <HtmlView path={path} />;
  if (viewer === "image" || viewer === "pdf") {
    return <NativeView key={path} {...props} kind={viewer} />;
  }

  const Leaf = LAZY_LEAVES[viewer];
  if (!Leaf) return <FileCard key={path} {...props} />;

  return (
    // Keyed by path so a boundary that caught one file does not swallow the
    // next, and so a leaf's per-file state (a codec verdict, a sheet tab)
    // starts clean.
    <ViewerErrorBoundary
      key={path}
      fallback={() => <FileCard {...props} reason="Couldn't open this file." />}
    >
      <Suspense fallback={<div className="editor-empty">Loading…</div>}>
        <Leaf {...props} />
      </Suspense>
    </ViewerErrorBoundary>
  );
}
