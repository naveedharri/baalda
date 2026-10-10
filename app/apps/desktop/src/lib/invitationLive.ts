/**
 * Live invitations. The server sends `invitation` / `invitation-gone` frames
 * addressed to the signed-in USER over whatever vault channel is open
 * (`invitations` cap, server `sync/user-events.ts`), so an invitation to a vault
 * the user is not in yet appears within a second instead of on the next reload.
 *
 * The frame is only a hint: an arrival re-reads the user's invitation list
 * through the normal GET so the row keeps its canonical shape. It lands as an
 * id the seen-set has never held, so the account menu's unseen pulse fires as
 * for any new invitation.
 *
 * With no vault channel open (signed in, nothing synced) there is no frame, so
 * the fallback polls every 60 s while the window is focused, and on focus.
 */

export type InvitationFrame =
  | {
      t: "invitation";
      invitationId: string;
      orgId: string;
      orgName: string;
      inviterName: string;
      role: string;
    }
  | { t: "invitation-gone"; invitationId: string };

export type InvitationAction = { kind: "refresh" } | { kind: "drop"; invitationId: string };

/** Which store action a frame calls for. Pure. */
export function invitationFrameAction(frame: { t: string; invitationId?: unknown }): InvitationAction | null {
  if (typeof frame.invitationId !== "string" || !frame.invitationId) return null;
  if (frame.t === "invitation") return { kind: "refresh" };
  if (frame.t === "invitation-gone") return { kind: "drop", invitationId: frame.invitationId };
  return null;
}

/** Fallback poll period when no vault channel can deliver the frame. */
export const INVITATION_POLL_MS = 60_000;

/** True when no vault channel is live to deliver invitation frames. */
export function needsInvitationPoll(vaultSyncStatus: string): boolean {
  return vaultSyncStatus !== "synced" && vaultSyncStatus !== "read-only";
}

// The store wires the real handler (components/useLiveInvitations.ts); the
// sync engine only relays, so it never imports the store.
let handler: ((frame: InvitationFrame) => void) | null = null;

export function setInvitationFrameHandler(fn: ((frame: InvitationFrame) => void) | null): void {
  handler = fn;
}

/** Called by the vault sync engine for every invitation frame. */
export function notifyInvitationFrame(frame: InvitationFrame): void {
  handler?.(frame);
}
