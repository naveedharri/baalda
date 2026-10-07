import { seatBreakdown } from "../lib/billing";
import type { MyBillingAccount } from "../lib/api";
import { AsyncButton } from "./AsyncButton";

export const SEAT_EXPLAINER =
  "Seats are what you pay for. Every person in your vaults uses one; pending invitations reserve one until they're accepted.";

/**
 * Account Settings → Plan & Billing seat breakdown (Team accounts only):
 * Seats · Claimed · Reserved · Available in the members-table styling, a
 * planned-decrease notice above it, and the owner's Add or change seats.
 * Pure props so it renders statically in tests.
 */
export function SeatUsageBreakdown({
  seats,
  canManage,
  formatDate,
  onManage,
  onKeepSeats,
  showManage = true,
}: {
  seats: MyBillingAccount["seats"];
  canManage: boolean;
  formatDate: (iso: string) => string;
  onManage: () => void;
  /** Cancels a planned decrease by setting seats back to `purchased`. */
  onKeepSeats: () => Promise<unknown>;
  /** False when the host already offers Add or change seats elsewhere (the
   *  Plan & Billing header), so the button is not shown twice. */
  showManage?: boolean;
}) {
  const b = seatBreakdown(seats);
  const pending = seats.pendingDecrease;
  return (
    <div className="seat-breakdown">
      {pending && (
        <div className="limit-nudge is-info" role="status">
          <span>
            Planned seat change: {pending.to} {pending.to === 1 ? "seat" : "seats"} from{" "}
            {formatDate(pending.effectiveAt)}. Changes to seats take effect next billing cycle.
          </span>
          {canManage && (
            <AsyncButton className="link-btn" onClick={onKeepSeats}>
              Keep {b.purchased} {b.purchased === 1 ? "seat" : "seats"}
            </AsyncButton>
          )}
        </div>
      )}
      <table className="members-table seat-breakdown-table">
        <thead>
          <tr>
            <th>Seats</th>
            <th>Claimed</th>
            <th>Reserved</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{b.purchased}</td>
            <td>{b.claimed}</td>
            <td>{b.reserved}</td>
            <td>{b.available}</td>
          </tr>
        </tbody>
      </table>
      <div className="billing-section-note">{SEAT_EXPLAINER}</div>
      {canManage && showManage && (
        <div className="vault-row-actions">
          <button className="secondary billing-action" onClick={onManage}>
            Add or change seats
          </button>
        </div>
      )}
    </div>
  );
}
