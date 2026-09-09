import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { config } from "../../config.js";
import { emailEnabled, sendMail } from "../../email/mailer.js";
import { invitationEmail } from "../../email/templates.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import {
  invitationJson,
  invitationState,
  listPendingInvitationsFor,
  loadInvitation,
} from "../../registry/invitations.js";

/**
 * Invitation read endpoints the desktop uses around Better Auth's own
 * invite/accept/cancel routes (issue #99):
 *
 *  - GET /api/invitations/:id/preview  (public) — what an invite link points
 *    at, so the app can greet the invitee by vault name and prefill the email
 *    BEFORE they have an account. An invitation id is an unguessable Better
 *    Auth id that only ever reaches the invitee's mailbox, and the page/email
 *    that carried it already showed everything returned here.
 *
 *  - GET /api/invitations/mine (session) — pending invitations addressed to the
 *    signed-in user's email. Better Auth's `list-user-invitations` exists for
 *    this but answers 403 for any user whose email is not verified — which was
 *    every password sign-up — so the in-app invite inbox was silently empty for
 *    almost everyone. Membership actions still go through Better Auth (accept
 *    checks the invitation's email against the session's).
 *
 *  - POST /api/invitations/:id/send (owner/admin) — email the invitation link
 *    and REPORT the outcome: 200 { sent: true }, 502 { error: "send_failed",
 *    message }, 400 { error: "email_not_configured" }, 410 when it is no longer
 *    pending. Deliberately not a Better Auth `sendInvitationEmail` hook: that
 *    runs after the row is created and swallows send errors, so the admin would
 *    see "Invitation emailed" for mail that never left. The desktop calls this
 *    right after invite-member and falls back to the copyable link on failure.
 */
export const invitationRoutes = new Hono();

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

invitationRoutes.get("/invitations/mine", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const rows = await listPendingInvitationsFor(pool, session.email);
  return c.json(rows.map(invitationJson));
});

invitationRoutes.post("/invitations/:id/send", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Malformed invitation id" }, 400);
  const inv = await loadInvitation(pool, id);
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
  const role = await orgRole(inv.organizationId, session.userId);
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Only the vault owner or an admin can send invitations" }, 403);
  }
  if (!emailEnabled()) {
    return c.json(
      { error: "email_not_configured", message: "This server doesn't send email. Share the invitation link instead." },
      400,
    );
  }
  if (invitationState(inv) !== "pending") {
    return c.json({ error: "invitation_not_pending", message: "This invitation is no longer pending." }, 410);
  }
  const url = `${config.betterAuthUrl}/invite/${encodeURIComponent(inv.id)}`;
  try {
    await sendMail(
      invitationEmail({
        to: inv.email,
        url,
        organizationName: inv.organizationName,
        inviterName: inv.inviterName,
        role: inv.role ?? "member",
        expiresAt: inv.expiresAt,
      }),
    );
  } catch (err) {
    console.error(`[email] invitation to ${inv.email} failed:`, err);
    return c.json(
      { error: "send_failed", message: `The mail provider refused the message: ${(err as Error).message}` },
      502,
    );
  }
  return c.json({ sent: true });
});

invitationRoutes.get("/invitations/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Malformed invitation id" }, 400);
  const inv = await loadInvitation(pool, id);
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
  return c.json(invitationJson(inv));
});
