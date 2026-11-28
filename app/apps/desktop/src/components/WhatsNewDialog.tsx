import { useEffect, useRef, useState } from "react";
import appIcon from "../assets/brand/app-icon.png";
import { BRAND_NAME } from "../lib/brand";
import { runConfetti } from "../lib/celebrate/celebrate";
import * as ipc from "../lib/ipc";
import type { ReleaseVideo } from "../lib/releaseNotes";

const TONES = ["violet", "green", "orange", "sky", "pink"] as const;

/**
 * The release's video, above the notes: its own thumbnail with a play button
 * and the title, which turns into the player in place when tapped (YouTube's
 * privacy mode, loaded only then, so the card still opens instantly).
 * "Watch on YouTube" shows under the player for when the embed won't play.
 */
function WhatsNewVideo({ video }: { video: ReleaseVideo }) {
  const [playing, setPlaying] = useState(false);
  // The full-size thumbnail first; not every video has one, so fall back to
  // the medium one, then to the plain dark frame.
  const [thumb, setThumb] = useState<"maxresdefault" | "mqdefault" | null>("maxresdefault");
  const title = video.title || "Watch what\u2019s new";
  return (
    <div className="whats-new-video-block">
      <div className="whats-new-player-frame">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&playsinline=1`}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" className="whats-new-poster" onClick={() => setPlaying(true)} aria-label={`Play ${title}`}>
            {thumb && (
              <img
                src={`https://i.ytimg.com/vi/${video.id}/${thumb}.jpg`}
                alt=""
                draggable={false}
                onError={() => setThumb((t) => (t === "maxresdefault" ? "mqdefault" : null))}
              />
            )}
            <span className="whats-new-poster-play" aria-hidden="true" />
            <span className="whats-new-poster-title">{title}</span>
          </button>
        )}
      </div>
      {playing && (
        <button
          type="button"
          className="whats-new-youtube"
          onClick={() => void ipc.openExternal(video.url).catch(() => {})}
        >
          Watch on YouTube
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * The What's New card after an update: the app icon in a ring of the
 * sidebar's folder colours, the version, the release's video when it has
 * one, its points as coloured tiles, Awesome, and confetti. Escape, the
 * backdrop and Awesome all close it.
 */
export function WhatsNewDialog({
  version,
  notes,
  video,
  onClose,
}: {
  version: string;
  notes: { title: string; detail: string }[];
  video: ReleaseVideo | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    return runConfetti(canvasRef.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <canvas ref={canvasRef} className="celebrate-confetti" aria-hidden="true" />
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className={`modal whats-new${video ? " has-video" : ""}`}
          role="dialog"
          aria-label="What's new"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="whats-new-hero">
            <div className="whats-new-badge" aria-hidden="true">
              <div className="whats-new-badge-icon">
                <img src={appIcon} alt="" draggable={false} />
              </div>
            </div>
            <h2 className="whats-new-title">
              {BRAND_NAME} <span className="whats-new-title-version">v{version}</span>
            </h2>
            <p className="whats-new-sub">Updated and ready. Here&rsquo;s what&rsquo;s new.</p>
          </div>
          {video && <WhatsNewVideo video={video} />}
          {notes.length > 0 && (
            <ul className="whats-new-notes">
              {notes.map((n, i) => (
                <li key={i} className={`tone-${TONES[i % TONES.length]}`} style={{ animationDelay: `${(video ? 190 : 120) + i * 70}ms` }}>
                  <span className="whats-new-tile" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </span>
                  <span className="whats-new-text">
                    {n.title && <b>{n.title}</b>}
                    {n.detail && <span>{n.detail}</span>}
                  </span>
                  {i === 0 && <span className="whats-new-tag">NEW</span>}
                </li>
              ))}
            </ul>
          )}
          <button className="primary whats-new-cta" autoFocus onClick={onClose}>
            Awesome
          </button>
        </div>
      </div>
    </>
  );
}
