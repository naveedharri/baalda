import {
  ASK_OWNER_SEATS_COPY,
  FREE_PEOPLE_COPY,
  PEOPLE_LIMIT_REASON,
  classifyLimitError,
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
export function PeopleLimitNotice({ error, canManageBilling }: { error: unknown; canManageBilling: boolean }) {
  const kind = peopleLimitKind(error);
  if (!kind) return null;
  if (kind === "member_limit") {
    return (
      <div className="limit-nudge">
        <span>{FREE_PEOPLE_COPY}</span>
        {canManageBilling && (
          <button
            className="link-btn"
            onClick={() => useStore.getState().requestUpgradeDialog({ reason: PEOPLE_LIMIT_REASON })}
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
      <span>{canManageBilling ? message : `${message} ${ASK_OWNER_SEATS_COPY}`}</span>
      {canManageBilling && (
        <button className="link-btn" onClick={() => useStore.getState().requestAccountSettings("plan")}>
          Add seats
        </button>
      )}
    </div>
  );
}
