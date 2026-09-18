import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { canAddMember } from "../../billing/entitlements.js";
import {
  applySubscriptionState,
  findByOrg,
  isActiveStatus,
} from "../../billing/store.js";
import { announceMemberJoined } from "../../sync/member-events.js";
import { billingEnabled } from "../../config.js";
import { dispatchMail, emailEnabled } from "../../email/mailer.js";
import { memberLeftEmail, youLeftVaultEmail } from "../../email/templates.js";
import type { BillingProvider } from "../../billing/provider.js";

/**
 * Vault (org) routes (session-authenticated).
 *
 *  - GET    /api/orgs/join-code → owner/admin fetch (lazily generates) the code
 *    for their active vault, so they can share it.
 *  - POST   /api/orgs/join {code} → any signed-in user redeems a code and becomes
 *    a 'member' of that vault (idempotent if already a member). A pending email
 *    invitation for the same address is consumed on the way in — same role,
 *    same end state as accepting it.
 *  - POST   /api/orgs/:orgId/leave → a **member or admin** removes themselves
 *    from a vault they don't own (#121). Same teardown as being removed by an
 *    admin — membership row, direct shares, live sockets — plus the leaver's
 *    sessions stop pointing at the vault, and the owner and the leaver are each
 *    emailed when the server can send mail. The owner gets 409
 *    `owner_cannot_leave`: their exit is DELETE below (or, one day, a transfer).
 *  - GET    /api/orgs/:orgId/status → any member asks whether a vault still
 *    exists and whether they may see it. 404 `vault_not_found` (gone) vs 403
 *    `not_a_member` (someone else's) — the two states a stamped folder cannot
 *    otherwise tell apart.
 *  - GET    /api/orgs/:orgId/unsync-preview → owner-only counts of everything
 *    "make local only" would destroy, so the confirm dialog names real numbers.
 *  - POST   /api/orgs/:orgId/unsync {confirmName} → owner-only "make this vault
 *    local only": the SAME teardown as DELETE below (one shared helper, so the
 *    two cannot drift), behind a type-the-name check (409 `name_mismatch`).
 *    The client keeps its `.md` files and clears its vault stamp.
 *  - DELETE /api/orgs/:orgId → the vault **owner** permanently deletes the
 *    vault everywhere: members, invitations, note collections, folders, notes, files,
 *    shares, join codes, and MCP tokens cascade from the `organization` row;
 *    the binary CRDT stores and derived caches (which have no FK) are purged by
 *    hand first. Non-owners cannot delete — they just remove it from their
 *    device client-side.
 *
 *    A paid vault stops billing FIRST, and the delete is abandoned if the
 *    provider won't confirm it (502 `subscription_cancel_failed`) — a provider
 *    outage used to delete the vault anyway and leave Polar charging for
 *    something nobody could see (#109/#111). The `subscriptions` row then
 *    SURVIVES the delete as a tombstone (`deleted_at` set, vault name + owner
 *    snapshotted) so the owner can still cancel or transfer it from Billing,
 *    and so a webhook arriving afterwards has somewhere to land.
 */
export interface OrgDeps {
  /** Force-close live sync sockets for a doc (so a purge isn't re-populated). */
  disconnectDoc: (vaultId: string, docId: string) => void;
  /**
   * Access in this collection changed — subscribers re-resolve their readable-doc
   * set on the vault channel.
   *
   * Required here, not optional, because `disconnectDoc` only covers HALF of a
   * removal. It kills per-doc Hocuspocus sockets; the removed member's
   * **vault-channel** socket is untouched, and there is no `disconnectDoc`
   * equivalent for it. That connection holds a `readable` set frozen at hello
   * time, so without this it keeps receiving every doc update in the vault until
   * the socket drops or their vault token expires (`SYNC_TOKEN_TTL_SECONDS`,
   * 600s by default). Firing this makes the channel recompute the set — empty for
   * a non-member with no shares — and drop every doc immediately.
   */
  onAclChanged: (vaultId: string) => void;
  /**
   * Billing provider, used to STOP a paid vault's subscription before the vault
   * is deleted. NOT best-effort any more: if the provider refuses, the delete
   * refuses too (#109/#111). Deleting a vault whose subscription is still live
   * leaves someone paying for something they can no longer see, and — with the
   * row gone — no way for anyone to notice or retry.
   *
   * Absent (self-host / billing off) ⇒ there is nothing to cancel, and deletion
   * relies on the FK cascade alone.
   */
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
 * The vault this user is acting in: the session's active org, else their
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

/**
 * Take one user out of a vault. Shared by "admin removes a member" and "a member
 * leaves" so the two can never drift — every hole this closes was found once
 * already (#16):
 *   1. delete the `member` row — their org-wide "Open" grant stops applying
 *      (the resolver gates it on membership) and the next sync-token mint 403s;
 *   2. purge their per-user shares — those are NOT membership-gated, so a folder
 *      or file shared directly to them would survive step 1;
 *   3. clear the vault from any of their sessions that had it active, so a
 *      device of theirs that reloads doesn't come back asking for a vault it
 *      can't see;
 *   4. force-close live sockets so access dies now, not at token expiry.
 *
 * Shares the user *created for others* (`created_by`) are untouched — only
 * grants TO this user (`principal_id`) go.
 */
async function revokeMembership(deps: OrgDeps, orgId: string, userId: string): Promise<void> {
  // Snapshot the org's docs so we can kill any live sockets the departing
  // member holds. closeConnections on a doc with no live socket is a cheap
  // no-op, so covering every doc in the org is fine (this is rare).
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
      orgId,
      userId,
    ]);
    await client.query(
      `DELETE FROM shares
        WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2`,
      [orgId, userId],
    );
    await client.query(
      `UPDATE session SET "activeOrganizationId" = NULL
        WHERE "userId" = $1 AND "activeOrganizationId" = $2`,
      [userId, orgId],
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
  // …and tell the vault channel, which `disconnectDoc` cannot reach. Also after
  // the commit, deliberately: the channel answers by re-running
  // `listReadableDocsInVault`, which has to see the post-delete state to
  // conclude the departed member may now read nothing.
  for (const vaultId of vaultIds) deps.onAclChanged(vaultId);
}

/**
 * What a vault holds, server-side, as plain counts.
 *
 * ONE shape produced by ONE query set, shared by the unsync preview and the
 * unsync receipt, so the numbers an owner is shown in the confirm dialog are
 * the numbers the teardown then reports. A preview that counted differently
 * from the thing it previews is a lie at exactly the moment it matters.
 *
 * `members` EXCLUDES the owner: the sentence these feed is "N teammates lose
 * access", and the owner is not one of them.
 */
export interface VaultContentCounts {
  notes: number;
  files: number;
  folders: number;
  attachmentBytes: number;
  members: number;
  publicLinks: number;
  mcpTokens: number;
  checkpoints: number;
}

/**
 * The subscription facts a client needs to explain what happens to the money.
 * Dates are ISO strings because this crosses the wire.
 */
export interface SubscriptionEcho {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** `count(*)` as a number — pg returns bigint as a string. */
async function countOf(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(sql, params);
  return Number(rows[0]?.c ?? 0);
}

/**
 * Count everything the server holds for one vault (org). Pure SELECTs — safe to
 * call from a preview that must not change anything.
 *
 * Scoped two ways on purpose: the org id for rows that hang off the
 * organization (members, public links, MCP tokens, blobs), the collection ids
 * for rows that hang off a `vaults` row. Those are the same two scopes the
 * teardown deletes by, which is what keeps the two in step.
 */
async function countVaultContents(
  orgId: string,
  vaultIds: string[],
): Promise<VaultContentCounts> {
  const byVault = (sql: string) => (vaultIds.length ? countOf(sql, [vaultIds]) : Promise.resolve(0));
  const [notes, files, folders, checkpoints, attachmentBytes, members, publicLinks, mcpTokens] =
    await Promise.all([
      // Soft-deleted notes are already gone as far as any client is concerned,
      // so they must not inflate the "412 notes" the dialog promises to delete.
      byVault("SELECT count(*)::bigint AS c FROM notes WHERE vault_id = ANY($1) AND deleted_at IS NULL"),
      byVault("SELECT count(*)::bigint AS c FROM files WHERE vault_id = ANY($1)"),
      byVault("SELECT count(*)::bigint AS c FROM folders WHERE vault_id = ANY($1)"),
      byVault("SELECT count(*)::bigint AS c FROM vault_checkpoints WHERE vault_id = ANY($1)"),
      // `blobs.org_id` covers BOTH kinds of blob — a tree file's bytes and a
      // hash-named `attachments/` drop, which has no vault_id.
      countOf("SELECT coalesce(sum(size), 0)::bigint AS c FROM blobs WHERE org_id = $1", [orgId]),
      countOf(
        `SELECT count(*)::bigint AS c FROM member WHERE "organizationId" = $1 AND role <> 'owner'`,
        [orgId],
      ),
      countOf("SELECT count(*)::bigint AS c FROM public_links WHERE org_id = $1", [orgId]),
      countOf("SELECT count(*)::bigint AS c FROM mcp_tokens WHERE organization_id = $1", [orgId]),
    ]);
  return { notes, files, folders, attachmentBytes, members, publicLinks, mcpTokens, checkpoints };
}

/** A stored subscription as the wire sees it; a tombstone reads as "none". */
function echoSubscriptionRow(
  row: { status: string; current_period_end: Date | null; cancel_at_period_end: boolean; deleted_at: Date | null } | null,
): SubscriptionEcho | null {
  if (!row || row.deleted_at) return null;
  return {
    status: row.status,
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export type VaultTeardown =
  | {
      ok: true;
      orgName: string | null;
      vaultIds: string[];
      docIds: string[];
      counts: VaultContentCounts;
      subscription: SubscriptionEcho | null;
    }
  | { ok: false; error: "subscription_cancel_failed"; message: string };

/**
 * Remove a vault from the server, completely. THE one teardown.
 *
 * Extracted so `DELETE /api/orgs/:orgId` (permanent delete) and
 * `POST /api/orgs/:orgId/unsync` ("make local only") run the SAME code: the two
 * differ only in what the client does with its own files afterwards, and a
 * second hand-written purge would drift from this one's table list the first
 * time a table is added.
 *
 * Order is load-bearing:
 *   1. money first — a provider that won't cancel aborts the whole thing (502),
 *      before anything is destroyed (#109/#111);
 *   2. snapshot vault/doc ids and the counts BEFORE the cascade removes the
 *      rows we'd read them from;
 *   3. kill live sockets so `onChange` can't re-append rows we're about to purge;
 *   4. one transaction for the FK-less stores, the session pointers, the
 *      subscription tombstone and the `organization` row;
 *   5. `onAclChanged` per collection AFTER the commit — the vault channel
 *      answers by re-resolving the readable set and must see the final state.
 *
 * The caller does the authz. This function assumes it has already happened.
 */
async function deleteVaultEverywhere(
  deps: OrgDeps,
  orgId: string,
  actorUserId: string,
): Promise<VaultTeardown> {
  const { rows: orgNameRows } = await pool.query<{ name: string }>(
    "SELECT name FROM organization WHERE id = $1",
    [orgId],
  );
  const orgName = orgNameRows[0]?.name ?? null;

  // Stop the money BEFORE anything is destroyed. `period_end` keeps the paid
  // period the owner already bought; if the provider refuses we abandon the
  // whole teardown with 502 rather than leave a live subscription that nothing
  // records (#109/#111). This deliberately runs ahead of the socket teardown
  // and the purge, so a 502 here costs nothing.
  let subscription: SubscriptionEcho | null = null;
  if (billingEnabled() && deps.billingProvider) {
    const row = await findByOrg(pool, orgId);
    const subId = row?.provider_subscription_id;
    if (row && subId && isActiveStatus(row.status)) {
      // Always ask, even when our row already says "ending": the flag is
      // idempotent at the provider, and our copy can be stale — an owner who
      // un-cancelled in Polar's portal while that webhook went missing would
      // otherwise have the vault deleted and the subscription still renewing.
      // The provider's answer is what we record and report.
      try {
        const snap = await deps.billingProvider.cancelSubscription(subId, "period_end");
        // The provider's answer IS the state — persist it through the same
        // upsert (and the same ordering guard) the webhook uses, so a
        // webhook describing this very change can't fight it.
        await applySubscriptionState(pool, {
          organizationId: orgId,
          providerCustomerId: snap.providerCustomerId,
          providerSubscriptionId: snap.providerSubscriptionId,
          plan: "pro",
          status: snap.status,
          currentPeriodEnd: snap.currentPeriodEnd,
          cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
          eventTs: snap.modifiedAt,
          interval: snap.interval,
          amount: snap.amount,
          currency: snap.currency,
        });
        subscription = {
          status: snap.status,
          cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
          currentPeriodEnd: snap.currentPeriodEnd ? snap.currentPeriodEnd.toISOString() : null,
        };
      } catch (err) {
        console.error(
          `vault-teardown: refusing to remove vault ${orgId} — the provider would not cancel subscription ${subId}:`,
          (err as Error).message,
        );
        return {
          ok: false,
          error: "subscription_cancel_failed",
          message: (err as Error).message || "provider cancel failed",
        };
      }
    }
  }

  // `vaults` here = the org's note-collection rows (storage children), not the
  // user-facing vault (the organization) being removed.
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

  const counts = await countVaultContents(orgId, vaultIds);

  // Instant-kill live sockets so onChange can't resurrect purged doc_updates.
  for (const d of docs.rows) deps.disconnectDoc(d.vault_id, d.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (docIds.length) {
      await client.query("DELETE FROM doc_updates WHERE doc_id = ANY($1)", [docIds]);
      await client.query("DELETE FROM doc_snapshots WHERE doc_id = ANY($1)", [docIds]);
      // The cached state vectors describe state that no longer exists; leaving
      // them would have a recreated doc_id inherit a stranger's clocks.
      await client.query("DELETE FROM doc_state_vectors WHERE doc_id = ANY($1)", [docIds]);
    }
    await client.query("DELETE FROM blobs WHERE org_id = $1", [orgId]);
    if (vaultIds.length) {
      await client.query("DELETE FROM note_index WHERE vault_id = ANY($1)", [vaultIds]);
      await client.query("DELETE FROM note_links WHERE vault_id = ANY($1)", [vaultIds]);
    }
    // `session."activeOrganizationId"` has no FK, so the cascade below leaves
    // every member's live session pointing at an org that no longer exists —
    // and their next reload asks for a vault nobody can resolve. `revokeMembership`
    // has always cleared it for one user; this is the same fix for all of them.
    await client.query(
      `UPDATE session SET "activeOrganizationId" = NULL WHERE "activeOrganizationId" = $1`,
      [orgId],
    );
    // The subscription row is NOT cascaded away any more (migration 024 drops
    // the FK). Turn whatever is there into a tombstone — including a canceled
    // row, where it is harmless — so a webhook arriving after this has
    // somewhere to land and the owner can still see what they were paying for.
    await client.query(
      `UPDATE subscriptions
          SET deleted_at = now(), org_name = $2, owner_user_id = $3, updated_at = now()
        WHERE organization_id = $1`,
      [orgId, orgName, actorUserId],
    );
    // Cascades: member, invitation, vaults→(folders, notes, files), shares,
    // org_join_codes, mcp_tokens, public_links.
    await client.query("DELETE FROM organization WHERE id = $1", [orgId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // The whole org is gone, so every subscriber's readable set is now empty and
  // the channel will drop every doc. Same reason as member removal: the
  // vault-channel sockets survive `disconnectDoc` and would otherwise keep
  // streaming content from a deleted vault until their tokens expired.
  for (const vaultId of vaultIds) deps.onAclChanged(vaultId);

  return { ok: true, orgName, vaultIds, docIds, counts, subscription };
}

export function createOrgRoutes(deps: OrgDeps): Hono {
  const orgRoutes = new Hono();

  // Fetch (or lazily generate) the join code for the caller's active vault.
  orgRoutes.get("/orgs/join-code", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active vault" }, 400);

    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only vault owner/admin can view the join code" }, 403);
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

  // Redeem a join code: join the vault as a 'member' (idempotent).
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

    // A code and an email invitation must land the same person in the same
    // place. If this vault already holds a pending invitation for the joiner's
    // address, the code is just the door they happened to walk through: they
    // get the ROLE the admin chose for them (an invited admin who joins by code
    // is an admin), the invitation is marked accepted so it stops showing as
    // "pending" in Members and stops holding a seat, and the seat cap is not
    // re-checked — their seat was already counted when the invitation was made.
    const invited = await pool.query<{ id: string; role: string | null; live: boolean }>(
      `SELECT id, role, ("expiresAt" > now()) AS live
         FROM invitation
        WHERE "organizationId" = $1 AND lower(email) = lower($2) AND status = 'pending'
        ORDER BY "createdAt" DESC`,
      [organizationId, session.email],
    );
    const liveInvite = invited.rows.find((r) => r.live);
    const role = liveInvite?.role === "admin" ? "admin" : "member";

    if (!liveInvite) {
      // Free-tier seat cap. This path bypasses Better Auth entirely, so the same
      // limit the invite hook enforces must be checked here before the INSERT.
      // No-op when billing is off (canAddMember returns allowed).
      const seat = await canAddMember(organizationId);
      if (!seat.allowed) {
        return c.json({ error: "member_limit_reached", limit: seat.limit }, 402);
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, $4, now())`,
        [randomUUID(), organizationId, session.userId, role],
      );
      if (invited.rows.length) {
        await client.query(
          `UPDATE invitation SET status = 'accepted' WHERE id = ANY($1)`,
          [invited.rows.map((r) => r.id)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Announce to teammates already live in the vault (this path bypasses
    // Better Auth, so its hooks never fire — we do it explicitly here).
    const who = await pool.query<{ name: string | null }>(
      'SELECT name FROM "user" WHERE id = $1',
      [session.userId],
    );
    const displayName = who.rows[0]?.name?.trim() || session.email;
    void announceMemberJoined(organizationId, displayName);

    return c.json({ organizationId, name: target.name, alreadyMember: false, role });
  });

  // Permanently delete a vault (owner only). The teardown itself lives in
  // `deleteVaultEverywhere` above, shared with `POST /orgs/:orgId/unsync`.
  orgRoutes.delete("/orgs/:orgId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "Unknown vault" }, 404);
    if (role !== "owner") {
      return c.json({ error: "Only the vault owner can delete it" }, 403);
    }

    const out = await deleteVaultEverywhere(deps, orgId, session.userId);
    if (!out.ok) return c.json({ error: out.error, message: out.message }, 502);

    return c.json({
      deleted: true,
      vaults: out.vaultIds.length,
      docs: out.docIds.length,
      subscription: out.subscription,
    });
  });

  /**
   * What "make this vault local only" would destroy (owner only, read-only).
   *
   * The confirm dialog is the ONLY gate on an irreversible action, so it has to
   * name real numbers rather than "everything". Pure SELECTs: calling this must
   * never be the thing that breaks a vault.
   */
  orgRoutes.get("/orgs/:orgId/unsync-preview", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    // Same shape as the delete route's not-found: a stranger learns nothing
    // about whether the vault exists.
    if (!role) return c.json({ error: "vault_not_found" }, 404);
    if (role !== "owner") return c.json({ error: "owner_only" }, 403);

    const { rows: orgRows } = await pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = $1",
      [orgId],
    );
    const orgName = orgRows[0]?.name ?? null;
    if (orgName === null) return c.json({ error: "vault_not_found" }, 404);

    const { rows: vaultRows } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [orgId],
    );
    const counts = await countVaultContents(orgId, vaultRows.map((r) => r.id));
    const subscription = echoSubscriptionRow(await findByOrg(pool, orgId));

    return c.json({ orgName, ...counts, subscription });
  });

  /**
   * Make a Synced vault Local again: remove everything the server holds for it.
   *
   * Identical teardown to DELETE above — the difference is entirely on the
   * client, which keeps its `.md` files and clears its vault stamp instead of
   * walking away. Two extra guards, because this one is reached from a
   * "keep my notes" flow and must not be mistaken for a reversible action:
   *   - owner only (403 `owner_only`), and
   *   - `confirmName` must match the vault's name exactly, or 409
   *     `name_mismatch` and NOTHING is touched. The in-app type-the-name gate
   *     is checked again here so the endpoint is safe on its own.
   */
  orgRoutes.post("/orgs/:orgId/unsync", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "vault_not_found" }, 404);
    if (role !== "owner") return c.json({ error: "owner_only" }, 403);

    const { rows: orgRows } = await pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = $1",
      [orgId],
    );
    const orgName = orgRows[0]?.name;
    if (orgName === undefined) return c.json({ error: "vault_not_found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { confirmName?: unknown };
    const confirmName = typeof body.confirmName === "string" ? body.confirmName.trim() : null;
    if (confirmName === null || confirmName !== orgName.trim()) {
      return c.json({ error: "name_mismatch" }, 409);
    }

    const out = await deleteVaultEverywhere(deps, orgId, session.userId);
    if (!out.ok) return c.json({ error: out.error, message: out.message }, 502);

    return c.json({
      unsynced: true,
      notes: out.counts.notes,
      files: out.counts.files,
      members: out.counts.members,
      subscription: out.subscription,
    });
  });

  /**
   * Does this vault still exist, and may I see it? (any signed-in user)
   *
   * Exists to tell "the vault was made local only" apart from "that folder
   * belongs to another account" — states a client otherwise cannot distinguish,
   * because both look like "stamped for an org that isn't in my list". A 404
   * means the folder is safe to re-adopt; a 403 means it really is someone
   * else's and must stay refused.
   */
  orgRoutes.get("/orgs/:orgId/status", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = $1",
      [orgId],
    );
    const name = rows[0]?.name;
    // Deliberately NOT the delete route's opaque 404: the whole point is to
    // distinguish gone from forbidden, and an org id is not a secret — the
    // caller is holding it in their own vault stamp already.
    if (name === undefined) return c.json({ error: "vault_not_found" }, 404);

    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "not_a_member" }, 403);

    return c.json({ orgId, name, role });
  });

  // Remove a member from a vault (owner/admin). Revokes access on both paths
  // that would otherwise let a departed member keep reading org data:
  //   1. delete the `member` row — their org-wide "Open" grant stops applying
  //      (the resolver gates it on membership) and the next sync-token mint 403s;
  //   2. purge their per-user shares — those are NOT membership-gated, so a folder
  //      or file shared directly to them would survive step 1 (see issue #16);
  //   3. force-close live sockets so access dies now, not at token expiry.
  // Owner can remove anyone but themselves; an admin can remove only plain members
  // (not another admin or the owner). Self-removal is POST /orgs/:orgId/leave
  // below — a different authz shape (any non-owner, only themselves) that
  // shares the teardown, not the checks.
  orgRoutes.delete("/orgs/:orgId/members/:userId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");

    const callerRole = await orgRole(orgId, session.userId);
    if (!callerRole) return c.json({ error: "Unknown vault" }, 404);
    if (callerRole !== "owner" && callerRole !== "admin") {
      return c.json({ error: "Only the vault owner or an admin can remove members" }, 403);
    }
    if (targetUserId === session.userId) {
      return c.json({ error: "You can't remove yourself from the vault" }, 400);
    }

    const targetRole = await orgRole(orgId, targetUserId);
    if (!targetRole) return c.json({ error: "That person isn't a member of this vault" }, 404);
    if (targetRole === "owner") {
      return c.json({ error: "The vault owner can't be removed" }, 403);
    }
    if (targetRole === "admin" && callerRole !== "owner") {
      return c.json({ error: "Only the owner can remove an admin" }, 403);
    }

    await revokeMembership(deps, orgId, targetUserId);
    return c.json({ removed: true });
  });

  // Leave a vault you don't own (#121). Any admin or member, any time, no
  // approval — membership is theirs to end. The owner is refused with a 409
  // that points at the exit they DO have (delete the vault): with no ownership
  // transfer yet, an owner walking out would strand a vault nobody can manage
  // or stop paying for.
  orgRoutes.post("/orgs/:orgId/leave", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");

    const role = await orgRole(orgId, session.userId);
    if (!role) return c.json({ error: "Unknown vault" }, 404);
    if (role === "owner") {
      return c.json(
        {
          error: "owner_cannot_leave",
          message:
            "You own this vault, so you can't leave it. Delete the vault instead, or hand it to someone else first.",
        },
        409,
      );
    }

    // Names for the emails, read BEFORE the membership goes so the owner
    // lookup still resolves through the org. `user.name` is NOT NULL but may
    // be blank; the template falls back to the address.
    const { rows: people } = await pool.query<{
      role: string;
      email: string;
      name: string;
      org_name: string;
    }>(
      `SELECT m.role, u.email, u.name, o.name AS org_name
         FROM member m
         JOIN "user" u ON u.id = m."userId"
         JOIN organization o ON o.id = m."organizationId"
        WHERE m."organizationId" = $1
          AND (m.role = 'owner' OR m."userId" = $2)`,
      [orgId, session.userId],
    );
    const owner = people.find((p) => p.role === "owner") ?? null;
    const me = people.find((p) => p.email === session.email) ?? people.find((p) => p.role !== "owner") ?? null;
    const orgName = people[0]?.org_name ?? "your vault";

    await revokeMembership(deps, orgId, session.userId);

    // Fire-and-forget, after the commit: a mail failure must never undo or
    // block a leave, and nothing here is a link the reader has to follow.
    if (emailEnabled()) {
      if (owner) {
        dispatchMail(
          "member-left notice",
          memberLeftEmail({
            to: owner.email,
            organizationName: orgName,
            memberName: me?.name ?? null,
            memberEmail: session.email,
          }),
        );
      }
      dispatchMail(
        "you-left receipt",
        youLeftVaultEmail({ to: session.email, organizationName: orgName }),
      );
    }

    return c.json({ left: true });
  });

  // Change a member's role (owner/admin). Same authz shape as removal: owner
  // may set any non-owner (but not themselves) to member/admin; an admin may
  // only touch plain members (promoting one to admin is allowed — admins can
  // already *invite* admins). `owner` is never grantable here; ownership
  // transfer is a different, deliberate operation we don't support yet.
  orgRoutes.patch("/orgs/:orgId/members/:userId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");

    const callerRole = await orgRole(orgId, session.userId);
    if (!callerRole) return c.json({ error: "Unknown vault" }, 404);
    if (callerRole !== "owner" && callerRole !== "admin") {
      return c.json({ error: "Only the vault owner or an admin can change roles" }, 403);
    }
    if (targetUserId === session.userId) {
      return c.json({ error: "You can't change your own role" }, 400);
    }

    const targetRole = await orgRole(orgId, targetUserId);
    if (!targetRole) return c.json({ error: "That person isn't a member of this vault" }, 404);
    if (targetRole === "owner") {
      return c.json({ error: "The vault owner's role can't be changed" }, 403);
    }
    if (targetRole === "admin" && callerRole !== "owner") {
      return c.json({ error: "Only the owner can change an admin's role" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const role = body && typeof body.role === "string" ? body.role : null;
    if (role !== "member" && role !== "admin") {
      return c.json({ error: "Role must be 'member' or 'admin'" }, 400);
    }
    // No-op guard before any side effects, so repeated clicks don't churn
    // sockets for a change that changes nothing.
    if (role === targetRole) return c.json({ updated: false, role });

    // Snapshot the org's docs BEFORE flipping the role so we can kick the
    // member's live sockets afterwards (same rationale as removal above).
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

    await pool.query(`UPDATE member SET role = $1 WHERE "organizationId" = $2 AND "userId" = $3`, [
      role,
      orgId,
      targetUserId,
    ]);

    // A role change flips effective permissions in BOTH directions, but the
    // `readOnly` flag is baked into the sync token and only checked at connect
    // time — a demoted admin keeps edit sockets, a promoted member keeps
    // read-only ones. Kick every live socket AFTER the update so reconnects
    // mint tokens against the new role, then tell the vault channels.
    for (const d of docs.rows) deps.disconnectDoc(d.vault_id, d.id);
    for (const vaultId of vaultIds) deps.onAclChanged(vaultId);

    return c.json({ updated: true, role });
  });

  return orgRoutes;
}
