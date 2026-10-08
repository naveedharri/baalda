// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { pool } from "../../db/pool.js";
import { auth } from "../../auth/auth.js";
import { config } from "../../config.js";
import { emailEnabled, sendMail } from "../../email/mailer.js";
import { invitationEmail } from "../../email/templates.js";
import { orgRole } from "../../permissions/lookup.js";
import { createResolverCache, loadAccessIndex } from "../../permissions/resolver.js";
import { listReadableDocsInVault, listVisibleFolders } from "../../permissions/vault-docs.js";
import { canManageMemberAccess, type AccessChangeDeps } from "../../permissions/access-management.js";
import { summarizeAccess, type SummaryMode } from "../../permissions/access-summary.js";
import { invitationState, loadInvitation } from "../../registry/invitations.js";
import { redactAddresses } from "../../invitations/sweep.js";
import { getSession } from "../session.js";
import { ACCOUNT_READ_ONLY_BODY } from "../../permissions/http-gates.js";

/**
 * The Members & access page.
 *
 *  - GET  /api/orgs/:orgId/members/overview (any member) — the roster with
 *    "last active" (`member.last_seen_at`, m046), pending invitations with the
 *    access each will get, and — for owners/admins only — each member's
 *    whole-vault access level. Levels come from ONE access index and resolver
 *    cache shared by every member (`summarizeAccess` on the vault root), so the
 *    page is a handful of queries, not one summary request per person. There is
 *    no role exemption: an owner is reported as whatever the resolver says.
 *
 *  - POST /api/orgs/:orgId/invitations (owner/admin) — invite up to 50
 *    addresses at once through Better Auth's own create-invitation (so the
 *    seat-cap hook and re-invite replacement still apply), remember the chosen
 *    access in `invitation_access`, and email each invite when the server can.
 *    The access is applied on acceptance (auth.ts afterAcceptInvitation and the
 *    join-code path, `members/invitation-access.ts`).
 */
export const memberRoutes = new Hono();

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCESS_MODES = new Set(["open", "readonly", "private"]);
const MAX_INVITES = 50;

type AccessLevel = "edit" | "view" | "none" | "custom";
const LEVEL_OF: Record<SummaryMode, AccessLevel> = {
  open: "edit",
  readonly: "view",
  private: "none",
  mixed: "custom",
};

type PersonRef = { userId: string; name: string | null; email: string };

/**
 * Who invited each member: the latest ACCEPTED Better Auth invitation for that
 * address in this org → its inviter. One query for the whole roster; a member
 * who joined by code (or the owner) has no accepted invitation and maps to null.
 */
async function invitersByUser(orgId: string, userIds: string[]): Promise<Map<string, PersonRef>> {
  const out = new Map<string, PersonRef>();
  if (!userIds.length) return out;
  const { rows } = await pool.query<{ user_id: string; inviter_id: string; name: string | null; email: string }>(
    `SELECT DISTINCT ON (u.id) u.id AS user_id, iu.id AS inviter_id, iu.name, iu.email
       FROM "user" u
       JOIN invitation i ON lower(i.email) = lower(u.email)
                        AND i."organizationId" = $1 AND i.status = 'accepted'
       JOIN "user" iu ON iu.id = i."inviterId"
      WHERE u.id = ANY($2::text[])
      ORDER BY u.id, i."createdAt" DESC`,
    [orgId, userIds],
  );
  for (const r of rows) out.set(r.user_id, { userId: r.inviter_id, name: r.name, email: r.email });
  return out;
}

/** Members summarised at once by the overview; each is a vault-wide resolve. */
const OVERVIEW_CONCURRENCY = 4;

memberRoutes.get("/orgs/:orgId/members/overview", async (c) => {
  const startedAt = Date.now();
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "Malformed vault id" }, 400);
  const role = await orgRole(orgId, session.userId);
  if (!role) return c.json({ error: "You are not a member of this vault" }, 403);
  const canManage = role === "owner" || role === "admin";

  const [members, invitations] = await Promise.all([
    pool.query<{
      user_id: string;
      member_id: string;
      role: string;
      name: string | null;
      email: string;
      image: string | null;
      joined_at: Date;
      last_seen_at: Date | null;
    }>(
      `SELECT m."userId" AS user_id, m.id AS member_id, m.role, u.name, u.email, u.image,
              m."createdAt" AS joined_at, m.last_seen_at
         FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1
        ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, lower(coalesce(u.name, u.email))`,
      [orgId],
    ),
    pool.query<{
      id: string;
      email: string;
      role: string | null;
      status: string;
      created_at: Date;
      expires_at: Date | null;
      access: string | null;
    }>(
      `SELECT i.id, i.email, i.role, i.status, i."createdAt" AS created_at,
              i."expiresAt" AS expires_at, ia.mode AS access
         FROM invitation i LEFT JOIN invitation_access ia ON ia.invitation_id = i.id
        WHERE i."organizationId" = $1 AND i.status = 'pending' AND i."expiresAt" > now()
        ORDER BY i."createdAt" DESC`,
      [orgId],
    ),
  ]);

  const inviters = await invitersByUser(
    orgId,
    members.rows.map((m) => m.user_id),
  );

  let levels: Map<string, AccessLevel> | null = null;
  if (canManage && members.rows.length) {
    const index = await loadAccessIndex(pool, orgId);
    const cache = createResolverCache();
    const roles = new Map(members.rows.map((m) => [m.user_id, m.role] as const));
    const out = new Map<string, AccessLevel>();
    // One vault-wide resolve per member over the shared index and cache, in
    // parallel (bounded) rather than one after another (#307).
    const queue = members.rows.slice();
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const [mode] = await summarizeAccess({
          db: pool,
          index,
          cache,
          groups: [[{ resourceType: "vault", resourceId: orgId }]],
          userIds: [m.user_id],
          roles,
        });
        out.set(m.user_id, LEVEL_OF[mode]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(OVERVIEW_CONCURRENCY, queue.length) }, worker),
    );
    levels = out;
  }
  console.log(
    `[members-overview] org=${orgId} members=${members.rows.length} levels=${levels ? 1 : 0} ms=${Date.now() - startedAt}`,
  );

  return c.json({
    members: members.rows.map((m) => ({
      userId: m.user_id,
      memberId: m.member_id,
      role: m.role,
      name: m.name,
      email: m.email,
      image: m.image,
      joinedAt: new Date(m.joined_at).toISOString(),
      lastActiveAt: m.last_seen_at ? new Date(m.last_seen_at).toISOString() : null,
      invitedBy: inviters.get(m.user_id) ?? null,
      ...(levels ? { access: { level: levels.get(m.user_id) ?? "none" } } : {}),
    })),
    invitations: invitations.rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role ?? "member",
      status: i.status,
      createdAt: new Date(i.created_at).toISOString(),
      expiresAt: i.expires_at ? new Date(i.expires_at).toISOString() : null,
      access: i.access && ACCESS_MODES.has(i.access) ? i.access : null,
    })),
    canManage,
  });
});

type ActivityEvent =
  | { kind: "joined"; at: string; invitedBy: PersonRef | null; rejoined?: boolean }
  | { kind: "created"; at: string; docId: string; path: string }
  | { kind: "edited"; at: string; docId: string; path: string }
  | {
      kind: "accessGranted";
      at: string;
      by: PersonRef | null;
      permission: "edit" | "view" | "readonly" | "denied" | "locked";
      resourceType: "folder" | "file" | "vault";
      resourceId: string;
      path: string | null;
    };

function loadShareRows(orgId: string, targetId: string, limit: number) {
  return pool.query<{
    resource_type: "folder" | "file" | "vault";
    resource_id: string;
    permission: "edit" | "view" | "readonly" | "denied" | "locked";
    created_at: Date;
    by_id: string | null;
    by_name: string | null;
    by_email: string | null;
    folder_path: string | null;
    note_path: string | null;
    file_path: string | null;
  }>(
    `SELECT s.resource_type, s.resource_id, s.permission, s.created_at,
            u.id AS by_id, u.name AS by_name, u.email AS by_email,
            f.path AS folder_path, n.rel_path AS note_path, fl.path AS file_path
       FROM shares s
       LEFT JOIN "user" u ON u.id = s.created_by
       LEFT JOIN folders f ON s.resource_type = 'folder' AND f.id = s.resource_id
       LEFT JOIN notes n ON s.resource_type = 'file' AND n.id = s.resource_id AND n.deleted_at IS NULL
       LEFT JOIN files fl ON s.resource_type = 'file' AND fl.id = s.resource_id
      WHERE s.org_id = $1 AND s.principal_type = 'user' AND s.principal_id = $2
      ORDER BY s.created_at DESC
      LIMIT $3`,
    [orgId, targetId, limit],
  );
}

const DEFAULT_ACTIVITY = 50;
const MAX_ACTIVITY = 100;

/**
 * GET /api/orgs/:orgId/members/:userId/activity?limit=50 — one person's recent
 * activity in this vault, newest first. Owner/admin may read anyone's; anyone
 * may read their own. Note events (created / edited) and share paths are
 * filtered through the CALLER's readable set, so the feed never names a note
 * or folder the caller cannot see. A handful of bounded queries per vault —
 * never a resolver call per doc.
 */
memberRoutes.get("/orgs/:orgId/members/:userId/activity", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId");
  const targetId = c.req.param("userId");
  if (!ID_RE.test(orgId) || !ID_RE.test(targetId)) return c.json({ error: "Malformed id" }, 400);
  const role = await orgRole(orgId, session.userId);
  if (!role) return c.json({ error: "You are not a member of this vault" }, 403);
  const canManage = role === "owner" || role === "admin";
  if (!canManage && session.userId !== targetId) {
    return c.json({ error: "Only the vault owner or an admin can see another member's activity" }, 403);
  }
  const rawLimit = Number(c.req.query("limit") ?? DEFAULT_ACTIVITY);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_ACTIVITY) : DEFAULT_ACTIVITY;

  const startedAt = Date.now();
  // Independent lookups start together (#307): membership, inviter, the org's
  // collections and the target's share rows (filtered by visibility below).
  const [{ rows: memberRows }, inviters, { rows: vaults }, sharesResult] = await Promise.all([
    pool.query<{ joined_at: Date }>(
      `SELECT "createdAt" AS joined_at FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [orgId, targetId],
    ),
    invitersByUser(orgId, [targetId]),
    pool.query<{ id: string }>("SELECT id FROM vaults WHERE organization_id = $1", [orgId]),
    loadShareRows(orgId, targetId, limit),
  ]);
  if (!memberRows.length) return c.json({ error: "not_member", message: "That person is not a member of this vault" }, 404);

  const events: ActivityEvent[] = [];
  const inviter = inviters.get(targetId) ?? null;
  events.push({ kind: "joined", at: new Date(memberRows[0].joined_at).toISOString(), invitedBy: inviter });

  // Caller-visible ids across the org's collections: notes (readable set) and folders.
  const readable = new Set<string>();
  const visibleFolders = new Set<string>();
  const perVault = await Promise.all(
    vaults.map((v) =>
      Promise.all([listReadableDocsInVault(session.userId, v.id), listVisibleFolders(session.userId, v.id)]),
    ),
  );
  for (const [docs, folders] of perVault) {
    for (const id of docs) readable.add(id);
    for (const f of folders) visibleFolders.add(f.id);
  }
  const readableIds = [...readable];
  const vaultIds = vaults.map((v) => v.id);

  if (readableIds.length && vaultIds.length) {
    const [created, edited] = await Promise.all([
      pool.query<{ doc_id: string; path: string; at: Date }>(
        `SELECT n.id AS doc_id, n.rel_path AS path, n.created_at AS at
           FROM notes n
          WHERE n.vault_id = ANY($1::text[]) AND n.created_by = $2 AND n.deleted_at IS NULL
            AND n.id = ANY($3::text[])
          ORDER BY n.created_at DESC
          LIMIT $4`,
        [vaultIds, targetId, readableIds, limit],
      ),
      // One event per (doc, UTC day): authored versions, plus the note's own
      // last_edited stamp as a fallback for edits no version captured.
      pool.query<{ doc_id: string; path: string; at: Date }>(
        `WITH touches AS (
            SELECT v.doc_id, v.created_at AS at FROM note_versions v
             WHERE v.vault_id = ANY($1::text[]) AND v.author_id = $2 AND v.doc_id = ANY($3::text[])
            UNION ALL
            SELECT n.id AS doc_id, n.last_edited_at AS at FROM notes n
             WHERE n.vault_id = ANY($1::text[]) AND n.last_edited_by = $2
               AND n.last_edited_at IS NOT NULL AND n.id = ANY($3::text[])
         ),
         daily AS (
            SELECT doc_id, max(at) AS at FROM touches
             GROUP BY doc_id, (at AT TIME ZONE 'UTC')::date
         )
         SELECT d.doc_id, n.rel_path AS path, d.at
           FROM daily d JOIN notes n ON n.id = d.doc_id AND n.deleted_at IS NULL
          ORDER BY d.at DESC
          LIMIT $4`,
        [vaultIds, targetId, readableIds, limit],
      ),
    ]);
    for (const r of created.rows) {
      events.push({ kind: "created", at: new Date(r.at).toISOString(), docId: r.doc_id, path: r.path });
    }
    for (const r of edited.rows) {
      events.push({ kind: "edited", at: new Date(r.at).toISOString(), docId: r.doc_id, path: r.path });
    }
  }

  const shares = sharesResult.rows;
  for (const s of shares) {
    let path: string | null = null;
    if (s.resource_type === "folder" && visibleFolders.has(s.resource_id)) path = s.folder_path;
    // A `files` binary is gated like a note (its doc_id is in the readable set).
    if (s.resource_type === "file" && readable.has(s.resource_id)) path = s.note_path ?? s.file_path;
    events.push({
      kind: "accessGranted",
      at: new Date(s.created_at).toISOString(),
      by: s.by_id ? { userId: s.by_id, name: s.by_name, email: s.by_email ?? "" } : null,
      permission: s.permission,
      resourceType: s.resource_type,
      resourceId: s.resource_id,
      path,
    });
  }

  // The member row is the CURRENT membership: leaving deletes it and a rejoin
  // inserts a new one, while authored notes outlive both. Note activity older
  // than this join can only come from an earlier membership, so say so instead
  // of implying one continuous membership (#296).
  const joined = events[0];
  if (
    joined.kind === "joined" &&
    events.some((e) => (e.kind === "created" || e.kind === "edited") && e.at < joined.at)
  ) {
    joined.rejoined = true;
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  console.log(`[member-activity] org=${orgId} events=${Math.min(events.length, limit)} ms=${Date.now() - startedAt}`);
  return c.json({ events: events.slice(0, limit) });
});

type InviteResult = { email: string; invitationId?: string; emailed: boolean; error?: string };

/** Map a Better Auth failure to a stable per-email error token. */
function inviteErrorCode(err: unknown): { code: string; status: number } {
  if (err instanceof APIError) {
    const body = (err.body ?? {}) as { message?: unknown; code?: unknown; error?: unknown };
    const text = [body.error, body.code, body.message, err.message]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    const status = typeof err.statusCode === "number" ? err.statusCode : 400;
    if (text.includes("seat_limit_reached")) return { code: "seat_limit_reached", status: 402 };
    if (text.includes("member_limit_reached")) return { code: "member_limit_reached", status: 402 };
    if (text.includes("account_read_only")) return { code: "account_read_only", status: 402 };
    if (/already a member/i.test(text)) return { code: "already_member", status };
    return { code: (typeof body.code === "string" && body.code) || "invite_failed", status };
  }
  return { code: "invite_failed", status: 500 };
}

async function emailInvitation(id: string): Promise<boolean> {
  const inv = await loadInvitation(pool, id);
  if (!inv || invitationState(inv) !== "pending") return false;
  try {
    await sendMail(
      invitationEmail({
        to: inv.email,
        url: `${config.betterAuthUrl}/invite/${encodeURIComponent(inv.id)}`,
        organizationName: inv.organizationName,
        inviterName: inv.inviterName,
        role: inv.role ?? "member",
        expiresAt: inv.expiresAt,
      }),
    );
    return true;
  } catch (err) {
    console.error(`[email] invitation ${inv.id} failed: ${redactAddresses(err)}`);
    return false;
  }
}

memberRoutes.post("/orgs/:orgId/invitations", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId");
  if (!ID_RE.test(orgId)) return c.json({ error: "Malformed vault id" }, 400);
  const callerRole = await orgRole(orgId, session.userId);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return c.json({ error: "Only the vault owner or an admin can invite people" }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawEmails = Array.isArray(body.emails) ? body.emails : null;
  if (!rawEmails || rawEmails.length === 0 || rawEmails.length > MAX_INVITES) {
    return c.json({ error: "invalid_request", message: `emails must hold 1–${MAX_INVITES} addresses` }, 400);
  }
  const emails = [
    ...new Set(rawEmails.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : ""))),
  ];
  const bad = emails.filter((e) => !EMAIL_RE.test(e) || e.length > 254);
  if (bad.length) {
    return c.json({ error: "invalid_email", message: "One or more addresses are not valid", invalid: bad }, 400);
  }
  const role = body.role ?? "member";
  if (role !== "member" && role !== "admin") {
    return c.json({ error: "invalid_role", message: "role must be member or admin" }, 400);
  }
  const access = body.access ?? null;
  if (access !== null && (typeof access !== "string" || !ACCESS_MODES.has(access))) {
    return c.json({ error: "invalid_access", message: "access must be open, readonly, private or null" }, 400);
  }

  const canEmail = emailEnabled();
  const results: InviteResult[] = [];
  let limitError: Record<string, unknown> | null = null;
  // Serial on purpose: the seat-cap hook counts pending invitations, so
  // parallel creates could all pass the same last free seat.
  for (const email of emails) {
    try {
      const inv = (await auth.api.createInvitation({
        body: { email, role, organizationId: orgId },
        headers: c.req.raw.headers,
      })) as { id: string } | null;
      if (!inv?.id) {
        results.push({ email, emailed: false, error: "invite_failed" });
        continue;
      }
      if (access !== null) {
        await pool.query(
          `INSERT INTO invitation_access (invitation_id, mode) VALUES ($1, $2)
           ON CONFLICT (invitation_id) DO UPDATE SET mode = EXCLUDED.mode`,
          [inv.id, access],
        );
      }
      const emailed = canEmail ? await emailInvitation(inv.id) : false;
      results.push({ email, invitationId: inv.id, emailed });
    } catch (err) {
      const { code } = inviteErrorCode(err);
      if ((code === "member_limit_reached" || code === "seat_limit_reached") && err instanceof APIError) {
        limitError = (err.body ?? {}) as Record<string, unknown>;
      }
      if (code === "invite_failed") console.error("[invitations] create failed:", (err as Error).message);
      results.push({ email, emailed: false, error: code });
    }
  }

  if (results.length && results.every((r) => r.error === "account_read_only")) {
    return c.json({ ...ACCOUNT_READ_ONLY_BODY, results }, 402);
  }
  if (results.length && results.every((r) => r.error === "member_limit_reached")) {
    return c.json(
      {
        error: "member_limit_reached",
        message: "member_limit_reached",
        ...(typeof limitError?.limit === "number" ? { limit: limitError.limit } : {}),
        ...(limitError?.scope === "account" ? { scope: "account" } : {}),
        results,
      },
      402,
    );
  }
  if (results.length && results.every((r) => r.error === "seat_limit_reached")) {
    const n = (k: string) => (typeof limitError?.[k] === "number" ? { [k]: limitError[k] } : {});
    return c.json(
      {
        error: "seat_limit_reached",
        code: "seat_limit_reached",
        message: typeof limitError?.message === "string" ? limitError.message : "seat_limit_reached",
        ...n("seats"),
        ...n("used"),
        ...n("pending"),
        results,
      },
      402,
    );
  }
  return c.json({ results });
});

/**
 * DELETE /api/orgs/:orgId/members/:userId/shares — "reset to default": remove
 * every per-person grant (vault, folder and file rows; any permission) this org
 * holds for one member, in one transaction. The member then gets exactly what
 * every member gets. `member_access_snapshots` is deliberately left alone: the
 * join snapshot still defines which pre-join content they see.
 *
 * Owner may reset anyone; an admin may reset a plain member or themselves.
 * Narrowing kicks like other ACL writes: the target's readable set is computed
 * before and after, every doc they lost is disconnected, and every collection
 * gets `onAclChanged` so a live vault channel hears `revoked`.
 */
export function createMemberShareRoutes(deps: AccessChangeDeps = {}) {
  const routes = new Hono();
  routes.delete("/orgs/:orgId/members/:userId/shares", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    const targetId = c.req.param("userId");
    if (!ID_RE.test(orgId) || !ID_RE.test(targetId)) return c.json({ error: "Malformed id" }, 400);
    const callerRole = await orgRole(orgId, session.userId);
    if (callerRole !== "owner" && callerRole !== "admin") {
      return c.json({ error: "access_manager_required", message: "Only the vault owner or an admin can manage access" }, 403);
    }
    const targetRole = await orgRole(orgId, targetId);
    if (!targetRole) return c.json({ error: "not_member", message: "That person is not a member of this vault" }, 404);
    if (!canManageMemberAccess(callerRole, targetRole, targetId === session.userId)) {
      return c.json({ error: "access_manager_required", message: "An admin can only reset members or themselves" }, 403);
    }

    const { rows: vaults } = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [orgId],
    );
    const before = new Map<string, Set<string>>();
    for (const v of vaults) before.set(v.id, await listReadableDocsInVault(targetId, v.id));

    const client = await pool.connect();
    let removed = 0;
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `DELETE FROM shares WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2`,
        [orgId, targetId],
      );
      removed = res.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    let disconnectedDocs = 0;
    if (removed > 0) {
      for (const v of vaults) {
        const after = await listReadableDocsInVault(targetId, v.id);
        for (const docId of before.get(v.id) ?? []) {
          if (after.has(docId)) continue;
          try {
            deps.disconnectDoc?.(v.id, docId);
            if (deps.disconnectDoc) disconnectedDocs++;
          } catch {
            // best effort: a transport failure must not undo the committed reset
          }
        }
        deps.onAclChanged?.(v.id);
      }
    }
    return c.json({ removed, disconnectedDocs });
  });
  return routes;
}
