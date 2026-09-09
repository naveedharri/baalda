import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { getSession } from "../session.js";
import {
  invitationJson,
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
 */
export const invitationRoutes = new Hono();

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

invitationRoutes.get("/invitations/mine", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const rows = await listPendingInvitationsFor(pool, session.email);
  return c.json(rows.map(invitationJson));
});

invitationRoutes.get("/invitations/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Malformed invitation id" }, 400);
  const inv = await loadInvitation(pool, id);
  if (!inv) return c.json({ error: "Invitation not found" }, 404);
  return c.json(invitationJson(inv));
});
