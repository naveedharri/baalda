import { Hono } from "hono";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { mintVaultToken } from "../../tokens/vault-token.js";
import { getSession } from "../session.js";

/**
 * POST /api/vault-sync-token  { vaultId }  (spec 05 §7)
 *
 * Mints a vault-scoped JWT for the replication channel. Any member of the
 * vault's workspace may obtain one; the channel then streams only the docs the
 * user can actually read (per-doc ACL on backfill + fanout). Non-members: 403.
 */
export const vaultTokenRoutes = new Hono();

vaultTokenRoutes.post("/vault-sync-token", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  let body: { vaultId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const vaultId = body.vaultId;
  if (typeof vaultId !== "string" || vaultId.length === 0) {
    return c.json({ error: "vaultId is required" }, 400);
  }

  const organizationId = await vaultOrg(vaultId);
  if (!organizationId) return c.json({ error: "Unknown vault" }, 404);

  const role = await orgRole(organizationId, session.userId);
  if (!role) return c.json({ error: "No access to this vault" }, 403);

  const token = await mintVaultToken({ userId: session.userId, vaultId });
  return c.json({ token, vaultId });
});
