import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AsyncButton } from "./AsyncButton";

/**
 * A confirm for actions that are hard to take back. Rides the shared
 * `.modal-backdrop` / `.modal` shell so it stacks above Settings and the
 * access panel wherever it is raised from.
 *
 * PORTALLED to `document.body` (#272): rendered inline, any ancestor that is a
 * containing block for `position: fixed` — the Activity feed's
 * `container-type: inline-size`, the right panel's slide-in transform — laid
 * the backdrop out inside that narrow column and clipped the buttons, so the
 * confirm could not be pressed. Without a DOM (the static-markup tests) it
 * renders inline.
 *
 * `onConfirm` may be async: the confirm button reports on it and the dialog
 * is closed by the caller once it lands (or stays open on failure, so the
 * error has somewhere to show).
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "accent";
  /** Hold the confirm button until the body has what it needs (e.g. a pick). */
  confirmDisabled?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Take focus so keys land in the dialog rather than on the button that
  // raised it, and hand it back when the confirm closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const dialog = (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // A portal still bubbles React events up the component tree, so keep
        // this confirm's clicks from reaching the row or panel that raised it.
        e.stopPropagation();
        onCancel();
      }}
      // Esc is ours (the window listener above): mark it handled so a host
      // that closes on Esc (the right panel) does not close underneath us.
      onKeyDown={(e) => {
        if (e.key === "Escape") e.preventDefault();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal confirm-dialog tone-${tone}`}
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-badge" aria-hidden="true">
          {tone === "danger" ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8h.01M11 12h1v4h1" />
            </svg>
          )}
        </div>
        <h2 className="confirm-title">{title}</h2>
        <div className="confirm-body">{children}</div>
        <div className="confirm-actions">
          <button type="button" className="ghost-pill" onClick={onCancel}>
            {cancelLabel}
          </button>
          <AsyncButton
            className={`primary${tone === "danger" ? " danger" : ""}`}
            spinnerTone="on-accent"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AsyncButton>
        </div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
