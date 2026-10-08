/**
 * Pending vault invitations as rows: the vault, who invited you and the role,
 * then Accept and Decline. Shared by the account menu and Account Settings →
 * Vaults so the copy, buttons, pulse and error handling cannot drift.
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

export function InvitationRows({
  invitations,
  freshIds,
}: {
  invitations: ReadonlyArray<Invitation>;
  freshIds: ReadonlySet<string>;
}) {
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
          {/* Accepting is: accept → re-read session → roster → switch into
              the vault → bind a folder → reconcile. Easily seconds, and it
              used to be a bare fire-and-forget click with no acknowledgement
              of any kind. */}
          <AsyncButton
            className="primary sm"
            onClick={async () => {
              // AsyncButton swallows a rejection, so a refused accept (a
              // full vault, wrong account) used to do nothing visible.
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
            }}
          >
            Accept
          </AsyncButton>
          {/* Declining is a real answer, and without it the only way to
              clear the row is to join a vault you were never joining. */}
          <AsyncButton
            className="ghost-pill sm"
            onClick={async () => {
              try {
                await authManager.api.rejectInvitation(inv.id);
              } finally {
                await useStore.getState().refreshVault();
              }
            }}
          >
            Decline
          </AsyncButton>
        </div>
      ))}
    </>
  );
}
