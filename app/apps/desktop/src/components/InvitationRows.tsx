/**
 * Pending vault invitations as rows: the vault, who invited you and the role,
 * then Accept and Decline. Shared by the account menu's Invitations panel and
 * Account Settings → Vaults so the copy, buttons, pulse and error handling
 * cannot drift. The flyout variant is one compact row per invitation (letter
 * tile, vault, "Inviter · Role", Decline and Accept) for the panel that opens
 * beside the menu's Invitations row.
 */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { AsyncButton } from "./AsyncButton";
import { toast } from "../lib/toast";
import { acceptInviteFailureMessage } from "../lib/inviteFlow";
import {
  loadSeenInvitations,
  saveSeenInvitations,
  unseenInvitations,
} from "../lib/inviteSeen";

export type Invitation = ReturnType<typeof useStore.getState>["userInvitations"][number];

/** "Naveed · Admin": who asked and, when it is not plain member, the role. */
export function invitationHint(inv: Invitation): string {
  const role = inv.role && inv.role !== "member" ? inv.role : null;
  return [inv.inviterName ?? "", role ? role.charAt(0).toUpperCase() + role.slice(1) : ""]
    .filter(Boolean)
    .join(" · ");
}

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
export async function acceptInvite(inv: Invitation): Promise<void> {
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
export async function declineInvite(inv: Invitation): Promise<void> {
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
  /** "flyout": the account menu's Invitations panel. "list": Account Settings → Vaults. */
  variant?: "flyout" | "list";
}) {
  if (variant === "flyout") {
    return (
      <>
        {invitations.map((inv) => {
          const hint = invitationHint(inv);
          const name = inv.organizationName ?? "A vault";
          return (
            <div
              key={inv.id}
              className={`invites-flyout-row${freshIds.has(inv.id) ? " is-new" : ""}`}
              title={hint ? `Invitation to ${name}, ${hint}` : `Invitation to ${name}`}
            >
              <span className="invites-flyout-tile" aria-hidden="true">
                {name.trim().charAt(0).toUpperCase() || "V"}
              </span>
              <span className="invites-flyout-meta">
                <span className="invites-flyout-name">{name}</span>
                {hint && <span className="invites-flyout-hint">{hint}</span>}
              </span>
              <span className="invites-flyout-actions">
                <AsyncButton
                  className="invite-btn decline"
                  spinnerTone="neutral"
                  replaceLabel
                  onClick={() => declineInvite(inv)}
                >
                  Decline
                </AsyncButton>
                <AsyncButton
                  className="invite-btn accept"
                  spinnerTone="on-accent"
                  replaceLabel
                  onClick={() => acceptInvite(inv)}
                >
                  Accept
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
