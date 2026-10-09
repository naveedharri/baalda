import { seatBreakdown } from "../lib/billing";
import type { MyBillingAccount } from "../lib/api";

/**
 * Account Settings → Plan & Billing seat breakdown (Team accounts only):
 * Seats · Claimed · Invited · Available in the members-table styling and
 * the owner's Add or change seats. A planned decrease shows only in the
 * Manage seats dialog.
 * Pure props so it renders statically in tests.
 */
export function SeatUsageBreakdown({
  seats,
  canManage,
  onManage,
  showManage = true,
}: {
  seats: MyBillingAccount["seats"];
  canManage: boolean;
  onManage: () => void;
  /** False when the host already offers Add or change seats elsewhere (the
   *  Plan & Billing header), so the button is not shown twice. */
  showManage?: boolean;
}) {
  const b = seatBreakdown(seats);
  return (
    <div className="seat-breakdown">
      <table className="members-table seat-breakdown-table">
        <thead>
          <tr>
            <th>Seats</th>
            <th>Claimed</th>
            <th>Invited</th>
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
