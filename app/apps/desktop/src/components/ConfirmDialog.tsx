import { useEffect, type ReactNode } from "react";
import { AsyncButton } from "./AsyncButton";

/**
 * A confirm for actions that are hard to take back. Rides the shared
 * `.modal-backdrop` / `.modal` shell so it stacks above Settings and the
 * access panel wherever it is raised from.
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
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "accent";
  onConfirm: () => Promise<unknown> | unknown;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
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
            onClick={onConfirm}
          >
            {confirmLabel}
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
