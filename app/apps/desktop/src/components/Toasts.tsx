import { useEffect, useRef } from "react";
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
export function Toasts() {
  const toasts = useToasts();
  const hovering = useRef(false);

  return (
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
    </div>
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
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{toast.text}</span>
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
