import { invitedChipLabel, invitedChips, seatBreakdown, type InvitedVault } from "../lib/billing";
import type { MyBillingAccount } from "../lib/api";

/**
 * Account Settings → Plan & Billing seat breakdown (Team accounts only):
 * Seats · Claimed · Invited · Available in the members-table styling and
 * the owner's Add or change seats. A planned decrease shows only in the
 * Manage seats dialog. Under the Invited number, one chip per vault holding
 * pending invitations; a chip opens that vault's member list.
 * Pure props so it renders statically in tests.
 */
export function SeatUsageBreakdown({
  seats,
  canManage,
  onManage,
  showManage = true,
  invitedByVault,
  onOpenInvitedVault,
}: {
  seats: MyBillingAccount["seats"];
  canManage: boolean;
  onManage: () => void;
  /** False when the host already offers Add or change seats elsewhere (the
   *  Plan & Billing header), so the button is not shown twice. */
  showManage?: boolean;
  /** Which vaults the Invited seats belong to; absent on older servers. */
  invitedByVault?: InvitedVault[] | null;
  onOpenInvitedVault?: (vault: InvitedVault) => void;
}) {
  const b = seatBreakdown(seats);
  const chips = invitedChips(invitedByVault);
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
            {chips.length === 0 ? (
              <td>{b.reserved}</td>
            ) : (
              <td>
                {b.reserved}
                <div className="plan-page-vault-chips seat-breakdown-invited">
                  {chips.map((v) => (
                    <button
                      key={v.orgId}
                      type="button"
                      className="plan-page-vault-chip"
                      title={`Open ${v.name}'s members and invitations`}
                      onClick={() => onOpenInvitedVault?.(v)}
                    >
                      {invitedChipLabel(v)}
                    </button>
                  ))}
                </div>
              </td>
            )}
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
