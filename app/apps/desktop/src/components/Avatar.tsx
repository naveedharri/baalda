/* ============================================================
   Character avatars — every user is auto-assigned a unique illustrated
   character (DiceBear "notionists" — clean, professional Notion-style line
   art) from a stable seed (their id/email/name), so nobody is stuck with a
   flat "TU". Generated as pure SVG on-device: no network, no external avatar
   service (which would break local-first and leak identity), and the same
   seed renders the same character on every machine. Backgrounds are drawn
   from our happy palette so the vibe stays coherent.

   LAZY ONLY. `@dicebear/collection` is ~300 KB, so this module must never be
   static-imported from a module that is in the eager startup graph — eager
   call sites go through `./Face` (`<Face>` / `<LazyAvatar>`) instead. Modules
   that already live behind a lazy boundary (Editor, the vault-settings
   dialog, ShareDialog) import it directly, which is correct: they pay for the
   chunk they are already in.
   ============================================================ */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import { PRESENCE_PALETTE } from "../lib/presence/color";

// Palette hex values without the leading "#", as DiceBear expects. DiceBear
// deterministically picks one per seed, so each character gets its own colour.
const AVATAR_BG = PRESENCE_PALETTE.map((c) => c.slice(1));

/** Build the illustrated-character SVG for a seed. */
export function characterSvg(seed: string): string {
  return createAvatar(notionists, {
    seed,
    backgroundColor: AVATAR_BG,
    backgroundType: ["solid"],
    radius: 50,
  }).toString();
}

export interface FaceProps {
  seed: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  ariaHidden?: boolean;
}

/** The bare face span every caller used to hand-roll around `characterSvg`. */
export function FaceSvg({ seed, className, style, title, ariaHidden }: FaceProps) {
  const svg = useMemo(() => characterSvg(seed || "?"), [seed]);
  return (
    <span
      className={className}
      style={style}
      title={title}
      aria-hidden={ariaHidden || undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function Avatar({ label, image }: { label: string; image?: string | null }) {
  const svg = useMemo(() => characterSvg(label || "?"), [label]);
  // Prefer a real profile photo (e.g. from Google) when present; fall back to
  // the generated character if there's no image or it fails to load.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [image]);

  if (image && !imgFailed) {
    return (
      <span className="avatar" aria-hidden="true">
        <img
          src={image}
          alt=""
          // Google's lh3.googleusercontent.com can 403 when a referrer is sent.
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="avatar"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
