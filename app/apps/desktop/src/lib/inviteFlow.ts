/**
 * The invite-accept flow's pure parts: the pending-invite queue (an invitation
 * that arrived before there was a session, or before the app was pointed at the
 * right server) and the failure-message mapping.
 *
 * Pure and store-free so it unit-tests in node, the `noteLinkFlow` pattern.
 */

import type { InviteDeepLink } from "./inviteLink";

// ---- Pending invite queue --------------------------------------------------
// Module state, not store state — a handoff between two moments of one flow
// (link arrives → session exists), never something the UI renders. The UI reads
// `invitePrompt` in the store instead, which holds the PREVIEW.
//
// Only the latest invite is kept: clicking two invitation links while signed
// out means the second one is the one the person is still waiting on.

let pendingInvite: InviteDeepLink | null = null;

export function queueInvite(invite: InviteDeepLink): void {
  pendingInvite = invite;
}

export function takePendingInvite(): InviteDeepLink | null {
  const invite = pendingInvite;
  pendingInvite = null;
  return invite;
}

/** Read without consuming — for guards that must not eat the invite they check
 *  for (the landing skip in signIn/signUp reads it, acceptance consumes it). */
export function peekPendingInvite(): InviteDeepLink | null {
  return pendingInvite;
}

export function clearPendingInvite(): void {
  pendingInvite = null;
}

// ---- Failure-message mapping -----------------------------------------------

/** Copy shown for an invitation the server will no longer accept. Shared with
 *  the arrival path, which shows it for a 404 preview or a non-pending status
 *  before any accept is attempted — the two must read identically, because to
 *  the person holding the link they are the same situation. */
export const INVITE_GONE_MESSAGE =
  "This invitation has expired or was already used. Ask your admin to send a new one.";

export interface AcceptInviteContext {
  /** The address the invitation was sent to, when we know it (from the
   *  preview). Null when we never got one — then the mismatch copy has to
   *  stay vague rather than name the wrong address. */
  inviteEmail: string | null;
  /** The address the app is signed in as. */
  sessionEmail: string | null;
}

/**
 * Turn an accept-invitation failure into something a person can act on.
 *
 * Better Auth's two messages here are both dead ends as written. "You are not
 * the recipient of the invitation" is really "you are signed in as the wrong
 * account", and the fix (sign out, or ask for an invite to this address) is
 * only obvious once both addresses are on screen next to each other.
 * "Invitation not found" covers expired, already-accepted and revoked alike —
 * we keep them merged, since the server deliberately doesn't distinguish them.
 *
 * Anything else keeps the server's own message: an unrecognised failure that
 * gets rewritten into friendly copy is a failure nobody can debug.
 */
export function acceptInviteFailureMessage(err: unknown, ctx: AcceptInviteContext): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/not the recipient of the invitation/i.test(raw)) {
    const invited = ctx.inviteEmail;
    const current = ctx.sessionEmail;
    if (!invited || !current) {
      return "This invitation was sent to a different email address than the one you're signed in with. Sign out and sign in with the invited address, or ask your admin to invite this one instead.";
    }
    return `This invitation was sent to ${invited}, but you're signed in as ${current}. Sign out and sign in with ${invited}, or ask your admin to invite ${current} instead.`;
  }
  if (/invitation not found/i.test(raw)) return INVITE_GONE_MESSAGE;
  return raw || INVITE_GONE_MESSAGE;
}
