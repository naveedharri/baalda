// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { listBrakeEvents, markBrakeReleased } from "../../versions/brake-events.js";
import { releaseShrinkBrake } from "../../versions/shrink-guard.js";
import { getSession } from "../session.js";

/**
 * The shrink burst brake, as people see it (#252 follow-up).
 *
 *   GET  /api/vaults/:vaultId/shrink-brakes?since=<ISO>
 *        Owners/admins: every hold in the vault. Anyone else: only their own.
 *        `canRelease` says which of the two the caller got.
 *   POST /api/vaults/:vaultId/shrink-brake/:userId/release   (owner/admin)
 *        Lift a member's hold early.
 *
 * Releasing is safe: the held member's app kept every op it made, and they
 * arrive afterwards through the ordinary write paths, where each sharp shrink
 * is still versioned `pre-shrink` before it applies and a renewed burst brakes
 * again. The release reaches every instance (pub/sub, `index.ts`), re-admits
 * the member's sockets writable and clears the notice on their app.
 */

const MANAGER_ROLES = new Set(["owner", "admin"]);
const DEFAULT_DAYS = 30;

export function createShrinkBrakeRoutes(): Hono {
  const routes = new Hono();

  routes.get("/vaults/:vaultId/shrink-brakes", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - DEFAULT_DAYS * 86_400_000);
    if (Number.isNaN(since.getTime())) {
      return c.json({ error: "since must be an ISO date", code: "invalid_since" }, 400);
    }
    const canRelease = MANAGER_ROLES.has(role);
    const items = await listBrakeEvents(vaultId, since, canRelease ? null : session.userId);
    return c.json({ items, canRelease });
  });

  routes.post("/vaults/:vaultId/shrink-brake/:userId/release", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const userId = c.req.param("userId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);
    if (!MANAGER_ROLES.has(role)) {
      return c.json({ error: "Only an owner or admin can release a sync pause", code: "not_manager" }, 403);
    }
    // Rows first, so an Activity refetch triggered by the release already
    // reads them as released.
    const releasedRows = await markBrakeReleased(vaultId, userId, session.userId);
    const heldHere = releaseShrinkBrake(vaultId, userId);
    return c.json({ ok: true, releasedRows, heldHere });
  });

  return routes;
}
