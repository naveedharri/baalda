import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { pool } from "../../db/pool.js";
import {
  docsForResource,
  docsForResources,
  orgRole,
  resolveResource,
} from "../../permissions/lookup.js";
import {
  buildAccessContext,
  resolveAccessForUser,
} from "../../permissions/resolver.js";
import { getSession } from "../session.js";

/**
 * Share management API (session-authenticated) — spec 04 §3/§4.
 * Create/list/revoke shares on folders/files. Authorized for vault
 * owner/admin or the resource creator. On revoke we disconnect live sockets for
 * every affected doc (instant kill).
 */

type Queryable = Pick<pg.Pool, "query">;

/** The three postures the vault-level control offers. */
type TeamAccessMode = "open" | "readonly" | "private";

/** The `shares.permission` a mode writes on the vault row; null = no row. */
const MODE_PERMISSION: Record<TeamAccessMode, "edit" | "view" | null> = {
  open: "edit",
  readonly: "view",
  private: null,
};

/**
 * How much access a grant confers, so a change can be judged as widening or
 * NARROWING. `locked` and `denied` rank 0 alongside "no row": neither grants
 * anything, they only cap or block what another row granted.
 *
 * Only a narrowing needs a socket kick — the client reconnects and re-mints a
 * token, so a widening arrives on its own. This is the rule `POST /shares`
 * already follows when it kicks on view/locked/denied and never on edit.
 */
function grantRank(permission: string | null | undefined): number {
  return permission === "edit" ? 2 : permission === "view" ? 1 : 0;
}

function modeOf(permission: string | null | undefined): TeamAccessMode {
  if (permission === "edit") return "open";
  if (permission === "view") return "readonly";
  return "private";
}

export interface TeamAccessOverride {
  id: string;
  vaultId: string;
  resourceType: "folder" | "file";
  resourceId: string;
  permission: "edit" | "view" | "locked" | "denied";
}

/**
 * Every per-item row the vault-level control owns: the org-principal grants,
 * locks and denies on a folder or file living in one of the org's note
 * collections.
 *
 * Per-USER rows are deliberately absent. The per-item control clears an item's
 * own org rows and leaves named-person grants, per-member locks and per-member
 * denies standing; the vault-level control is the same control at vault scope,
 * so it must behave the same way.
 *
 * The membership subqueries mirror `GET /vaults/:vaultId/locks` — widened to
 * every collection of the org and to all four permissions. A row whose resource
 * no longer exists (or whose note is soft-deleted) produces no lateral row and
 * so drops out of the inner join, which is what keeps a deleted note's leftover
 * share off the list.
 */
async function teamOverrides(
  db: Queryable,
  orgId: string,
  vaultIds: string[],
): Promise<TeamAccessOverride[]> {
  if (vaultIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    vault_id: string;
    resource_type: "folder" | "file";
    resource_id: string;
    permission: "edit" | "view" | "locked" | "denied";
  }>(
    `SELECT s.id, loc.vault_id, s.resource_type, s.resource_id, s.permission
       FROM shares s
       JOIN LATERAL (
         SELECT f.vault_id FROM folders f
          WHERE s.resource_type = 'folder' AND f.id = s.resource_id
         UNION ALL
         SELECT n.vault_id FROM notes n
          WHERE s.resource_type = 'file' AND n.id = s.resource_id
            AND n.deleted_at IS NULL
         UNION ALL
         SELECT fi.vault_id FROM files fi
          WHERE s.resource_type = 'file' AND fi.id = s.resource_id
         LIMIT 1
       ) loc ON TRUE
      WHERE s.principal_type = 'org'
        AND s.principal_id = $2
        AND s.resource_type IN ('folder', 'file')
        AND loc.vault_id = ANY($1::text[])
      ORDER BY s.resource_type, s.resource_id`,
    [vaultIds, orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    vaultId: r.vault_id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    permission: r.permission,
  }));
}

/**
 * Org rows stranded on SOFT-DELETED notes — the ones `teamOverrides` refuses to
 * report because the user cannot see the note they sit on.
 *
 * PUT clears them anyway, silently and uncounted: left behind, a restored note
 * would come back carrying the very override the whole-vault setting was
 * applied to remove. They are absent from the reported `cleared` count because
 * the user never saw them, and absent from the socket kick because a deleted
 * doc has no live editors for the row to have been protecting.
 *
 * Soft-deleted NOTES only. `shares.resource_id` has no foreign key, so a row on
 * a hard-deleted folder or file outlives its resource; those are inert garbage
 * that no resolver can reach, they predate this endpoint, and cleaning them up
 * is not this control's job.
 */
async function deadNoteOverrideIds(
  db: Queryable,
  orgId: string,
  vaultIds: string[],
): Promise<string[]> {
  if (vaultIds.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id
       FROM shares s
       JOIN notes n ON n.id = s.resource_id
      WHERE s.principal_type = 'org'
        AND s.principal_id = $2
        AND s.resource_type = 'file'
        AND n.deleted_at IS NOT NULL
        AND n.vault_id = ANY($1::text[])`,
    [vaultIds, orgId],
  );
  return rows.map((r) => r.id);
}

/**
 * The org's own posture row on the vault resource. At most one: the unique key
 * is (resource_type, resource_id, principal_type, principal_id), so it is the
 * `principal_id = orgId` filter — not the key alone — that makes this single.
 * A row bearing some OTHER principal id is ignored here for the same reason
 * `sharePermission` ignores it: it grants that principal nothing on this org.
 */
async function vaultPostureRow(
  db: Queryable,
  orgId: string,
): Promise<{ id: string; permission: string; createdBy: string | null; createdAt: Date | null } | null> {
  const { rows } = await db.query<{
    id: string;
    permission: string;
    created_by: string | null;
    created_at: Date | null;
  }>(
    `SELECT id, permission, created_by, created_at FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND principal_type = 'org' AND principal_id = $1`,
    [orgId],
  );
  const row = rows[0];
  // `created_by`/`created_at` are carried for `GET /locks`, which reports this
  // row in the same shape as the item rows beside it.
  return row
    ? { id: row.id, permission: row.permission, createdBy: row.created_by, createdAt: row.created_at }
    : null;
}

export interface ShareDeps {
  /** Force-close live sync sockets for a doc (instant revocation). */
  disconnectDoc: (vaultId: string, docId: string) => void;
  /** Notify the vault channel that shares changed so subscribers re-evaluate
   *  their readable-doc set (spec 05 §3.1). Optional; no-op if unset. */
  onAclChanged?: (vaultId: string) => void;
}

export function createShareRoutes(deps: ShareDeps): Hono {
  const app = new Hono();

  async function canManage(
    userId: string,
    // 'vault' = the vault-wide grant (resourceId is the organization id).
    resourceType: "folder" | "file" | "vault",
    resourceId: string,
  ): Promise<{
    ok: boolean;
    organizationId?: string;
    /** Note collections whose subscribers should re-evaluate on an ACL change. A
     *  folder/file touches one note collection; a vault-wide grant touches all
     *  of the org's. */
    vaultIds?: string[];
    status?: number;
    error?: string;
  }> {
    const info = await resolveResource(resourceType, resourceId);
    if (!info) return { ok: false, status: 404, error: "Unknown resource" };
    const role = await orgRole(info.organizationId, userId);
    const isAdmin = role === "owner" || role === "admin";
    // Vault posture (Open/Read-only/Private) is an owner/admin decision;
    // the per-resource "creator can manage" escape hatch doesn't apply.
    const isCreator =
      resourceType !== "vault" &&
      info.createdBy !== null &&
      info.createdBy === userId;
    if (!isAdmin && !isCreator) {
      return { ok: false, status: 403, error: "Not allowed to manage shares here" };
    }
    const vaultIds =
      resourceType === "vault"
        ? (
            await pool.query<{ id: string }>(
              "SELECT id FROM vaults WHERE organization_id = $1",
              [info.organizationId],
            )
          ).rows.map((r) => r.id)
        : [info.vaultId];
    return { ok: true, organizationId: info.organizationId, vaultIds };
  }

  // Create or update a share (upsert on the unique resource+principal key).
  // permission 'locked' is the deny overlay (spec 04 §3 extension): it caps
  // everyone it matches at read-only. principalType 'org' targets the whole
  // vault (principalId may be omitted — it becomes the organization id).
  app.post("/shares", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const resourceType = body.resourceType;
    const resourceId = body.resourceId;
    const principalType = body.principalType ?? "user";
    const permission = body.permission;
    if (
      (resourceType !== "folder" && resourceType !== "file" && resourceType !== "vault") ||
      typeof resourceId !== "string" ||
      (principalType !== "user" && principalType !== "org") ||
      (permission !== "view" &&
        permission !== "edit" &&
        permission !== "locked" &&
        permission !== "denied")
    ) {
      return c.json(
        {
          error:
            "resourceType(folder|file|vault), resourceId, principalType(user|org), permission(view|edit|locked|denied) required",
        },
        400,
      );
    }
    // An org-wide edit/view grant on a folder/file is "Share with team" (spec:
    // private-by-default). On a vault resource it's the "Open"/"Read-only"
    // posture. Both are allowed; locks (cap overlays) may also be org-wide.
    //
    // `denied` comes in two shapes, both on a folder or file and never on the
    // vault resource (a vault-level deny is the Private posture, and would be a
    // way to lock an owner out of their own vault):
    //   - principal 'user' — the per-member Private: an absolute block.
    //   - principal 'org'  — the ITEM set to Private: it takes the item out of
    //     the team's reach. This is the row that makes item-Private possible at
    //     all; clearing an item's own grants could never achieve it, because a
    //     vault-wide Open grant still reached the item and the UI snapped back
    //     to Shared.
    if (permission === "denied" && resourceType === "vault") {
      return c.json({ error: "denied applies to a folder or a file" }, 400);
    }

    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const principalId =
      principalType === "org" ? gate.organizationId : body.principalId;
    if (typeof principalId !== "string" || !principalId) {
      return c.json({ error: "principalId required for user shares" }, 400);
    }

    // Locks are subsumption-aware: an Everyone/org lock on a resource makes any
    // per-user lock on the SAME resource redundant. Without this, a resource can
    // carry both an org lock and a user lock, and Unlock becomes misleading —
    // removing one leaves the resource locked by the other, so unlock appears to
    // do nothing. We keep a single authoritative lock per resource instead.
    if (permission === "locked" && principalType === "user") {
      // An org lock already covers everyone here — the per-user lock adds
      // nothing. No-op and report the effective (org) lock.
      const { rows: orgLock } = await pool.query<{ id: string }>(
        `SELECT id FROM shares
          WHERE resource_type = $1 AND resource_id = $2
            AND principal_type = 'org' AND permission = 'locked'
          LIMIT 1`,
        [resourceType, resourceId],
      );
      if (orgLock[0]) {
        return c.json(
          {
            id: orgLock[0].id,
            resourceType,
            resourceId,
            principalType: "org",
            principalId: gate.organizationId,
            permission: "locked",
            subsumed: true,
          },
          200,
        );
      }
    }

    const id = randomUUID();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
       DO UPDATE SET permission = EXCLUDED.permission
       RETURNING id`,
      [
        id,
        gate.organizationId,
        resourceType,
        resourceId,
        principalType,
        principalId,
        permission,
        session.userId,
      ],
    );

    // An Everyone/org lock subsumes any per-user locks on the same resource —
    // drop them so a single Unlock actually unlocks. (Those users stay locked by
    // the org lock, so no access change and no socket kick is needed.)
    if (permission === "locked" && principalType === "org") {
      await pool.query(
        `DELETE FROM shares
          WHERE resource_type = $1 AND resource_id = $2
            AND principal_type = 'user' AND permission = 'locked'`,
        [resourceType, resourceId],
      );
    }

    // Any downgrade to read-only must reach live editors immediately — force
    // reconnect so open sessions come back with fresh (now read-only) sync
    // tokens, same as revocation does. This covers a lock, a per-user edit→view
    // change, and a vault Open→Read-only posture flip (all land as
    // view/locked) — and a `denied`, which has to eject the member outright.
    // An 'edit' grant only widens access, so it needs no kick;
    // the onAclChanged push below lets background subscribers pick it up.
    // Reconnect re-mints each client's own permission, so a peer who still has
    // edit gets edit back — this only tightens editors that should go read-only.
    if (permission === "locked" || permission === "view" || permission === "denied") {
      const docs = await docsForResource(resourceType, resourceId);
      for (const d of docs) {
        deps.disconnectDoc(d.vaultId, d.docId);
      }
    }

    // A new grant can expand a user's readable set — tell background subscribers.
    for (const v of gate.vaultIds ?? []) deps.onAclChanged?.(v);

    return c.json(
      { id: rows[0].id, resourceType, resourceId, principalType, principalId, permission },
      201,
    );
  });

  // Every access OVERLAY row in a note collection: `locked` (read-only cap) and
  // `denied` (Private). Any member may read these — the client renders the
  // tree's lock badges and the Access panel's inherited-Private state from
  // them, and both need the whole vault's set, not one resource's.
  //
  // Still mounted at `/locks`: the shape is a superset and the client splits by
  // permission, so an older client that only understands `locked` is unaffected
  // by the extra rows only if it filters — which it does.
  //
  // Plus ONE synthetic row: a vault whose posture is Read-only is a lock on
  // everything, so it is reported as `resource_type: 'vault'` with
  // `permission: 'locked'` even though the stored row says `view`. Two reasons
  // for the rewrite rather than shipping the raw `view` row:
  //
  //  - It IS a lock to every reader. `vaultBaseline` caps the owner/admin and
  //    author shortcuts at view, so the sidebar has to put the same padlock on
  //    every folder and note that a per-item lock puts on one. Locking an item
  //    and making it read-only are the same thing to the person looking at it.
  //  - A vault-scoped `locked` row cannot exist in the table — it would collide
  //    with the vault GRANT on (resource_type, resource_id, principal_type,
  //    principal_id), which is exactly why `isLocked` is folder/file only. So
  //    `locked` is free on the wire and unambiguous: a `vault` row here always
  //    means the Read-only posture and never a stored lock.
  //
  // The `edit` posture is NOT reported: an open vault grants, it does not cap.
  // Neither is Private (no row at all) — that is a grant question, and the
  // per-item `denied` rows above already carry it.
  //
  // And when the posture IS Read-only, the LIFTS come with it. Read-only is a
  // baseline, not a ceiling: `sharePermission` takes the max over the vault
  // grant and every org/user row on the item and its ancestors, so a folder set
  // to Shared — or a personal `edit` grant on one note — puts the caller back
  // to edit inside it. A client that badged the posture alone would padlock a
  // folder the reader can write to and open its notes read-only on the first
  // frame. So the `edit` rows that can lift this caller ride along, at their
  // real permission, and the client subtracts their subtrees from the seed.
  //
  // Two rules on WHOSE rows: org-principal rows are the vault's own posture
  // exceptions and every member already sees their effect, so they are public
  // within the vault. Per-user rows are reported ONLY when they name the
  // CALLER — who else was lifted is nobody else's business, and a member must
  // not be able to enumerate their teammates' grants from a badge endpoint.
  app.get("/vaults/:vaultId/locks", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");

    const { rows: vrows } = await pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM vaults WHERE id = $1",
      [vaultId],
    );
    const org = vrows[0]?.organization_id;
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (!role) return c.json({ error: "Not a member of this vault" }, 403);

    const { rows } = await pool.query(
      `SELECT s.id, s.resource_type, s.resource_id, s.principal_type, s.principal_id,
              s.permission, s.created_by, s.created_at
         FROM shares s
        WHERE s.permission IN ('locked', 'denied')
          AND (
            (s.resource_type = 'folder' AND s.resource_id IN
               (SELECT id FROM folders WHERE vault_id = $1))
            OR (s.resource_type = 'file' AND s.resource_id IN
               (SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
                UNION SELECT id FROM files WHERE vault_id = $1))
          )`,
      [vaultId],
    );

    const posture = await vaultPostureRow(pool, org);
    if (posture?.permission === "view") {
      rows.push({
        // NOT `posture.id`. That is the live vault GRANT row, and
        // `DELETE /shares/:id` would happily accept it from an owner — which is
        // "Entire vault → Private", silently, from something that looked like an
        // unlock. Nothing on the client reads this id (every unlock path
        // resolves a share by RESOURCE id, which the org id never matches), so
        // a deliberately non-routable value costs nothing and closes the hole.
        id: `vault:${org}`,
        resource_type: "vault",
        resource_id: org,
        principal_type: "org",
        principal_id: org,
        permission: "locked",
        created_by: posture.createdBy,
        created_at: posture.createdAt,
      });

      const { rows: lifts } = await pool.query(
        `SELECT s.id, s.resource_type, s.resource_id, s.principal_type, s.principal_id,
                s.permission, s.created_by, s.created_at
           FROM shares s
          WHERE s.permission = 'edit'
            AND (
              (s.principal_type = 'org' AND s.principal_id = $2)
              OR (s.principal_type = 'user' AND s.principal_id = $3)
            )
            AND (
              (s.resource_type = 'folder' AND s.resource_id IN
                 (SELECT id FROM folders WHERE vault_id = $1))
              OR (s.resource_type = 'file' AND s.resource_id IN
                 (SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
                  UNION SELECT id FROM files WHERE vault_id = $1))
            )`,
        [vaultId, org, session.userId],
      );
      rows.push(...lifts);
    }
    return c.json({ locks: rows });
  });

  // ── Whole-vault team access ────────────────────────────────────────────────
  //
  // The Access panel's vault-level control ("This vault, by default") used to
  // write the vault row and nothing else, so every per-folder/per-file override
  // survived it. People read the control as "make the WHOLE vault Shared /
  // Read-only / Private" and were right to: it is the per-item control at vault
  // scope. So it now enforces the mode across the vault, clearing the item-level
  // org rows exactly as the per-item control clears an item's own.
  //
  // It lives on the server because the client cannot do it: one round trip per
  // item, no atomicity, and no way to even enumerate the org `edit`/`view`
  // overrides (`/locks` reports only the `locked`/`denied` overlay).
  //
  // Owner/admin only, both verbs — `canManage` on the vault resource, which is
  // role-based on purpose (an owner must be able to lift a restriction they
  // applied to themselves; see the note at the top of this file).

  // Report the posture plus every per-item override that currently survives it.
  app.get("/orgs/:orgId/team-access", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");

    const gate = await canManage(session.userId, "vault", orgId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    // Only view/edit declare a posture — `vaultBaseline` reads the same pair.
    const row = await vaultPostureRow(pool, orgId);
    const posture = row?.permission === "edit" || row?.permission === "view" ? row : null;
    return c.json({
      mode: modeOf(posture?.permission),
      grantId: posture?.id ?? null,
      overrides: await teamOverrides(pool, orgId, gate.vaultIds ?? []),
    });
  });

  // Enforce a posture on the entire vault.
  app.put("/orgs/:orgId/team-access", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");

    const body = await c.req.json().catch(() => ({}));
    const mode = body?.mode as TeamAccessMode;
    if (mode !== "open" && mode !== "readonly" && mode !== "private") {
      return c.json({ error: "mode must be one of open|readonly|private" }, 400);
    }

    const gate = await canManage(session.userId, "vault", orgId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const vaultIds = gate.vaultIds ?? [];
    const permission = MODE_PERMISSION[mode];

    // What has to be force-disconnected. NOT "everything that was deleted": a
    // client reconnects and re-mints its own token, so a change that gives
    // people MORE access arrives by itself and a kick would only cost a
    // reconnect. Only a narrowing has to reach open editors immediately, which
    // is the same rule `POST /shares` applies per resource.
    //
    //   item row   kicked iff grantRank(row) > grantRank(target)
    //   posture    kicked iff grantRank(old) > grantRank(new)
    //
    // So Read-only→Shared kicks nobody, Shared→Read-only kicks every doc, and a
    // cleared `locked`/`denied` row (rank 0) never kicks anyone at all.
    let itemKick: Array<{ resourceType: "folder" | "file"; resourceId: string }> = [];
    let vaultKick = false;
    // Reported separately, because the desktop says "N folder and note settings
    // cleared": `cleared` counts ITEM rows only — the ones GET would have
    // listed — and the posture is a yes/no of its own.
    let cleared = 0;
    let postureChanged = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const overrides = await teamOverrides(client, orgId, vaultIds);
      const dead = await deadNoteOverrideIds(client, orgId, vaultIds);
      const posture = await vaultPostureRow(client, orgId);
      // Compared as MODES, not as raw permissions: a vault-level `locked` row
      // is inert (the resolver's lock check ignores vault rows) and reads as
      // Private, so it must not register as a change away from Private.
      postureChanged = modeOf(posture?.permission) !== mode;
      cleared = overrides.length;

      // The posture row is deleted ONLY on the way to Private. For edit/view
      // the upsert below rewrites it in place, which keeps `grantId` stable for
      // the client and leaves no instant inside the transaction where the vault
      // has no grant at all.
      const dropPosture = permission === null && posture !== null;

      const ids = [
        ...overrides.map((o) => o.id),
        ...dead,
        ...(dropPosture ? [posture.id] : []),
      ];
      itemKick = overrides
        .filter((o) => grantRank(o.permission) > grantRank(permission))
        .map((o) => ({ resourceType: o.resourceType, resourceId: o.resourceId }));
      vaultKick = grantRank(posture?.permission) > grantRank(permission);
      if (ids.length > 0) {
        await client.query("DELETE FROM shares WHERE id = ANY($1::text[])", [ids]);
      }

      if (permission !== null) {
        await client.query(
          `INSERT INTO shares
             (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
           VALUES ($1, $2, 'vault', $3, 'org', $4, $5, $6)
           ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
           DO UPDATE SET permission = EXCLUDED.permission`,
          [randomUUID(), orgId, orgId, orgId, permission, session.userId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // After the commit. A narrowed vault posture already reaches every doc in
    // every collection of the org, so the per-item walks underneath it are
    // pure duplication — resolve the one query and skip them. Otherwise the
    // items go in a single batch rather than one recursive walk apiece.
    // (The subtree walks still work: only `shares` rows were deleted.)
    const affected = vaultKick
      ? await docsForResource("vault", orgId)
      : await docsForResources(itemKick);

    // Best-effort, one doc at a time. The write is already committed, so a
    // transport that throws on one socket must not cost the caller a 500 and
    // must not strand the docs behind it on their old permission.
    let disconnected = 0;
    for (const d of affected) {
      try {
        deps.disconnectDoc(d.vaultId, d.docId);
        disconnected += 1;
      } catch {
        // The doc keeps its socket until the token expires; nothing else to do.
      }
    }
    // Only on a real change: an idempotent PUT would otherwise make every
    // vault-channel subscriber in every collection recompute its readable set
    // for nothing.
    if (cleared > 0 || postureChanged) for (const v of vaultIds) deps.onAclChanged?.(v);

    return c.json({ mode, cleared, postureChanged, disconnectedDocs: disconnected });
  });

  // List shares for a resource.
  app.get("/shares", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const resourceType = c.req.query("resourceType");
    const resourceId = c.req.query("resourceId");
    if (
      (resourceType !== "folder" && resourceType !== "file" && resourceType !== "vault") ||
      !resourceId
    ) {
      return c.json({ error: "resourceType and resourceId query params required" }, 400);
    }
    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const { rows } = await pool.query(
      `SELECT id, resource_type, resource_id, principal_type, principal_id, permission, created_by, created_at
         FROM shares WHERE resource_type = $1 AND resource_id = $2`,
      [resourceType, resourceId],
    );
    return c.json({ shares: rows });
  });

  // Resolve WHO can access one resource: every vault member with their
  // effective permission (role + shares + inherited folder shares, capped by
  // locks) and its source. Powers the "who can access" view. Same canManage
  // gate as listing shares.
  app.get("/resolve-access", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const resourceType = c.req.query("resourceType");
    const resourceId = c.req.query("resourceId");
    if ((resourceType !== "folder" && resourceType !== "file") || !resourceId) {
      return c.json({ error: "resourceType and resourceId query params required" }, 400);
    }
    const gate = await canManage(session.userId, resourceType, resourceId);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    const ctx = await buildAccessContext(resourceType, resourceId);
    if (!ctx) return c.json({ error: "Unknown resource" }, 404);

    const { rows: memberRows } = await pool.query<{
      user_id: string;
      role: string;
      name: string | null;
      email: string | null;
    }>(
      `SELECT m."userId" AS user_id, m.role, u.name, u.email
         FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1`,
      [ctx.organizationId],
    );

    const members = await Promise.all(
      memberRows.map(async (m) => {
        const { permission, capped, denied } = await resolveAccessForUser(ctx, m.user_id, m.role);
        return {
          userId: m.user_id,
          name: m.name,
          email: m.email,
          role: m.role,
          permission,
          capped,
          denied: denied ?? false,
        };
      }),
    );
    return c.json({ members });
  });

  // Revoke a share, then instant-kill affected live sockets.
  app.delete("/shares/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const shareId = c.req.param("id");

    const { rows } = await pool.query<{
      resource_type: "folder" | "file" | "vault";
      resource_id: string;
    }>("SELECT resource_type, resource_id FROM shares WHERE id = $1", [shareId]);
    const share = rows[0];
    if (!share) return c.json({ error: "Share not found" }, 404);

    const gate = await canManage(session.userId, share.resource_type, share.resource_id);
    if (!gate.ok) return c.json({ error: gate.error }, (gate.status ?? 403) as 403 | 404);

    // Compute affected docs BEFORE deleting (folder subtree join needs the rows).
    const docs = await docsForResource(share.resource_type, share.resource_id);
    await pool.query("DELETE FROM shares WHERE id = $1", [shareId]);

    for (const d of docs) {
      deps.disconnectDoc(d.vaultId, d.docId);
    }
    // Revoking a grant can shrink a user's readable set — background subscribers
    // re-evaluate and drop the now-inaccessible docs.
    for (const v of gate.vaultIds ?? []) deps.onAclChanged?.(v);
    return c.json({ revoked: shareId, disconnectedDocs: docs.length });
  });

  return app;
}
