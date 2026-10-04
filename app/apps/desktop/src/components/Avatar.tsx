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
import { useResolvedAvatar, type AvatarIdentity } from "../lib/avatarIdentity";

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

export interface FaceProps extends AvatarIdentity {
  className?: string;
  style?: CSSProperties;
  title?: string;
  ariaHidden?: boolean;
}

/** Photo-or-character markup for a resolved avatar, inside the caller's span. */
function useAvatarMarkup(identity: AvatarIdentity) {
  const { photo, seed } = useResolvedAvatar(identity);
  const svg = useMemo(() => characterSvg(seed), [seed]);
  // Prefer the person's photo; fall back to the generated character if it
  // fails to load.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [photo]);
  return { photo: photo && !imgFailed ? photo : null, svg, onError: () => setImgFailed(true) };
}

function PhotoImg({ src, onError }: { src: string; onError: () => void }) {
  // Google's lh3.googleusercontent.com can 403 when a referrer is sent.
  return <img src={src} alt="" referrerPolicy="no-referrer" onError={onError} />;
}

/**
 * The face span every small avatar uses (presence stack, roster, sidebar
 * presence, version rows): the person's stored picture, else the character
 * seeded by their user id (`lib/avatarIdentity.ts`).
 */
export function FaceSvg({ className, style, title, ariaHidden, ...identity }: FaceProps) {
  const { photo, svg, onError } = useAvatarMarkup(identity);
  const common = { className, style, title, "aria-hidden": ariaHidden || undefined };
  if (photo) {
    return (
      <span {...common}>
        <PhotoImg src={photo} onError={onError} />
      </span>
    );
  }
  return <span {...common} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * The account-sized avatar (account bar, Members and access, profile page,
 * settings). `label` is the display name, used as the seed only when no user
 * id is known (an invitation row, say).
 */
export function Avatar({
  label,
  image,
  userId,
}: {
  label: string;
  image?: string | null;
  userId?: string | null;
}) {
  const { photo, svg, onError } = useAvatarMarkup({ userId, name: label, image });
  if (photo) {
    return (
      <span className="avatar" aria-hidden="true">
        <PhotoImg src={photo} onError={onError} />
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
