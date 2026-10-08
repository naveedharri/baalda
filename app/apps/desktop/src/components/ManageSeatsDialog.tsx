import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BillingConfig, MyBillingAccount, SeatPreview } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  billingErrorMessage,
  RESUME_TO_CHANGE_SEATS,
  seatBounds,
  seatChangeLocked,
  seatChangeSummary,
  seatsDialogSubtitle,
} from "../lib/billing";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";

const PREVIEW_DEBOUNCE_MS = 300;

/**
 * Account Settings → Plan & Billing → Manage seats. A stepper over the purchased
 * seat count: an increase is charged now (prorated, an estimate from the
 * server), a decrease takes effect at the period end. The floor is the people
 * already counted or the plan minimum, whichever is higher. While the plan is
 * set to cancel at the period end there is no seat change to make: the dialog
 * offers Resume plan instead. A scheduled decrease shows under the stepper
 * with Keep N seats, which cancels it; a new count replaces it.
 */
export function ManageSeatsDialog({
  account,
  config,
  formatDate,
  onClose,
  onChanged,
  onResume,
  onKeepSeats,
}: {
  account: MyBillingAccount;
  config: BillingConfig;
  formatDate: (iso: string) => string;
  onClose: () => void;
  onChanged: () => void;
  /** The plan tab's resume call; resolves true when the plan resumed. */
  onResume: () => Promise<boolean>;
  /** Cancels the scheduled decrease (seats back to `purchased`); resolves true on success. */
  onKeepSeats: () => Promise<boolean>;
}) {
  const canceling = seatChangeLocked(account);
  const minSeats = config.team?.minSeats ?? 3;
  const floor = seatBounds(account.seats.used, minSeats).min;
  const current = account.seats.purchased;
  const [seats, setSeats] = useState<number>(current ?? floor);
  const [preview, setPreview] = useState<SeatPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = account.seats.pendingDecrease;

  useEffect(() => {
    setPreview(null);
    if (canceling || seats < floor || seats === current) return;
    let cancelled = false;
    const t = setTimeout(() => {
      authManager.api
        .previewSeatChange(seats)
        .then((p) => {
          if (!cancelled) setPreview(p);
        })
        .catch((e) => {
          if (!cancelled) setError(billingErrorMessage(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [seats, floor, current, canceling]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const summary = seatChangeSummary({
    seats,
    current,
    floor,
    used: account.seats.used,
    minSeats,
    preview,
    currency: config.team?.currency ?? "usd",
    interval: account.interval ?? "month",
    formatDate,
  });

  const confirm = async () => {
    setError(null);
    try {
      await authManager.api.setSeats(seats);
      toast(`Seats updated to ${seats}.`);
      onChanged();
      onClose();
    } catch (e) {
      setError(billingErrorMessage(e));
    }
  };

  const subtitle = seatsDialogSubtitle(current, account.seats.used);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="modal manage-seats"
        role="dialog"
        aria-modal="true"
        aria-label="Manage seats"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="manage-seats-head">
          <h2 className="confirm-title">Manage seats</h2>
          <p className="manage-seats-subtitle">{subtitle}</p>
        </div>
        {canceling ? (
          <p className="manage-seats-text">{RESUME_TO_CHANGE_SEATS}</p>
        ) : (
          <>
            <div className="manage-seats-row">
              <span className="manage-seats-label">Seats</span>
              <span className="manage-seats-stepper">
                <button
                  type="button"
                  className="secondary"
                  aria-label="Remove a seat"
                  disabled={seats <= floor}
                  onClick={() => setSeats((n) => Math.max(floor, n - 1))}
                >
                  −
                </button>
                <span className="manage-seats-count" aria-live="polite">
                  {seats}
                </span>
                <button
                  type="button"
                  className="secondary"
                  aria-label="Add a seat"
                  onClick={() => setSeats((n) => n + 1)}
                >
                  +
                </button>
              </span>
            </div>
            {pending && current != null && (
              <div className="manage-seats-scheduled">
                <span>
                  Dropping to {pending.to} {pending.to === 1 ? "seat" : "seats"} on {formatDate(pending.effectiveAt)}.
                </span>
                <AsyncButton
                  type="button"
                  className="link-btn"
                  onClick={async () => {
                    if (await onKeepSeats()) onClose();
                  }}
                >
                  Keep {current} {current === 1 ? "seat" : "seats"}
                </AsyncButton>
              </div>
            )}
            {summary.text && <p className="manage-seats-text">{summary.text}</p>}
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        <div className="confirm-actions invite-people-actions">
          <button type="button" className="ghost-pill" onClick={onClose}>
            Cancel
          </button>
          {canceling ? (
            <AsyncButton
              className="primary"
              spinnerTone="on-accent"
              onClick={async () => {
                if (await onResume()) onClose();
              }}
            >
              Resume plan
            </AsyncButton>
          ) : (
            <AsyncButton className="primary" spinnerTone="on-accent" disabled={!summary.canConfirm} onClick={confirm}>
              Update seats
            </AsyncButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
