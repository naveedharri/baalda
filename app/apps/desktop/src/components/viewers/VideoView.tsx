// Video, played by the webview itself.
//
// The bytes stay on disk and stream over the asset protocol (which serves
// single-range requests, so the scrubber works) — never through `readBinaryFile`,
// which would pull a 200 MB recording into JS to hand it back as a blob.
//
// Codec reality is why the card fallback matters here more than anywhere else:
// macOS WKWebView decodes mp4/mov (H.264, HEVC) and WebM VP8/VP9, WebView2
// decodes mp4 and webm, but **Linux WebKitGTK needs GStreamer plugins most
// distros do not ship**, so the very same file that plays for the person who
// dropped it may be undecodable for a teammate. Two guards, because one is not
// enough: `canPlayType` answers before a frame is drawn (an empty string is a
// flat "no"), and `onError` catches the rest — a codec inside a container the
// engine claims to support, a truncated download, a missing file.

import { useState } from "react";
import { mimeForPath } from "../../lib/formats";
import { FileCard } from "./FileCard";
import type { ViewerProps } from "./types";

/** "" from `canPlayType` means no. Anything else ("maybe"/"probably") is a go.
 *  Outside a DOM (a node test) we do not pre-judge — the element decides. */
export function engineCanPlay(kind: "video" | "audio", mime: string): boolean {
  if (typeof document === "undefined") return true;
  try {
    const el = document.createElement(kind);
    return el.canPlayType(mime) !== "";
  } catch {
    return true;
  }
}

export function VideoView({ path, abs, src }: ViewerProps) {
  const mime = mimeForPath(path);
  const [failed, setFailed] = useState(!engineCanPlay("video", mime));

  if (failed) {
    return (
      <FileCard
        path={path}
        abs={abs}
        reason={`This system's browser engine can't decode ${mime}. Open it in another player.`}
      />
    );
  }

  return (
    <div className="file-preview file-preview-video" data-viewer="video">
      <div className="file-preview-body">
        {/* No autoplay: opening a file is not a request to make noise. */}
        <video
          className="file-preview-media"
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
