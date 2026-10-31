/**
 * Vault invitations in the account menu, and the one signal that reaches you
 * while it is closed.
 *
 * - `InvitationsTab`: the menu's first row ("Invitations", a count, a chevron)
 *   whose panel opens beside it on hover, focus or click. Rendered only while
 *   invitations are pending, so a menu with none has no such row.
 * - `InviteArrivalNote`: a small card above the identity bar for an invitation
 *   this device has not shown yet. It appears only when one arrives; opening
 *   the menu, ✕ or answering it settles it, and the avatar badge stays until
 *   every invitation is answered.
 */
import { useEffect, useRef, useState } from "react";
import { saveSeenInvitations } from "../lib/inviteSeen";
import { AsyncButton } from "./AsyncButton";
import { MenuIcon } from "./MenuIcon";
import { acceptInvite, InvitationRows, type Invitation } from "./InvitationRows";

/** Time the pointer may spend crossing the gap between the row and its panel. */
const PANEL_CLOSE_DELAY_MS = 220;

export function invitationCountLabel(n: number): string {
  return `${n} invitation${n === 1 ? "" : "s"}`;
}

export function InvitationsTab({
  invitations,
  freshIds,
  defaultOpen = false,
}: {
  invitations: ReadonlyArray<Invitation>;
  freshIds: ReadonlySet<string>;
  /** Open the panel on mount ("View all" from the arrival note). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    clearTimer();
    setOpen(true);
  };
  const hideSoon = () => {
    clearTimer();
    closeTimer.current = setTimeout(() => setOpen(false), PANEL_CLOSE_DELAY_MS);
  };
  useEffect(() => clearTimer, []);
  if (invitations.length === 0) return null;
  const n = invitations.length;
  return (
    <div
      className={`invites-tab${open ? " is-open" : ""}`}
      onPointerEnter={show}
      onPointerLeave={hideSoon}
    >
      <button
        type="button"
        className="menu-item invites-tab-row"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          clearTimer();
          setOpen((o) => !o);
        }}
        onFocus={show}
      >
        <MenuIcon>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </MenuIcon>
        <span className="menu-item-label">Invitations</span>
        <span className="invites-count" aria-label={invitationCountLabel(n)}>
          {n}
        </span>
        <svg
          className="invites-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <div className="invites-flyout" role="menu" aria-label="Invitations">
          <div className="invites-flyout-head">
            <b>Invitations</b>
            <span>{n} waiting</span>
          </div>
          <InvitationRows invitations={invitations} freshIds={freshIds} variant="flyout" />
        </div>
      )}
    </div>
  );
}

export function InviteArrivalNote({
  invitations,
  seen,
  hidden,
  onViewAll,
}: {
  invitations: ReadonlyArray<Invitation>;
  seen: ReadonlySet<string>;
  /** The menu is open: the menu itself shows the invitation. */
  hidden: boolean;
  onViewAll: () => void;
}) {
  const unseen = invitations.filter((i) => !seen.has(i.id));
  if (hidden || unseen.length === 0) return null;
  // The newest arrival leads; the rest are one tap away in the panel.
  const inv = unseen[unseen.length - 1];
  const name = inv.organizationName ?? "a vault";
  const role = inv.role ? inv.role.charAt(0).toUpperCase() + inv.role.slice(1) : "";
  const others = unseen.length - 1;
  const detail = [role, others > 0 ? `+${others} more` : ""].filter(Boolean).join(" · ");
  return (
    <div className="invite-arrival" role="status">
      <div className="invite-arrival-top">
        <span className="invites-flyout-tile" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase() || "V"}
        </span>
        <span className="invite-arrival-text">
          {inv.inviterName ? (
            <>
              <b>{inv.inviterName}</b> invited you to <b>{name}</b>
            </>
          ) : (
            <>
              You're invited to <b>{name}</b>
            </>
          )}
          {detail && <small>{detail}</small>}
        </span>
        <button
          type="button"
          className="invite-arrival-close"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => saveSeenInvitations(invitations)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="invite-arrival-actions">
        <AsyncButton className="invite-btn accept" spinnerTone="on-accent" replaceLabel onClick={() => acceptInvite(inv)}>
          Accept
        </AsyncButton>
        <button type="button" className="invite-btn decline" onClick={onViewAll}>
          View all
        </button>
      </div>
    </div>
  );
}
