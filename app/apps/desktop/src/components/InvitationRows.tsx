/**
 * Pending vault invitations as rows: the vault, who invited you and the role,
 * then Accept and Decline. Shared by the account menu and Account Settings →
 * Vaults so the copy, buttons, pulse and error handling cannot drift. The menu
 * variant is a plain menu row (icon, name, "from X", two text buttons) so it
 * sits flush with Account settings below it instead of a card in a box.
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { AsyncButton } from "./AsyncButton";
import { MenuIcon } from "./MenuIcon";
import { toast } from "../lib/toast";
import { acceptInviteFailureMessage } from "../lib/inviteFlow";
import {
  loadSeenInvitations,
  saveSeenInvitations,
  unseenInvitations,
} from "../lib/inviteSeen";

type Invitation = ReturnType<typeof useStore.getState>["userInvitations"][number];

/**
 * What was new when the surface mounted keeps its glow for this showing; the
 * seen set is written now (so the identity dot settles) and again whenever the
 * list changes while shown (an arrival during it counts as seen, and answered
 * invitations are pruned).
 */
export function useFreshInvitations(
  invitations: ReadonlyArray<{ id: string }>,
  seen: ReadonlySet<string> = loadSeenInvitations(),
): Set<string> {
  const [freshIds] = useState(() => new Set(unseenInvitations(invitations, seen)));
  useEffect(() => {
    saveSeenInvitations(invitations);
  }, [invitations]);
  return freshIds;
}

// Accepting is: accept → re-read session → roster → switch into the vault →
// bind a folder → reconcile. Easily seconds, hence AsyncButton. It swallows a
// rejection, so a refused accept (a full vault, wrong account) is toasted here.
async function acceptInvite(inv: Invitation): Promise<void> {
  try {
    await useStore.getState().acceptInvitation(inv.id);
  } catch (e) {
    toast(
      acceptInviteFailureMessage(e, {
        inviteEmail: inv.email ?? null,
        sessionEmail: useStore.getState().session?.user.email ?? null,
      }),
      "error",
    );
  }
}

// Declining is a real answer, and without it the only way to clear the row is
// to join a vault you were never joining.
async function declineInvite(inv: Invitation): Promise<void> {
  try {
    await authManager.api.rejectInvitation(inv.id);
  } finally {
    await useStore.getState().refreshVault();
  }
}

export function InvitationRows({
  invitations,
  freshIds,
  variant = "list",
}: {
  invitations: ReadonlyArray<Invitation>;
  freshIds: ReadonlySet<string>;
  /** "menu": flat account-menu rows. "list": Account Settings → Vaults. */
  variant?: "menu" | "list";
}) {
  if (variant === "menu") {
    return (
      <>
        {invitations.map((inv) => {
          const role = inv.role && inv.role !== "member" ? inv.role : null;
          const from = inv.inviterName ? `from ${inv.inviterName}` : "";
          const hint = [from, role ? role.charAt(0).toUpperCase() + role.slice(1) : ""]
            .filter(Boolean)
            .join(" · ");
          const name = inv.organizationName ?? "A vault";
          return (
            <div
              key={inv.id}
              className={`menu-item invite-menu-row${freshIds.has(inv.id) ? " is-new" : ""}`}
              title={hint ? `Invitation to ${name}, ${hint}` : `Invitation to ${name}`}
            >
              <span className="invite-menu-icon">
                <MenuIcon>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </MenuIcon>
              </span>
              <span className="menu-item-label">{name}</span>
              {hint && <span className="menu-hint">{hint}</span>}
              <span className="invite-menu-actions">
                <AsyncButton
                  className="link-btn invite-menu-btn"
                  spinnerTone="accent"
                  replaceLabel
                  onClick={() => acceptInvite(inv)}
                >
                  Accept
                </AsyncButton>
                <AsyncButton
                  className="link-btn invite-menu-btn decline"
                  spinnerTone="neutral"
                  replaceLabel
                  onClick={() => declineInvite(inv)}
                >
                  Decline
                </AsyncButton>
              </span>
            </div>
          );
        })}
      </>
    );
  }
  return (
    <>
      {invitations.map((inv) => (
        <div key={inv.id} className={`invite-row${freshIds.has(inv.id) ? " is-new" : ""}`}>
          {/* The vault's NAME and the inviter's, not "Vault invitation" with
              an org id hidden in a title attribute — nobody recognises a
              vault by its id, and this row is the whole basis for deciding
              whether to accept. Both fields come from our own
              /api/invitations/mine; Better Auth's fallback route has
              neither, hence the plain-language defaults. Accept already
              says what happens, so the title is just the vault. */}
          <span className="invite-row-meta">
            <span className="invite-row-title">{inv.organizationName ?? "A vault"}</span>
            <span className="muted">
              {inv.inviterName ? `Invited by ${inv.inviterName} · ` : ""}
              <span className="invite-row-role">{inv.role}</span>
            </span>
          </span>
          <AsyncButton className="primary sm" onClick={() => acceptInvite(inv)}>
            Accept
          </AsyncButton>
          <AsyncButton className="ghost-pill sm" onClick={() => declineInvite(inv)}>
            Decline
          </AsyncButton>
        </div>
      ))}
    </>
  );
}
