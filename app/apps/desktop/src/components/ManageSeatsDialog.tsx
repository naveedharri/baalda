import { useEffect, useState } from "react";
import type { BillingConfig, MyBillingAccount, SeatPreview } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { seatBounds, seatChangeSummary } from "../lib/billing";
import { toast } from "../lib/toast";
import { ConfirmDialog } from "./ConfirmDialog";

const PREVIEW_DEBOUNCE_MS = 300;

/**
 * Account Settings → Plan & Billing → Manage seats. A stepper over the purchased
 * seat count: an increase is charged now (prorated, an estimate from the
 * server), a decrease takes effect at the period end. The floor is the people
 * already counted or the plan minimum, whichever is higher.
 */
export function ManageSeatsDialog({
  account,
  config,
  formatDate,
  onClose,
  onChanged,
}: {
  account: MyBillingAccount;
  config: BillingConfig;
  formatDate: (iso: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const minSeats = config.team?.minSeats ?? 3;
  const floor = seatBounds(account.seats.used, minSeats).min;
  const current = account.seats.purchased;
  const [seats, setSeats] = useState<number>(current ?? floor);
  const [preview, setPreview] = useState<SeatPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    if (seats < floor || seats === current) return;
    let cancelled = false;
    const t = setTimeout(() => {
      authManager.api
        .previewSeatChange(seats)
        .then((p) => {
          if (!cancelled) setPreview(p);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [seats, floor, current]);

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
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ConfirmDialog
      tone="accent"
      title="Manage seats"
      confirmLabel="Update seats"
      confirmDisabled={!summary.canConfirm}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="menu-row">
        <span className="menu-row-label">Seats</span>
        <span className="vault-row-actions">
          <button
            type="button"
            className="secondary"
            aria-label="Remove a seat"
            disabled={seats <= floor}
            onClick={() => setSeats((n) => Math.max(floor, n - 1))}
          >
            −
          </button>
          <span aria-live="polite">{seats}</span>
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
      <p className="muted">
        {account.seats.used} {account.seats.used === 1 ? "person counts" : "people count"} on
        your account.
      </p>
      {summary.text && <p>{summary.text}</p>}
      {error && <div className="auth-error">{error}</div>}
    </ConfirmDialog>
  );
}
