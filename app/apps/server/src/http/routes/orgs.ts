import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { canAddMember } from "../../billing/entitlements.js";
import { billingEnabled } from "../../config.js";
import type { BillingProvider } from "../../billing/provider.js";

/**
 * Workspace (org) routes (session-authenticated).
 *
 *  - GET    /api/orgs/join-code → owner/admin fetch (lazily generates) the code
 *    for their active workspace, so they can share it.
 *  - POST   /api/orgs/join {code} → any signed-in user redeems a code and becomes
 *    a 'member' of that workspace (idempotent if already a member).
 *  - DELETE /api/orgs/:orgId → the workspace **owner** permanently deletes the
 *    workspace everywhere: members, invitations, vaults, folders, notes, files,
 *    shares, join codes, and MCP tokens cascade from the `organization` row;
 *    the binary CRDT stores and derived caches (which have no FK) are purged by
 *    hand first. Non-owners cannot delete — they just remove it from their
 *    device client-side.
 */
export interface OrgDeps {
  /** Force-close live sync sockets for a doc (so a purge isn't re-populated). */
  disconnectDoc: (vaultId: string, docId: string) => void;
  /** Billing provider for best-effort subscription cancellation on org delete.
   *  Absent (self-host / billing off) ⇒ deletion just relies on FK cascade. */
  billingProvider?: BillingProvider;
}

// Crockford-style base32 alphabet: no ambiguous 0/O/1/I. 32 symbols.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

/** An 8-char uppercase code from crypto-random bytes (no ambiguous chars). */
function generateCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * The workspace this user is acting in: the session's active org, else their
 * sole membership. Returns null when it can't be determined unambiguously.
 */
async function resolveActiveOrg(
  userId: string,
  activeOrganizationId: string | null,
): Promise<string | null> {
  if (activeOrganizationId) return activeOrganizationId;
  const { rows } = await pool.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

export function createOrgRoutes(deps: OrgDeps): Hono {
  const orgRoutes = new Hono();

  // Fetch (or lazily generate) the join code for the caller's active workspace.
  orgRoutes.get("/orgs/join-code", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active workspace" }, 400);

    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only workspace owner/admin can view the join code" }, 403);
    }

    const existing = await pool.query<{ code: string }>(
      "SELECT code FROM org_join_codes WHERE organization_id = $1",
      [org],
    );
    if (existing.rows[0]) return c.json({ code: existing.rows[0].code });

    // Lazily generate + persist. Retry on the (unlikely) unique-code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        const { rows } = await pool.query<{ code: string }>(
          `INSERT INTO org_join_codes (organization_id, code) VALUES ($1, $2)
           ON CONFLICT (organization_id) DO NOTHING
           RETURNING code`,
          [org, code],
        );
        if (rows[0]) return c.json({ code: rows[0].code });
        // Another request generated the code first — read it back.
        const raced = await pool.query<{ code: string }>(
          "SELECT code FROM org_join_codes WHERE organization_id = $1",
          [org],
        );
        if (raced.rows[0]) return c.json({ code: raced.rows[0].code });
      } catch (err) {
        // Unique violation on `code` (23505): loop and try a fresh code.
        if ((err as { code?: string }).code !== "23505") throw err;
      }
    }
    return c.json({ error: "Could not generate a join code" }, 500);
  });

  // Redeem a join code: join the workspace as a 'member' (idempotent).
  orgRoutes.post("/orgs/join", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!code) return c.json({ error: "code is required" }, 400);

    const { rows } = await pool.query<{ organization_id: string; name: string }>(
      `SELECT j.organization_id, o.name
         FROM org_join_codes j JOIN organization o ON o.id = j.organization_id
        WHERE j.code = $1`,
      [code],
    );
    const target = rows[0];
    if (!target) return c.json({ error: "Unknown join code" }, 404);

    const organizationId = target.organization_id;
    if (await orgRole(organizationId, session.userId)) {
      return c.json({ organizationId, name: target.name, alreadyMember: true });
    }

    // Free-tier seat cap. This path bypasses Better Auth entirely, so the same
    // limit the invite hook enforces must be checked here before the INSERT.
    // No-op when billing is off (canAddMember returns allowed).
    const seat = await canAddMember(organizationId);
    if (!seat.allowed) {
      return c.json({ error: "member_limit_reached", limit: seat.limit }, 402);
    }

    await pool.query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'member', now())`,
      [randomUUID(), organizationId, session.userId],
    );
    return c.json({ organizationId, name: target.name, alreadyMember: false });
  });

  // Permanently delete a workspace (owner only). Everything with a FK to the
  // organization cascades; the FK-less binary CRDT stores and rebuildable caches
  // are purged by hand. We snapshot the affected doc/vault ids BEFORE the delete
  // (the cascade removes the `notes`/`files` rows we'd read them from) and kill
  // live sockets first so an in-flight sync can't re-append rows we just purged.
  orgRoutes.delete("/orgs/:orgId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "Unknown workspace" }, 404);
    if (role !== "owner") {
      return c.json({ error: "Only the workspace owner can delete it" }, 403);
    }

    const vaults = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [orgId],
    );
    const vaultIds = vaults.rows.map((r) => r.id);

    const docs = vaultIds.length
      ? await pool.query<{ id: string; vault_id: string }>(
          `SELECT id, vault_id FROM notes WHERE vault_id = ANY($1)
           UNION ALL
           SELECT id, vault_id FROM files WHERE vault_id = ANY($1)`,
          [vaultIds],
        )
      : { rows: [] as Array<{ id: string; vault_id: string }> };
    const docIds = docs.rows.map((r) => r.id);

    // Instant-kill live sockets so onChange can't resurrect purged doc_updates.
    for (const d of docs.rows) deps.disconnectDoc(d.vault_id, d.id);

    // Best-effort: cancel any live subscription at the provider so we don't keep
    // billing a deleted workspace. The subscriptions row itself is removed by FK
    // cascade below; a provider failure must NOT block the delete (log + carry on).
    if (billingEnabled() && deps.billingProvider) {
      const sub = await pool.query<{ provider_subscription_id: string | null }>(
        "SELECT provider_subscription_id FROM subscriptions WHERE organization_id = $1",
        [orgId],
      );
      const subId = sub.rows[0]?.provider_subscription_id;
      if (subId) {
        try {
          await deps.billingProvider.cancelSubscription(subId);
        } catch (err) {
          console.error(
            `org-delete: failed to cancel subscription ${subId} for org ${orgId}:`,
            (err as Error).message,
          );
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (docIds.length) {
        await client.query("DELETE FROM doc_updates WHERE doc_id = ANY($1)", [docIds]);
        await client.query("DELETE FROM doc_snapshots WHERE doc_id = ANY($1)", [docIds]);
      }
      await client.query("DELETE FROM blobs WHERE workspace_id = $1", [orgId]);
      if (vaultIds.length) {
        await client.query("DELETE FROM note_index WHERE vault_id = ANY($1)", [vaultIds]);
        await client.query("DELETE FROM note_links WHERE vault_id = ANY($1)", [vaultIds]);
      }
      // Cascades: member, invitation, vaults→(folders, notes, files), shares,
      // org_join_codes, mcp_tokens.
      await client.query("DELETE FROM organization WHERE id = $1", [orgId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return c.json({ deleted: true, vaults: vaultIds.length, docs: docIds.length });
  });

  // Remove a member from a workspace (owner/admin). Revokes access on both paths
  // that would otherwise let a departed member keep reading org data:
  //   1. delete the `member` row — their org-wide "Open" grant stops applying
  //      (the resolver gates it on membership) and the next sync-token mint 403s;
  //   2. purge their per-user shares — those are NOT membership-gated, so a folder
  //      or file shared directly to them would survive step 1 (see issue #16);
  //   3. force-close live sockets so access dies now, not at token expiry.
  // Owner can remove anyone but themselves; an admin can remove only plain members
  // (not another admin or the owner). Self-removal ("leave") is intentionally not
  // supported here yet.
  orgRoutes.delete("/orgs/:orgId/members/:userId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");

    const callerRole = await orgRole(orgId, session.userId);
    if (!callerRole) return c.json({ error: "Unknown workspace" }, 404);
    if (callerRole !== "owner" && callerRole !== "admin") {
      return c.json({ error: "Only the workspace owner or an admin can remove members" }, 403);
    }
    if (targetUserId === session.userId) {
      return c.json({ error: "You can't remove yourself from the workspace" }, 400);
    }

    const targetRole = await orgRole(orgId, targetUserId);
    if (!targetRole) return c.json({ error: "That person isn't a member of this workspace" }, 404);
    if (targetRole === "owner") {
      return c.json({ error: "The workspace owner can't be removed" }, 403);
    }
    if (targetRole === "admin" && callerRole !== "owner") {
      return c.json({ error: "Only the owner can remove an admin" }, 403);
    }

    // Snapshot the org's docs so we can kill any live sockets the removed member
    // holds. closeConnections on a doc with no live socket is a cheap no-op, so
    // covering every doc in the org is fine (member removal is rare).
    const vaults = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [orgId],
    );
    const vaultIds = vaults.rows.map((r) => r.id);
    const docs = vaultIds.length
      ? await pool.query<{ id: string; vault_id: string }>(
          `SELECT id, vault_id FROM notes WHERE vault_id = ANY($1)
           UNION ALL
           SELECT id, vault_id FROM files WHERE vault_id = ANY($1)`,
          [vaultIds],
        )
      : { rows: [] as Array<{ id: string; vault_id: string }> };

    // Drop membership + direct grants together. `shares.workspace_id` scopes the
    // purge to this org; shares the member *created for others* (created_by) are
    // untouched — only grants TO this user (principal_id) are removed.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
        [orgId, targetUserId],
      );
      await client.query(
        `DELETE FROM shares
          WHERE workspace_id = $1 AND principal_type = 'user' AND principal_id = $2`,
        [orgId, targetUserId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Membership is gone, so a reconnect now fails at token mint (403). Kick the
    // live sockets AFTER the delete so the auto-reconnect can't re-mint a token.
    for (const d of docs.rows) deps.disconnectDoc(d.vault_id, d.id);

    return c.json({ removed: true });
  });

  return orgRoutes;
}
