// Audio, played by the webview itself — the same contract as `VideoView`
// (asset-protocol streaming, `canPlayType` pre-check plus `onError`, card on
// failure), laid out as a single control row instead of a stage.
//
// The holes are narrower than video's but real: `audio/flac` has no decoder in
// older WebKitGTK builds and `audio/aac` in a bare `.aac` stream is refused by
// engines that happily play the same codec inside `.m4a`.

import { useState } from "react";
import { mimeForPath } from "../../lib/formats";
import { FileCard } from "./FileCard";
import { engineCanPlay } from "./VideoView";
import type { ViewerProps } from "./types";

export function AudioView({ path, abs, src }: ViewerProps) {
  const mime = mimeForPath(path);
  const [failed, setFailed] = useState(!engineCanPlay("audio", mime));
  const name = path.split("/").pop() ?? path;

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
    <div className="file-preview file-preview-audio" data-viewer="audio">
      <div className="file-preview-body">
        <div className="file-audio">
          <div className="file-audio-name" title={path}>
            {name}
          </div>
          <audio
            className="file-preview-media"
            src={src}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
          />
        </div>
      </div>
    </div>
  );
}
