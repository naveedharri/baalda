import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { dismissToast, useToasts, type Toast } from "../lib/toast";

/**
 * The toast viewport: bottom-right, above everything, never in the way of the
 * sidebar or the editor's own status row.
 *
 * Two details carry most of the feel:
 * - Toasts slide in from the edge they live on, so the motion explains where
 *   they came from instead of just fading into existence.
 * - Hovering the stack **pauses every auto-dismiss**. Reaching for a message
 *   that then disappears under the cursor is the single most annoying thing a
 *   toast can do, and it's the reason people distrust them.
 */
/** The glyph in each tone's icon tile: a tick, an info mark, an alert. */
const TONE_ICON: Record<Toast["tone"], React.ReactNode> = {
  success: <path d="M20 6 9 17l-5-5" />,
  neutral: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v5h1" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16.5h.01" />
    </>
  ),
};

export function Toasts() {
  const toasts = useToasts();
  const hovering = useRef(false);

  // Portalled to <body> so no ancestor's stacking context can trap it under
  // a modal: Vault Settings used to blur toasts out behind its backdrop.
  return createPortal(
    <div
      className="toast-viewport"
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseLeave={() => {
        hovering.current = false;
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} hovering={hovering} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function ToastRow({
  toast,
  hovering,
}: {
  toast: Toast;
  hovering: React.RefObject<boolean>;
}) {
  const reduceMotion = useReducedMotion();

  // Auto-dismiss, deferred while the pointer is over the stack. Polling on a
  // slice of the ttl rather than one long timeout is what lets a hover extend
  // the life of a toast that was already halfway gone.
  useEffect(() => {
    if (toast.ttl === 0) return; // sticky (errors)
    let left = toast.ttl;
    const STEP = 100;
    const tick = window.setInterval(() => {
      if (hovering.current) return;
      left -= STEP;
      if (left <= 0) {
        window.clearInterval(tick);
        dismissToast(toast.id);
      }
    }, STEP);
    return () => window.clearInterval(tick);
  }, [toast.id, toast.ttl, hovering]);

  return (
    <motion.div
      className={`toast toast-${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      layout={!reduceMotion}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.96 }}
      transition={
        reduceMotion
          ? { duration: 0.12 }
          : { type: "spring", stiffness: 420, damping: 32 }
      }
    >
      <span className="toast-dot" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {TONE_ICON[toast.tone]}
        </svg>
      </span>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        ×
      </button>
    </motion.div>
  );
}
