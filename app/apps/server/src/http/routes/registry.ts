import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { canCreateIn, canEditDoc, canEditFolder, canWriteBlob } from "../../permissions/http-gates.js";
import { deleteDocBlobs } from "./blobs.js";
import { effectivePermission } from "../../permissions/resolver.js";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
  listVisibleFolders,
} from "../../permissions/vault-docs.js";
import { purgeNoteIndex } from "../../index/indexer.js";
import {
  isRootFrozen,
  normalizeColor,
  registerCtx,
  registerFile,
  registerFolder,
  registerNote,
} from "../../registry/batch-ops.js";
import {
  TreeOpError,
  deleteFolderCascade,
  findFolder,
  findNote,
  moveFolder,
  moveNote,
  planFolderMove,
  planNoteMove,
  resolveFolderParent,
  resolveParentFolder,
  samePath,
  tombstoneFile,
} from "../../registry/tree-ops.js";
import { getSession } from "../session.js";

/** Most doc ids one `POST /vaults/:id/access-check` may ask about — the same
 *  bound the vault channel's `ready.revoked` uses for the list it corroborates,
 *  and mirrored client-side as `lib/api.ts ACCESS_CHECK_MAX` so the desktop
 *  chunks to it rather than earning a 400. */
export const ACCESS_CHECK_MAX = 2000;

/** Run `fn` over items with at most `limit` in flight, preserving nothing about
 *  order (callers here collect into a set/array they sort or don't care about).
 *  A rejection propagates, which is what turns a database failure into a 500
 *  rather than a partial, quietly-wrong answer. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    }),
  );
}

export interface RegistryDeps {
  /** Force-close live sync sockets for a doc, so an editor open on a note that
   *  just got deleted out from under it reconnects and learns it's gone. */
  disconnectDoc?: (vaultId: string, docId: string) => void;
  /** Stronger than {@link disconnectDoc}: also drops the server's cached
   *  `Y.Doc`, so the next connect reloads from Postgres instead of being handed
   *  the state we just deleted. Used by the folder cascade. */
  evictDoc?: (vaultId: string, docId: string) => Promise<void> | void;
  /**
   * Called after any change to a vault's folder/note structure (create, rename,
   * move, delete). The vault channel broadcasts a `registry` control frame so
   * every open client re-pulls the registry and updates its local tree live —
   * without this, structural changes only surfaced on the next app restart.
   *
   * `originId` is the calling client's `x-baalda-origin` (the same opaque id it
   * sends in its vault-channel hello), or null when it didn't send one. The
   * channel uses it to skip notifying the client that caused the change: a
   * 500-note reconcile otherwise bounced ~1,100 `registry` frames back at its
   * own author, each triggering a full per-subscriber ACL recompute.
   */
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
}

/** Header carrying the calling client's opaque instance id (see RegistryDeps). */
export const ORIGIN_HEADER = "x-baalda-origin";

/**
 * Re-exported from `registry/batch-ops.ts`, where it now lives so the batch
 * routes can apply the latch without importing a route module. Kept exported
 * here because several call sites (and tests) import it from this path.
 */
export { isRootFrozen };

/** The 403 body every frozen-root refusal shares, so clients can match on a code. */
const ROOT_FROZEN_ERROR = {
  error: "This vault's root is frozen — create this inside a folder instead.",
  code: "root_frozen",
} as const;

/**
 * The 403 body every permission refusal on a CREATE shares.
 *
 * It carries a `code` for the same reason `ROOT_FROZEN_ERROR` does: the desktop
 * explains a failed registration by its code and nothing else
 * (`lib/sync/registry.ts recordFailure`), so a refusal without one counts
 * silently toward "N items not synced" with no reason attached.
 *
 * **Precedence, deliberately: permission first, frozen root second.** Both
 * checks can fire on the same request (a read-only user creating at a frozen
 * root), and the permission gate runs first — telling someone to "move it into
 * a folder" is useless advice when they may not write to that folder either,
 * and it would leak that the root is frozen to someone with no write access at
 * all. A caller who may write still gets `root_frozen`, which is the case the
 * desktop's toast is for.
 */
const NO_WRITE_ACCESS_ERROR = (kind: "note" | "folder" | "file") =>
  ({
    error: `You do not have permission to create a ${kind} here.`,
    code: "no_write_access",
  }) as const;

/** 400 body for a path that disagrees with its folder (or names a folder that
 *  does not exist). Terminal for the desktop's `withRetry`, which is right: the
 *  request is wrong, not the network. */
function pathFolderMismatch(err: TreeOpError) {
  return { error: err.message, code: "path_folder_mismatch" } as const;
}

/** Ceiling on one keyset page. Bigger than any client asks for and small
 *  enough that a page is bounded work; a caller wanting more asks again. */
export const PAGE_LIMIT_MAX = 5000;

interface PageRequest {
  limit: number;
  /** Exclusive lower bound on the ordering column; null starts at the top. */
  after: string | null;
}

/**
 * Read `?limit=&after=` off a registry listing.
 *
 * `null` (no `limit`) means **today's exact behaviour**: one unpaginated
 * snapshot with its tombstones. That default is load-bearing rather than
 * politeness — every shipped client reads these listings as the complete truth
 * and subtracts what is missing, so silently capping an un-paginated request
 * would have an old client delete every note past the cap.
 */
function readPage(c: { req: { query: (k: string) => string | undefined } }): PageRequest | null | "invalid" {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return null;
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) return "invalid";
  const after = c.req.query("after");
  return { limit, after: after === undefined || after === "" ? null : after };
}

/** Byte-wise string order — the JS twin of `COLLATE "C"`, used where a page is
 *  cut in memory (folders) so it matches the SQL-side cut (notes, files). A
 *  locale collation is not a stable total order across libc versions, and a
 *  cursor that means something different after a base-image bump silently skips
 *  or repeats rows. */
function compareC(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Registry API (session-authenticated). Lets the client map local vault files to
 * server doc_ids: create/list/rename/delete vaults, folders, notes, files.
 * doc_id is the join key between the .md file, the Yjs doc, and the relational
 * rows, and is NEVER changed by a rename/move — only the path columns move, so a
 * note keeps one identity across devices (spec: "key by doc_id, never by path").
 */
export function createRegistryRoutes(deps: RegistryDeps = {}): Hono {
  const registryRoutes = new Hono();
  // `c` is threaded in so the origin travels with the notification. It is a hint
  // only — a client that omits or forges it just gets told to re-pull, which is
  // exactly the pre-existing behaviour. It never affects authorization.
  const changed = (c: { req: { header: (n: string) => string | undefined } }, vaultId: string) =>
    deps.onRegistryChanged?.(vaultId, c.req.header(ORIGIN_HEADER) ?? null);

  // ── vaults ─────────────────────────────────────────────────────────────────
  registryRoutes.post("/vaults", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const name = body.name;
    const organizationId = body.organizationId ?? session.activeOrganizationId;
    if (typeof name !== "string" || !name) {
      return c.json({ error: "name is required" }, 400);
    }
    if (typeof organizationId !== "string" || !organizationId) {
      return c.json({ error: "organizationId is required (no active org)" }, 400);
    }

    const role = await orgRole(organizationId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only vault owner/admin can create vaults" }, 403);
    }

    // Is this the org's FIRST note collection? Asked before the insert, because
    // the answer decides whether the default access posture applies (below).
    const { rows: existing } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM vaults WHERE organization_id = $1",
      [organizationId],
    );
    const isFirstVault = existing[0]?.n === "0";

    const id = randomUUID();
    await pool.query(
      "INSERT INTO vaults (id, organization_id, name) VALUES ($1, $2, $3)",
      [id, organizationId, name],
    );

    // Shared-with-team by default: a brand-new vault gets an org-wide `edit`
    // grant, so anyone invited can read and write its notes the moment they
    // join.
    //
    // This replaces an earlier private-by-default posture. That one was right
    // about solo vaults and wrong about what vaults are FOR: you invited
    // someone, and they landed on an empty sidebar with no way to ask for
    // access. Owners can still lock a vault down — Access panel → Private
    // (`setVaultMode` in AccessPanel.tsx) sends `PUT /api/orgs/:orgId/team-access`,
    // which drops this row AND every per-folder/per-file org grant with it.
    //
    // Only on the first collection. The grant is keyed on the ORG (one org can
    // own several collections and the grant covers all of them), so re-running
    // it later would resurrect a grant an owner had deliberately revoked —
    // silently re-opening a vault they had set to Private. A default is only a
    // default at creation time; after that the owner's choice is the truth.
    if (isFirstVault) {
      await pool.query(
        `INSERT INTO shares
           (id, org_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
         VALUES ($1, $2, 'vault', $2, 'org', $2, 'edit', $3)
         ON CONFLICT (resource_type, resource_id, principal_type, principal_id) DO NOTHING`,
        [randomUUID(), organizationId, session.userId],
      );
    }
    return c.json({ id, organizationId, name, rootFrozen: false }, 201);
  });

  registryRoutes.get("/vaults", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const { rows } = await pool.query(
      `SELECT v.id, v.organization_id, v.name, v.created_at, v.root_frozen
         FROM vaults v
         JOIN member m ON m."organizationId" = v.organization_id
        WHERE m."userId" = $1
        ORDER BY v.created_at ASC`,
      [session.userId],
    );
    return c.json({ vaults: rows });
  });

  /**
   * Vault-level settings. Today that is one latch: `rootFrozen`.
   *
   * Owner/admin only to WRITE; every member reads it from `GET /api/vaults`, so
   * a member's Settings page shows the toggle in its real state (disabled) and
   * their client can explain a refusal before the server has to.
   */
  registryRoutes.patch("/vaults/:vaultId", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner or admin can change vault settings" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.rootFrozen !== "boolean") {
      return c.json({ error: "rootFrozen (boolean) required" }, 400);
    }
    const { rows } = await pool.query<{ id: string; name: string; root_frozen: boolean }>(
      "UPDATE vaults SET root_frozen = $2 WHERE id = $1 RETURNING id, name, root_frozen",
      [vaultId, body.rootFrozen],
    );
    // Every open client re-pulls the registry on this frame, which is also how
    // they learn the latch moved — no separate broadcast to keep in step.
    changed(c, vaultId);
    return c.json({ id: rows[0].id, name: rows[0].name, rootFrozen: rows[0].root_frozen }, 200);
  });

  /**
   * The vault's WHOLE structure, unfiltered — folders, notes and files, ids and
   * paths, no content. Owner/admin only.
   *
   * Every other listing here is ACL-filtered, which is right for sync and fatal
   * for administration: the moment an item is set to Private it leaves
   * `GET /api/notes`, its file leaves the manager's disk, and the Access panel —
   * which was drawing its list from that disk — lost the only row you could
   * un-Private it from. A restriction you cannot see is a restriction you cannot
   * lift.
   *
   * Deliberately a separate endpoint rather than a flag on the sync listings.
   * Those feed the reconciler, and an unfiltered response reaching it would have
   * the client materialise notes it has no right to sync. The two must not be
   * one call with a mode switch.
   */
  registryRoutes.get("/vaults/:vaultId/access-tree", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    const role = await orgRole(org, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only a vault owner or admin can manage access" }, 403);
    }
    const [folders, notes, files] = await Promise.all([
      pool.query<{ id: string; path: string; color: string | null }>(
        "SELECT id, path, color FROM folders WHERE vault_id = $1 ORDER BY path",
        [vaultId],
      ),
      // Paths and titles only. This bypasses the ACL, so it carries the minimum
      // that lets someone administer the tree and nothing that would let them
      // read a note they've shut themselves out of.
      pool.query<{ id: string; rel_path: string }>(
        "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path",
        [vaultId],
      ),
      // `files` rows — the tree binaries. They are docs like any note (one
      // `shares.resource_type = 'file'` namespace, one `effectivePermission`),
      // so leaving them out made a `.pdf` in a shared folder the one thing in
      // the vault whose access could be enforced but never seen or set.
      // A hidden root `attachments/` blob has no `files` row at all — its bytes
      // carry a null `doc_id` — so nothing here has to filter it out.
      pool.query<{ id: string; path: string }>(
        "SELECT id, path FROM files WHERE vault_id = $1 ORDER BY path",
        [vaultId],
      ),
    ]);
    return c.json({
      folders: folders.rows.map((f) => ({ id: f.id, path: f.path, color: f.color })),
      notes: notes.rows.map((n) => ({ id: n.id, relPath: n.rel_path })),
      files: files.rows.map((f) => ({ id: f.id, path: f.path })),
    });
  });

  /**
   * Second opinion on a set of docs, before the client deletes their files.
   *
   * `GET /api/notes` and the vault channel's `ready.revoked` both come from
   * `listReadableDocsInVault` — one function, so "absent from the listing" and
   * "named as revoked" are not two answers, they are the same answer read twice.
   * A regression inside that resolver would therefore make a client both see an
   * empty listing AND be told the docs were revoked, which is precisely the
   * authority it needs to remove every one of them, outright and uncapped.
   *
   * This route is the independent one. It answers per doc through
   * `permissions/resolver.ts effectivePermission` — different SQL, a different
   * walk (`locateDoc` + parent chain) — and the two are held in agreement by
   * `tests/vault-docs.test.ts` rather than by sharing code. So a bug in either
   * alone shows up here as a DISAGREEMENT, and the client's rule is that a
   * disagreement leaves the file on disk.
   *
   * Member-gated only: a member asking "may I still read the notes I already
   * hold?" is asking about ids they already have. It names nothing back — the
   * response is the subset that resolves to `none`, so it cannot be used to
   * enumerate a vault.
   *
   * **An id is either ANSWERED or left out.** Only ids with a row in THIS vault
   * reach the resolver; anything else — an id from another vault, an id that was
   * never here — is simply absent from `none`, and the client's rule for an
   * unanswered id is to keep the file. Reporting those as `none` would have been
   * a false confirmation on the one route whose entire job is to be a second
   * opinion: an id the caller can read perfectly well in a different vault would
   * have come back corroborated-unreadable. A doc that is merely REVOKED still
   * has a live row here, so a real revocation always reaches the resolver and is
   * always answered.
   */
  registryRoutes.post("/vaults/:vaultId/access-check", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.param("vaultId");
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const docIds: unknown = (body as { docIds?: unknown }).docIds;
    if (!Array.isArray(docIds)) return c.json({ error: "docIds array required" }, 400);
    const ids = [...new Set(docIds.filter((d): d is string => typeof d === "string" && d !== ""))];
    // Bounded like every other list this protocol carries: a caller asking about
    // more docs than a vault channel will name in one frame is not a client.
    if (ids.length > ACCESS_CHECK_MAX) {
      return c.json({ error: `at most ${ACCESS_CHECK_MAX} docIds per request` }, 400);
    }
    // Scoped to THIS vault. An id with no row here is left UNANSWERED (see the
    // doc comment) rather than reported as unreadable. No `deleted_at` filter:
    // a soft-deleted note does have a row, and it should reach the resolver,
    // which answers `none` for it through `locateDoc`.
    //
    // `files` as well as `notes`, and for the same reason `locateDoc` unions the
    // two: a tree binary's id IS a doc id. Leaving it out made a revoked `.pdf`
    // permanently UNANSWERED, which the desktop reads as "no second opinion" and
    // so leaves the whole group on disk — the file stayed readable on the disk of
    // someone who had just been shut out of it.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM notes WHERE vault_id = $1 AND id = ANY($2::text[])
       UNION
       SELECT id FROM files WHERE vault_id = $1 AND id = ANY($2::text[])`,
      [vaultId, ids],
    );
    const present = new Set(rows.map((r) => r.id));
    const inVault = ids.filter((id) => present.has(id));
    // Bounded concurrency rather than a sequential await per doc.
    // `effectivePermission` is roughly seven queries (locate, ancestry, two
    // deny checks, role, vault baseline, share), so 2000 ids in series is
    // thousands of sequential round trips holding one pool connection — tens of
    // seconds on a managed database, and any proxy timeout in front of it turns
    // this into the client's "no answer, remove nothing" branch on every pass.
    // The same width the vault channel backfills at.
    const none: string[] = [];
    await runPool(inVault, config.backfillConcurrency, async (id) => {
      if ((await effectivePermission(session.userId, id)) === "none") none.push(id);
    });
    return c.json({ none });
  });

  // ── folders ──────────────────────────────────────────────────────────────
  registryRoutes.post("/folders", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const { vaultId, name, path, parentId } = body;
    if (typeof vaultId !== "string" || typeof name !== "string" || typeof path !== "string") {
      return c.json({ error: "vaultId, name, path are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    // Everything below the auth gate is `registry/batch-ops.ts registerFolder`
    // — the same adopt-by-path → resolve-parent → write-gate → frozen-root →
    // insert → 23505-adopt sequence the `/folders/batch` route runs, so the two
    // surfaces cannot drift. This route decides only the HTTP shape.
    const ctx = registerCtx(vaultId, session.userId);
    const out = await registerFolder(ctx, {
      path,
      name,
      parentId: parentId ?? null,
      color: body.color,
      sort: body.sort,
    });
    if (out.status === "error") {
      if (out.code === "note_limit_reached") return c.json({ error: out.message, code: out.code, limit: 20000 }, 402);
      if (out.code === "path_folder_mismatch") return c.json({ error: out.message, code: out.code }, 400);
      if (out.code === "root_frozen") return c.json(ROOT_FROZEN_ERROR, 403);
      return c.json(NO_WRITE_ACCESS_ERROR("folder"), 403);
    }
    const f = out.row;
    if (out.status === "adopted") {
      return c.json({ id: f.id, vaultId, parentId: f.parentId, name: f.name, path: f.path }, 200);
    }
    changed(c, vaultId);
    return c.json(
      { id: f.id, vaultId, parentId: f.parentId, name: f.name, path: f.path, color: f.color },
      201,
    );
  });

  registryRoutes.get("/folders", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.query("vaultId");
    if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
    const org = await vaultOrg(vaultId);
    // A vault row that is GONE answers 404, never `200 []`. This is the only
    // thing standing between a teammate's disk and a mass delete: after a vault
    // is deleted or unsynced, every client's readable set is empty, and an
    // empty 200 here reads as "everything you hold was revoked" — the inbound
    // planner would then remove the lot. The listing has to THROW (R1).
    if (!org) return c.json({ error: "vault_not_found" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const page = readPage(c);
    if (page === "invalid") {
      return c.json({ error: `limit must be an integer 1..${PAGE_LIMIT_MAX}` }, 400);
    }
    // Private-by-default: only folders the caller may see (created / shared /
    // path-to-a-shared-note). Owner/admin + Open vaults see everything.
    const all = await listVisibleFolders(session.userId, vaultId);
    if (!page) {
      // Folder tombstones ride the same response as note tombstones do on
      // GET /api/notes, and for the same reason: the client subtracts one set
      // from the other, so both must come from one snapshot. Ids only — an id is
      // the minimum that lets a client stop re-registering (and remove) a local
      // folder, and it leaks nothing about what the folder was called.
      const { rows: tombstones } = await pool.query<{ id: string }>(
        "SELECT id FROM folder_tombstones WHERE vault_id = $1",
        [vaultId],
      );
      return c.json({ folders: all, tombstones: tombstones.map((t) => t.id) });
    }
    // Cut in memory rather than in SQL: `listVisibleFolders` already resolves the
    // whole visible set through several recursive CTEs and returns it, so a
    // SQL-side LIMIT would page the folders table and then discard most of it
    // anyway. A vault has orders of magnitude fewer folders than notes, which is
    // why this one can afford to be honest about that. `compareC` matches the
    // notes' `COLLATE "C"` so one cursor convention covers all three listings.
    const sorted = [...all].sort((a, b) => compareC(a.path, b.path));
    const from = page.after === null ? sorted : sorted.filter((f) => compareC(f.path, page.after!) > 0);
    const window = from.slice(0, page.limit);
    const more = from.length > page.limit;
    if (more) return c.json({ folders: window, nextAfter: window[window.length - 1].path });
    const { rows: tombstones } = await pool.query<{ id: string }>(
      "SELECT id FROM folder_tombstones WHERE vault_id = $1",
      [vaultId],
    );
    return c.json({ folders: window, tombstones: tombstones.map((t) => t.id), nextAfter: null });
  });

  /**
   * The vault's tree BINARIES, ACL-filtered — the listing `files` never had.
   *
   * Until now a client learned about them only from the owner/admin
   * `GET /vaults/:id/access-tree` or from the unpaginated whole-vault
   * `GET /vaults/:id/blobs`, neither of which a scoped member can page through.
   * Same shape and same cursor convention as `/notes`, minus tombstones: a
   * `files` row is hard-deleted (see `DELETE /files/:id`), so there is no
   * tombstone to carry and absence already means gone.
   */
  registryRoutes.get("/files", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.query("vaultId");
    if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
    const org = await vaultOrg(vaultId);
    // A vault row that is GONE answers 404, never `200 []`. This is the only
    // thing standing between a teammate's disk and a mass delete: after a vault
    // is deleted or unsynced, every client's readable set is empty, and an
    // empty 200 here reads as "everything you hold was revoked" — the inbound
    // planner would then remove the lot. The listing has to THROW (R1).
    if (!org) return c.json({ error: "vault_not_found" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const page = readPage(c);
    if (page === "invalid") {
      return c.json({ error: `limit must be an integer 1..${PAGE_LIMIT_MAX}` }, 400);
    }
    const SELECT = `SELECT id, vault_id, folder_id, path, created_at
         FROM files WHERE vault_id = $1`;
    const { rows } = page
      ? await pool.query(
          `${SELECT} AND ($3::text IS NULL OR path COLLATE "C" > $3::text)
            ORDER BY path COLLATE "C" LIMIT $2`,
          [vaultId, page.limit + 1, page.after],
        )
      : await pool.query(`${SELECT} ORDER BY path`, [vaultId]);
    const more = page !== null && rows.length > page.limit;
    const window = more ? rows.slice(0, page!.limit) : rows;
    // The SAME readable set the notes listing uses: a `files` id IS a doc id, so
    // a folder share reaches the binaries in it exactly as it reaches the notes.
    const readable = await listReadableDocsInVault(session.userId, vaultId);
    const files = window.filter((f) => readable.has(f.id));
    if (more) return c.json({ files, nextAfter: window[window.length - 1].path as string });
    return c.json({ files, ...(page ? { nextAfter: null } : {}) });
  });

  // Rename / move a folder. Rewrites the folder's own row AND every descendant
  // folder + note's path prefix (old → new) in place — ids are untouched, so
  // backlinks and CRDT docs survive the move.
  registryRoutes.patch("/folders/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { rows } = await pool.query(
      "SELECT vault_id, path FROM folders WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown folder" }, 404);
    // Edit permission on the folder itself (not bare membership): owner/admin,
    // the folder's creator, or an edit share. Blocks renaming/moving folders a
    // member has no rights on.
    if (!(await canEditFolder(session.userId, id))) {
      return c.json({ error: "You cannot modify this folder" }, 403);
    }
    const newParentId = body.parentId === undefined ? undefined : (body.parentId ?? null);
    const moveInput = {
      path: typeof body.path === "string" ? body.path : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      parentId: newParentId,
    };
    // Resolve where the folder will land BEFORE gating: a `path`-only move to
    // another directory (or to the root) is a re-parent whether or not the
    // caller said `parentId`, and both gates below must see the real target.
    const current = (await findFolder(pool, id))!;
    let plan;
    try {
      plan = await planFolderMove(pool, current, moveInput);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }
    // Re-parenting under another folder must not be a way to change inherited
    // access: require edit on the destination parent too (root/null is fine).
    if (
      plan.parentId != null &&
      plan.parentId !== current.parent_id &&
      !(await canEditFolder(session.userId, plan.parentId))
    ) {
      return c.json({ error: "You cannot move this folder there" }, 403);
    }

    // Moving a folder OUT to the root is a root creation by another name.
    if (plan.parentId === null && current.parent_id !== null && (await isRootFrozen(row.vault_id))) {
      return c.json(ROOT_FROZEN_ERROR, 403);
    }

    // Color is a vault-wide fact about the folder, so it rides the same PATCH
    // and syncs to every member like a rename does.
    const color = normalizeColor(body.color);
    if (color !== undefined) {
      await pool.query("UPDATE folders SET color = $2 WHERE id = $1", [id, color]);
    }

    try {
      const moved = await moveFolder(pool, id, moveInput);
      changed(c, moved.vaultId);
      return c.json(
        { id, vaultId: moved.vaultId, name: moved.name, path: moved.path, color },
        200,
      );
    } catch (err) {
      if (err instanceof TreeOpError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Delete a folder subtree: soft-delete its notes (they keep their doc_id so a
  // teammate who has one open just loses tree visibility), then remove the
  // folder rows (ON DELETE CASCADE clears descendant folders).
  registryRoutes.delete("/folders/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const { rows } = await pool.query(
      "SELECT vault_id, path FROM folders WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown folder" }, 404);
    if (!(await canEditFolder(session.userId, id))) {
      return c.json({ error: "You cannot delete this folder" }, 403);
    }
    const { deletedNoteIds } = await deleteFolderCascade(pool, id);
    // Their derived index rows go with them (see the single-note delete below)…
    await purgeNoteIndex(deletedNoteIds);
    changed(c, row.vault_id);
    // …and anyone with one of them open is kicked off the now-gone doc. Without
    // this a folder delete left live editors happily typing into notes that no
    // longer exist anywhere in the tree — the single-note delete has always done
    // it, and there's no reason a cascade should be gentler.
    //
    // Moved OFF the response path: a 500-note cascade ran 500 of these in one
    // un-yielded tick, on the event loop the HTTP and WebSocket listeners share,
    // while the caller waited. `evictDoc` where it exists, because the rows are
    // gone and a cached `Y.Doc` handed to the next connect would re-materialise
    // the very state we just deleted; `disconnectDoc` remains the fallback.
    if (deletedNoteIds.length > 0) {
      const vaultId = row.vault_id;
      setImmediate(() => {
        void (async () => {
          for (const docId of deletedNoteIds) {
            try {
              if (deps.evictDoc) await deps.evictDoc(vaultId, docId);
              else deps.disconnectDoc?.(vaultId, docId);
            } catch (err) {
              console.warn(`[registry] evicting ${docId} after a folder delete failed:`, err);
            }
          }
        })();
      });
    }
    return c.json({ ok: true }, 200);
  });

  // ── notes (markdown docs; id == doc_id) ────────────────────────────────────
  registryRoutes.post("/notes", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const { vaultId, folderId, title, relPath } = body;
    if (typeof vaultId !== "string" || typeof relPath !== "string") {
      return c.json({ error: "vaultId and relPath are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    // Shared with `/notes/batch` — see `registry/batch-ops.ts registerNote` for
    // the sequence and the incidents each step closes.
    const ctx = registerCtx(vaultId, session.userId);
    const out = await registerNote(ctx, {
      relPath,
      docId: typeof body.docId === "string" ? body.docId : undefined,
      folderId: folderId ?? null,
      title: title ?? null,
      color: body.color,
    });
    if (out.status === "conflict") {
      return c.json({ error: out.message, code: out.code, docId: out.id }, 409);
    }
    if (out.status === "error") {
      if (out.code === "note_limit_reached") return c.json({ error: out.message, code: out.code, limit: 20000 }, 402);
      if (out.code === "path_folder_mismatch") return c.json({ error: out.message, code: out.code }, 400);
      if (out.code === "root_frozen") return c.json(ROOT_FROZEN_ERROR, 403);
      return c.json(NO_WRITE_ACCESS_ERROR("note"), 403);
    }
    const n = out.row;
    const payload = {
      id: n.id,
      docId: n.id,
      vaultId,
      folderId: n.folderId,
      title: n.title,
      relPath: n.relPath,
    };
    if (out.status === "adopted") return c.json(payload, 200);
    changed(c, vaultId);
    return c.json(payload, 201);
  });

  registryRoutes.get("/notes", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const vaultId = c.req.query("vaultId");
    if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
    const org = await vaultOrg(vaultId);
    // A vault row that is GONE answers 404, never `200 []`. This is the only
    // thing standing between a teammate's disk and a mass delete: after a vault
    // is deleted or unsynced, every client's readable set is empty, and an
    // empty 200 here reads as "everything you hold was revoked" — the inbound
    // planner would then remove the lot. The listing has to THROW (R1).
    if (!org) return c.json({ error: "vault_not_found" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    const page = readPage(c);
    if (page === "invalid") {
      return c.json({ error: `limit must be an integer 1..${PAGE_LIMIT_MAX}` }, 400);
    }
    // last_edited_* rides this pull deliberately: the file rows that show
    // "edited by X" are already re-fetched on every `registry` frame, so
    // attribution stays live without a second endpoint or a new wire frame.
    const SELECT = `SELECT n.id, n.vault_id, n.folder_id, n.title, n.rel_path, n.doc_id, n.created_by,
              n.created_at, n.updated_at, n.color,
              n.last_edited_by, u.name AS last_edited_by_name, n.last_edited_at
         FROM notes n
         LEFT JOIN "user" u ON u.id = n.last_edited_by
        WHERE n.vault_id = $1 AND n.deleted_at IS NULL`;
    // One row past the limit is read, never returned: it is the only honest
    // proof that another page exists. Ordered by `rel_path COLLATE "C"` against
    // the m030 index, so the cursor is an index seek rather than an offset scan.
    const { rows } = page
      ? await pool.query(
          `${SELECT} AND ($3::text IS NULL OR n.rel_path COLLATE "C" > $3::text)
            ORDER BY n.rel_path COLLATE "C" LIMIT $2`,
          [vaultId, page.limit + 1, page.after],
        )
      : await pool.query(`${SELECT} ORDER BY n.rel_path`, [vaultId]);
    const more = page !== null && rows.length > page.limit;
    const window = more ? rows.slice(0, page!.limit) : rows;
    // Private-by-default: hide notes the caller can't read (leaks title/path and
    // would make the client materialize a note it can't sync). Owner/admin +
    // Open vaults get the full set from the readable-docs resolver.
    //
    // Applied AFTER the page is cut, so the cursor advances over rows the caller
    // may not see instead of stalling on them. A page may therefore come back
    // shorter than `limit` — or empty — while `nextAfter` is still set; that is
    // correct, and the client's stop condition is `nextAfter`, never the count.
    const readable = await listReadableDocsInVault(session.userId, vaultId);
    const notes = window.filter((n) => readable.has(n.id));
    const nextAfter = more ? (window[window.length - 1].rel_path as string) : null;
    // Tombstones ride the SAME response as the notes, deliberately. The client's
    // whole reason for asking is to subtract one set from the other, and two
    // requests would let a note deleted in between land in neither list (or, on
    // the other ordering, in both) — forcing the client to invent a precedence
    // rule. One request, one snapshot, no rule needed.
    //
    // Which is exactly why a paginated read carries them on the LAST page only:
    // the subtraction is meaningful against the whole listing, never against a
    // page of it, and a client that saw tombstones mid-scan would delete files
    // whose live rows it had not reached yet.
    //
    // Ids only, no path or title: this is the signal that lets a client delete a
    // local file, so it carries the minimum that can justify that.
    if (more) return c.json({ notes, nextAfter });
    const tombstones = await listDeletedReadableDocsInVault(session.userId, vaultId);
    return c.json({ notes, tombstones: [...tombstones], ...(page ? { nextAfter: null } : {}) });
  });

  // Rename / move a single note (rel_path / folder / title). doc_id unchanged.
  registryRoutes.patch("/notes/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const { rows } = await pool.query(
      "SELECT vault_id, rel_path, title, folder_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown note" }, 404);
    // Edit permission on the note itself (owner/admin, creator, or edit share),
    // not bare membership. This also closes the relocate-to-escalate path: a
    // member with no access to the note can't rename/move it at all.
    if (!(await canEditDoc(session.userId, id))) {
      return c.json({ error: "You cannot modify this note" }, 403);
    }
    const folderId = body.folderId === undefined ? undefined : (body.folderId ?? null);
    const moveInput = {
      relPath: typeof body.relPath === "string" ? body.relPath : undefined,
      title: body.title,
      folderId,
    };
    // Resolve the destination from the PATH first: a `relPath`-only move to
    // another folder (or out to the root) is a re-parent whether or not the
    // client also said `folderId`, and both gates below must judge the real one.
    const note = (await findNote(pool, id))!;
    let plan;
    try {
      plan = await planNoteMove(pool, note, moveInput);
    } catch (err) {
      if (err instanceof TreeOpError) return c.json(pathFolderMismatch(err), 400);
      throw err;
    }
    // Same rule the folder route has always had, applied here too: moving a note
    // INTO a folder must not be a way to hand out access to it. Folder grants
    // inherit down, so without this a member could take a note only they can read
    // and drop it into a team-shared folder, granting the whole team edit on it.
    if (
      plan.folderId != null &&
      plan.folderId !== row.folder_id &&
      !(await canEditFolder(session.userId, plan.folderId))
    ) {
      return c.json({ error: "You cannot move this note there" }, 403);
    }
    // Dragging a note out to the root is a root creation by another name —
    // unless it already lives there, which is a rename, not a move.
    if (plan.folderId === null && row.folder_id !== null && (await isRootFrozen(row.vault_id))) {
      return c.json(ROOT_FROZEN_ERROR, 403);
    }

    const color = normalizeColor(body.color);
    if (color !== undefined) {
      await pool.query("UPDATE notes SET color = $2 WHERE id = $1", [id, color]);
    }

    try {
      const moved = await moveNote(pool, id, moveInput);
      changed(c, moved.vaultId);
      return c.json(
        {
          id,
          docId: id,
          vaultId: moved.vaultId,
          relPath: moved.relPath,
          title: moved.title,
          folderId: moved.folderId,
          color,
        },
        200,
      );
    } catch (err) {
      if (err instanceof TreeOpError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Soft-delete a note (keeps its row/doc_id; excluded from the registry list).
  registryRoutes.delete("/notes/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const { rows } = await pool.query(
      "SELECT vault_id FROM notes WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    const row = rows[0];
    if (!row) return c.json({ error: "Unknown note" }, 404);
    // Edit permission required to destroy a note — not bare membership.
    if (!(await canEditDoc(session.userId, id))) {
      return c.json({ error: "You cannot delete this note" }, 403);
    }
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [id]);
    // Drop the DERIVED search/graph rows with the note. They are a rebuildable
    // cache of the canonical Yjs state (migration 005), and note_index keeps a
    // full plain-text copy of the body — leaving it behind grew those tables
    // without bound and kept "deleted" content readable server-side. The Yjs
    // doc and the doc_id survive untouched, so re-creating the note re-indexes
    // it on its next store (indexer.scheduleIndex / backfillIndex).
    await purgeNoteIndex([id]);
    changed(c, row.vault_id);
    return c.json({ ok: true }, 200);
  });

  // ── files (generic vault-file <-> doc mapping; id == doc_id) ────────────────
  registryRoutes.post("/files", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const { vaultId, folderId, path } = body;
    if (typeof vaultId !== "string" || typeof path !== "string") {
      return c.json({ error: "vaultId and path are required" }, 400);
    }
    const org = await vaultOrg(vaultId);
    if (!org) return c.json({ error: "Unknown vault" }, 404);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    // Client-supplied stable id, under either spelling: notes call it `docId`,
    // and the desktop's local `files.id` is sometimes sent as `id`. Both mean
    // the same thing — this doc's identity was minted on the device.
    const docId =
      (typeof body.docId === "string" && body.docId) ||
      (typeof body.id === "string" && body.id) ||
      undefined;
    // Shared with `/files/batch` — see `registry/batch-ops.ts registerFile`.
    const ctx = registerCtx(vaultId, session.userId);
    const out = await registerFile(ctx, { path, docId, folderId: folderId ?? null });
    if (out.status === "error") {
      if (out.code === "note_limit_reached") return c.json({ error: out.message, code: out.code, limit: 20000 }, 402);
      if (out.code === "path_folder_mismatch") return c.json({ error: out.message, code: out.code }, 400);
      if (out.code === "root_frozen") return c.json(ROOT_FROZEN_ERROR, 403);
      return c.json(NO_WRITE_ACCESS_ERROR("file"), 403);
    }
    const fileRow = out.row;
    if (out.wrote) changed(c, vaultId);
    return c.json(
      {
        id: fileRow.id,
        docId: fileRow.id,
        vaultId,
        folderId: fileRow.folderId,
        path: fileRow.path,
      },
      out.status === "created" ? 201 : 200,
    );
  });

  /**
   * Delete a tree file — the row AND the bytes behind it.
   *
   * The binary counterpart of `DELETE /notes/:id`, and deliberately not its
   * twin. A note is SOFT-deleted because its doc_id, its Yjs history and its
   * tombstone all have work left to do: the tombstone is how a teammate's
   * device tells a deletion from a revocation (`vault-docs.ts`). A file has
   * none of that. It owns no CRDT, `files` has no `deleted_at` column (see
   * migration 023's note), and no client removes a local binary on the strength
   * of a missing server row — so a hard delete costs nobody their bytes and
   * leaves nothing to reconcile. What it DOES do is make the file stop existing
   * for every listing at once: the readable set, `listDocsInVault`, the folder
   * tree, and — because the blobs go with it — `GET /vaults/:id/blobs`, which is
   * the one the desktop's attachment diff reads. Without that last part a file
   * deleted on one device came straight back down on the next pass, which is
   * the bug this route exists for.
   *
   * Idempotent: an id with no row answers 204, not 404. The goal state is "this
   * file is gone", a retried delete (an offline queue draining twice) has
   * reached it, and there is no membership to check on a row that isn't there —
   * so the answer is the same for an id that never existed, which tells a prober
   * nothing.
   */
  registryRoutes.delete("/files/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const id = c.req.param("id");
    const { rows } = await pool.query<{ vault_id: string; path: string }>(
      "SELECT vault_id, path FROM files WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return c.body(null, 204);
    const org = await vaultOrg(row.vault_id);
    if (!org || !(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }
    // The SAME gate that let these bytes be uploaded decides who may take them
    // away (`canWriteBlob` → `canCreateIn` on the file's folder): a Read-only
    // vault, a locked share or a sealed posture refuses both ends.
    if (!(await canWriteBlob(session.userId, { vault_id: row.vault_id, rel_path: row.path, doc_id: id }))) {
      return c.json(NO_WRITE_ACCESS_ERROR("file"), 403);
    }

    // Bytes first, row second. The other order would leave blobs whose `doc_id`
    // resolves to nothing if the process died between the two — and that is
    // exactly the shape `canReadAttachment` falls back to the path heuristic
    // for, i.e. bytes nobody can see and nothing will collect.
    const blobs = await deleteDocBlobs(id, row.vault_id);
    // Tombstone BEFORE the row goes, as a folder delete does. Without it the id
    // simply stops existing, and nothing on the server can say this file was
    // deleted rather than never registered — which is the first question when a
    // device turns up still holding the id. Re-registering the id stays allowed.
    await tombstoneFile(pool, id);
    await pool.query("DELETE FROM files WHERE id = $1", [id]);
    console.info(`[registry] deleted file ${row.path} (${id}) and ${blobs} blob(s)`);
    changed(c, row.vault_id);
    return c.body(null, 204);
  });

  return registryRoutes;
}

