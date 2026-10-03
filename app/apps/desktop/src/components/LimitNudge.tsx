import type { LimitKind } from "../lib/billing";
import { useStore } from "../store";

/**
 * Inline upgrade nudge shown in the create-vault / invite-member error slot
 * when the server rejects with a 402 free-plan limit. Styled with --warning-soft
 * (reserved for upgrade nudges), not the danger palette — this isn't an error.
 */
export function LimitNudge({
  kind,
  limit,
  onUpgrade,
}: {
  kind: LimitKind;
  limit: number | null;
  onUpgrade: () => void;
}) {
  const freeLimits = useStore((s) => s.billingConfig?.freeLimits);
  // The server is the authority (the 402 carries `limit`, and billingConfig
  // reports both caps); these are last-resort defaults for a nudge rendered
  // before either arrived. Kept separate per kind so the two caps can move
  // independently (members were 10 for a while; both are 3 since 2026-09-09).
  const n =
    limit ??
    (kind === "note_limit" ? 20000 : kind === "member_limit"
      ? (freeLimits?.membersPerVault ?? 3)
      : (freeLimits?.vaultsPerUser ?? 3));
  const message =
    kind === "note_limit" ? `This Free vault has reached ${n.toLocaleString()} synced notes. Upgrade to Pro to sync more; additional notes stay on this device.` : kind === "member_limit"
      ? `Free plan limit reached — this vault allows ${n} member${n === 1 ? "" : "s"}.`
      : // The cap counts FREE vaults only: a Pro vault leaves the count, so
        // upgrading one of them opens a slot for another free vault.
        `You're using all ${n} free vault${n === 1 ? "" : "s"}. Upgrade one to Pro — Pro vaults don't count toward that limit — and you can create another.`;
  return (
    <div className="limit-nudge">
      <span>{message}</span>
      <button className="link-btn" onClick={onUpgrade}>
        Upgrade →
      </button>
    </div>
  );
}
