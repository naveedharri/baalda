import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * Every banner in the app slides down out of the chrome it belongs to and
 * collapses its own height on the way out.
 *
 * The height animation is the part that matters: a banner that appears with
 * `display: none → block` shoves the editor down by 44px in one frame, and the
 * eye reads that as the *content* jumping rather than as a message arriving.
 * Animating `height` means the layout opens up for it, so attention follows the
 * banner instead of chasing the text that moved.
 *
 * Lives here rather than in `App.tsx` so components outside that file (the
 * not-syncing banner) can use the exact same shape instead of growing a second,
 * subtly different strip.
 */
/** Redesign: what an alert means, which sets its icon tile's colour and glyph. */
export type BannerTone = "danger" | "action" | "good" | "neutral";

/** A tone for the banners that do not pass one, from their existing class. */
const TONE_BY_CLASS: Record<string, BannerTone> = {
  "not-syncing-banner": "danger",
  "note-limit-banner": "action",
  "account-lapsed-banner": "action",
  "vault-folder-missing-banner": "neutral",
  "celebrate-banner": "good",
};

const TONE_ICON: Record<BannerTone, React.ReactNode> = {
  danger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5h.01" />
    </>
  ),
  action: <path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />,
  good: <path d="M20 6 9 17l-5-5" />,
  neutral: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v5h1" />
    </>
  ),
};

export function Banner({
  children,
  show,
  className = "",
  role,
  tone,
}: {
  children: React.ReactNode;
  show: boolean;
  className?: string;
  role?: "status" | "alert";
  tone?: BannerTone;
}) {
  const t = tone ?? className.split(/\s+/).map((c) => TONE_BY_CLASS[c]).find(Boolean) ?? "neutral";
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className="banner-slot"
          initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={
            reduceMotion
              ? { duration: 0.12 }
              : { type: "spring", stiffness: 380, damping: 34 }
          }
        >
          <div className={`banner tone-${t} ${className}`.trim()} role={role}>
            <span className="banner-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {TONE_ICON[t]}
              </svg>
            </span>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
