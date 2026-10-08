import {
  askOwnerTo,
  classifyLimitError,
  freePeopleCopy,
  freePeopleIncluded,
  limitFromError,
  peopleLimitReason,
  seatLimitFromError,
  seatsFullCopy,
} from "../lib/billing";
import { ApiError } from "../lib/api";
import { useStore } from "../store";

/**
 * A per-address `inviteMany` error string that is really a people limit
 * (`seat_limit_reached` / `member_limit_reached`), rebuilt as the 402 the
 * notice classifies, so the Add seats / Upgrade affordance shows for it too.
 * Any other string is null and stays a plain error.
 */
export function inviteLimitError(error: string): ApiError | null {
  const code = ["seat_limit_reached", "member_limit_reached"].find((c) => error.includes(c));
  return code ? new ApiError(402, error, { error: code }) : null;
}

/** The message for an invite/join refused for people (member_limit / seat_limit), or null. */
export function peopleLimitKind(e: unknown): "member_limit" | "seat_limit" | null {
  const kind = classifyLimitError(e);
  return kind === "member_limit" || kind === "seat_limit" ? kind : null;
}

/**
 * Inline notice for a refused invite or join. Free accounts hold two people;
 * Team vaults are capped by seats. Only the owner can add seats.
 */
export function PeopleLimitNotice({ error, canManageBilling, ownerName = null, freeLimit = null }: {
  error: unknown;
  canManageBilling: boolean;
  /** The vault owner's name, so an admin's line says whom to ask. */
  ownerName?: string | null;
  /** The account's Free people limit, when the error itself carries none. */
  freeLimit?: number | null;
}) {
  const kind = peopleLimitKind(error);
  if (!kind) return null;
  if (kind === "member_limit") {
    const cap = limitFromError(error) ?? freeLimit ?? 2;
    return (
      <div className="limit-nudge">
        <span>
          {canManageBilling ? freePeopleCopy(cap) : `${freePeopleIncluded(cap)} ${askOwnerTo(ownerName, "upgrade to Team")}`}
        </span>
        {canManageBilling && (
          <button
            className="link-btn"
            onClick={() => useStore.getState().requestUpgradeDialog({ reason: peopleLimitReason(cap) })}
          >
            Upgrade →
          </button>
        )}
      </div>
    );
  }
  const message = seatsFullCopy(seatLimitFromError(error)?.seats ?? null);
  return (
    <div className="limit-nudge">
      <span>{canManageBilling ? message : `${message} ${askOwnerTo(ownerName, "add seats")}`}</span>
      {canManageBilling && (
        <button className="link-btn" onClick={() => useStore.getState().requestAccountSettings("plan")}>
          Add seats
        </button>
      )}
    </div>
  );
}
