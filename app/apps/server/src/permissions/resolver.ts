import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * Effective-permission resolver (spec 04 §3, plus locks).
 *
 *   1. Vault owner/admin  -> `edit` on everything in the vault, UNLESS the
 *      vault's posture withdraws it: Read-only and `sealed` take the shortcut
 *      AND the creator rule from everyone alike, and a vault that was simply
 *      never shared takes the shortcut only.
 *   2. Else take the MAX of: a share on the file itself, a share on a
 *      containing folder (walking parent_id up to the root), and a
 *      vault-scoped grant (org-wide "Open"/"Read-only", or per-user).
 *   3. `edit > view > none`. Folder grants inherit to descendants; a file
 *      share can only RAISE permission. No matching grant -> `none`.
 *
 * A plain `member` inherits the vault grant and so gets `edit` in a vault that
 * is Shared — which a new vault is, by default (`POST /api/vaults`). With no
 * grant at all (one created while private-by-default was the rule) people keep
 * the notes they created and nothing else — owners and admins included, since
 * nobody is exempt from a vault that was never shared. A vault someone actually
 * SET to Private is a different row and a stricter rule: see `sealed` in
 * {@link vaultBaseline}.
 *
 * Denies (permission = 'denied') come in two flavours, both resolved BEFORE the
 * rules above and both applying to owners and admins: a per-USER deny is
 * `none`, full stop; an ORG deny (the item set to Private) leaves only the
 * creator and explicit per-user grants. See {@link isDenied}.
 *
 * Locks (permission = 'locked') are a cap overlay resolved AFTER the rules
 * above: when a lock matches the doc or any ancestor folder — for this user
 * (principal_type 'user') or the whole vault (principal_type 'org') — the
 * result is capped at `view`. Owners/admins are capped too (the point of a
 * lock is protecting content from accidental edits); they can still unlock
 * via the shares API. A lock never GRANTS access: `none` stays `none`.
 */
export type Permission = "edit" | "view" | "none";

const RANK: Record<Permission, number> = { none: 0, view: 1, edit: 2 };

export function maxPermission(a: Permission, b: Permission): Permission {
  return RANK[a] >= RANK[b] ? a : b;
}

type Queryable = Pick<pg.Pool, "query">;

/**
 * A REQUEST-SCOPED memo for the inputs every doc in one batch shares.
 *
 * Read this before reaching for anything cleverer. The rule the whole ACL
 * depends on is **one permission algebra**: a second, set-based "editable docs"
 * query that disagreed with {@link effectivePermission} would not surface as a
 * 403, it would be a healing LOOP — the client is told a doc is empty, pushes,
 * is refused, and `ready.empty` names it again on the next connect, forever. So
 * this memoises the resolver's INPUTS and never its verdict:
 *
 *   · `role`, `snapshot` and `baseline` are facts about the (VAULT, user),
 *     identical for every item in a batch — read together by `membership`;
 *   · `ancestors` is a fact about a FOLDER, shared by every doc in it;
 *   · a doc's share ROWS (on it, its chain and its vault) are read once and the
 *     two denies, the grant and the lock are answered from them in memory, by
 *     predicates that mirror each SELECT clause for clause (`rowsDenied`,
 *     `rowsLocked`, `rowsGrants`);
 *   · `prefetch` loads location, chain and rows for a whole batch in three
 *     queries, for the routes that are about to resolve every one of them.
 *
 * The branch logic of {@link effectivePermission} runs unchanged on top, in the
 * same order. The answer for any one doc is bit-for-bit what an uncached call
 * returns — `tests/resolver-cache-drift.test.ts` and
 * `tests/resolver-prefetch-drift.test.ts` are the drift tests that say so.
 *
 * Scoped to one request deliberately: a longer-lived cache would keep serving a
 * role that was revoked or a posture that was just changed. Create one per
 * request, pass it down, throw it away.
 */
export interface ResolverCache {
  role(db: Queryable, organizationId: string, userId: string): Promise<string | null>;
  baseline(db: Queryable, organizationId: string): Promise<VaultPosture>;
  snapshot(db: Queryable, organizationId: string, userId: string): Promise<MemberAccessSnapshot | null>;
  ancestors(db: Queryable, folderId: string | null): Promise<string[]>;
  /**
   * Role, join snapshot and vault posture for one (vault, user) in ONE query,
   * seeding the three memos above. The values are exactly what the separate
   * queries return; only the round trips change.
   */
  membership(db: Queryable, organizationId: string, userId: string): Promise<MembershipFacts>;
  /**
   * Load the location, ancestor chain and every share row for many docs in a
   * constant number of queries (three), for a batch route that is about to
   * resolve all of them. Optional: a doc that was not prefetched (or was not
   * found by the prefetch) is resolved exactly as before, from the database.
   */
  prefetch(db: Queryable, docIds: readonly string[]): Promise<void>;
  /** A doc loaded by {@link prefetch}, or undefined (resolve it live). */
  preloaded(docId: string): PreloadedDoc | undefined;
}

/** The per-(vault, user) facts {@link ResolverCache.membership} returns. */
export interface MembershipFacts {
  role: string | null;
  snapshot: MemberAccessSnapshot | null;
  baseline: VaultPosture;
}

/** A doc's location and its full share-row set, as {@link ResolverCache.prefetch}
 *  loaded them — everything `effectivePermission` would otherwise SELECT. */
export interface PreloadedDoc {
  loc: DocLocation;
  folderIds: string[];
  /** Every share row on the doc (as a file), on each folder in `folderIds`, and
   *  on its vault resource. The predicates below filter them exactly as the
   *  per-query SQL does. */
  rows: ShareRow[];
}

/** Ids per {@link ResolverCache.prefetch} round (three queries each). */
const PREFETCH_CHUNK = 2000;

export function createResolverCache(): ResolverCache {
  const roles = new Map<string, Promise<string | null>>();
  const baselines = new Map<string, Promise<VaultPosture>>();
  const snapshots = new Map<string, Promise<MemberAccessSnapshot | null>>();
  const chains = new Map<string, Promise<string[]>>();
  const memberships = new Map<string, Promise<MembershipFacts>>();
  const preloadedDocs = new Map<string, PreloadedDoc>();
  // The promise is cached, not the value, so N concurrent resolves of the same
  // key share ONE in-flight query instead of racing to fill the entry.
  const memo = <T>(m: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> => {
    let hit = m.get(key);
    if (!hit) {
      hit = run();
      m.set(key, hit);
    }
    return hit;
  };
  return {
    role: (db, organizationId, userId) =>
      memo(roles, `${organizationId}\u0000${userId}`, () => memberRole(db, organizationId, userId)),
    baseline: (db, organizationId) =>
      memo(baselines, organizationId, () => vaultBaseline(db, organizationId)),
    snapshot: (db, organizationId, userId) =>
      memo(snapshots, `${organizationId}\u0000${userId}`, () =>
        memberAccessSnapshot(db, organizationId, userId),
      ),
    ancestors: (db, folderId) =>
      folderId === null
        ? Promise.resolve([])
        : memo(chains, folderId, () => ancestorFolderIds(db, folderId)),
    membership: (db, organizationId, userId) => {
      const key = `${organizationId}\u0000${userId}`;
      return memo(memberships, key, async () => {
        const facts = await membershipFacts(db, organizationId, userId);
        // Seed the single-fact memos so a later `role()` / `snapshot()` /
        // `baseline()` in the same request reads the SAME answer rather than a
        // second, possibly newer, one. An entry already there wins: whatever
        // this request saw first is what it keeps seeing.
        if (!roles.has(key)) roles.set(key, Promise.resolve(facts.role));
        if (!snapshots.has(key)) snapshots.set(key, Promise.resolve(facts.snapshot));
        if (!baselines.has(organizationId)) baselines.set(organizationId, Promise.resolve(facts.baseline));
        return {
          role: await roles.get(key)!,
          snapshot: await snapshots.get(key)!,
          baseline: await baselines.get(organizationId)!,
        };
      });
    },
    prefetch: async (db, docIds) => {
      const wanted = [...new Set(docIds)].filter((id) => !preloadedDocs.has(id));
      // Sliced so one listing of a whole vault is several bounded statements,
      // never one array the size of the vault.
      for (let i = 0; i < wanted.length; i += PREFETCH_CHUNK) {
        const slice = wanted.slice(i, i + PREFETCH_CHUNK);
        for (const [id, doc] of await prefetchDocs(db, slice)) preloadedDocs.set(id, doc);
      }
    },
    preloaded: (docId) => preloadedDocs.get(docId),
  };
}

/**
 * One organization's share rows and structure, loaded ONCE for a bulk read (the
 * Access panel's summaries resolve every note in a vault for several people).
 *
 * This is the same idea as {@link ResolverCache} one step further: it preloads
 * the rows `isDenied` / `isLocked` / `sharePermission` would each have SELECTed
 * and answers them with the same predicates in memory. Every branch of the
 * verdict still runs through {@link resolveAccessForUser}; only where the rows
 * come from changes. `accessIndexMatchesQueries` in `tests/access-index.test.ts`
 * is the drift test.
 *
 * Scoped to one request for the same reason the cache is.
 */
export interface ShareRow {
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  access_revision: string | number;
}

export interface AccessIndex {
  organizationId: string;
  /** `${resource_type}\u0000${resource_id}` → share rows on that resource. */
  shares: Map<string, ShareRow[]>;
  folders: Map<string, { parentId: string | null; vaultId: string; createdAt: Date }>;
  /** Live notes (deleted ones are absent, as `locateDoc` never sees them). */
  notes: Map<string, { vaultId: string; folderId: string | null; createdBy: string | null; createdAt: Date }>;
  files: Map<string, { vaultId: string; folderId: string | null; createdAt: Date }>;
}

const shareKey = (type: string, id: string) => `${type}\u0000${id}`;

export async function loadAccessIndex(db: Queryable, organizationId: string): Promise<AccessIndex> {
  const [folders, notes, files, shares] = await Promise.all([
    db.query<{ id: string; parent_id: string | null; vault_id: string; created_at: Date }>(
      `SELECT f.id, f.parent_id, f.vault_id, f.created_at
         FROM folders f JOIN vaults v ON v.id = f.vault_id
        WHERE v.organization_id = $1`,
      [organizationId],
    ),
    db.query<{ id: string; folder_id: string | null; vault_id: string; created_by: string | null; created_at: Date }>(
      `SELECT n.id, n.folder_id, n.vault_id, n.created_by, n.created_at
         FROM notes n JOIN vaults v ON v.id = n.vault_id
        WHERE v.organization_id = $1 AND n.deleted_at IS NULL`,
      [organizationId],
    ),
    db.query<{ id: string; folder_id: string | null; vault_id: string; created_at: Date }>(
      `SELECT fi.id, fi.folder_id, fi.vault_id, fi.created_at
         FROM files fi JOIN vaults v ON v.id = fi.vault_id
        WHERE v.organization_id = $1`,
      [organizationId],
    ),
    // Keyed by RESOURCE, not by shares.org_id: the per-doc queries match on
    // resource ids alone, so the index must hold exactly those rows.
    db.query<ShareRow>(
      `SELECT s.resource_type, s.resource_id, s.principal_type, s.principal_id,
              s.permission, s.access_revision
         FROM shares s
        WHERE (s.resource_type = 'vault' AND s.resource_id = $1)
           OR (s.resource_type = 'folder' AND s.resource_id IN (
                 SELECT f.id FROM folders f JOIN vaults v ON v.id = f.vault_id
                  WHERE v.organization_id = $1))
           OR (s.resource_type = 'file' AND s.resource_id IN (
                 SELECT n.id FROM notes n JOIN vaults v ON v.id = n.vault_id
                  WHERE v.organization_id = $1
                 UNION
                 SELECT fi.id FROM files fi JOIN vaults v ON v.id = fi.vault_id
                  WHERE v.organization_id = $1))`,
      [organizationId],
    ),
  ]);
  const index: AccessIndex = {
    organizationId,
    shares: new Map(),
    folders: new Map(folders.rows.map((r) => [r.id, { parentId: r.parent_id, vaultId: r.vault_id, createdAt: r.created_at }])),
    notes: new Map(notes.rows.map((r) => [r.id, { vaultId: r.vault_id, folderId: r.folder_id, createdBy: r.created_by, createdAt: r.created_at }])),
    files: new Map(files.rows.map((r) => [r.id, { vaultId: r.vault_id, folderId: r.folder_id, createdAt: r.created_at }])),
  };
  for (const row of shares.rows) {
    const key = shareKey(row.resource_type, row.resource_id);
    const list = index.shares.get(key);
    if (list) list.push(row);
    else index.shares.set(key, [row]);
  }
  return index;
}

/** The folder itself and its ancestors, like {@link ancestorFolderIds}; null
 *  when the chain leaves the index (the caller then asks the database). */
export function indexedAncestors(index: AccessIndex, folderId: string | null): string[] | null {
  if (!folderId) return [];
  const chain: string[] = [];
  const seen = new Set<string>();
  let id: string | null = folderId;
  while (id !== null) {
    const folder = index.folders.get(id);
    if (!folder || seen.has(id)) return null;
    seen.add(id);
    chain.push(id);
    id = folder.parentId;
  }
  return chain;
}

/** Share rows on a doc (as a file resource) and on each folder in the chain. */
function indexedRows(index: AccessIndex, docId: string | null, folderIds: string[], vault?: string): ShareRow[] {
  const rows: ShareRow[] = [];
  if (docId !== null) rows.push(...(index.shares.get(shareKey("file", docId)) ?? []));
  for (const folderId of folderIds) rows.push(...(index.shares.get(shareKey("folder", folderId)) ?? []));
  if (vault !== undefined) rows.push(...(index.shares.get(shareKey("vault", vault)) ?? []));
  return rows;
}

/**
 * The per-query predicates, over an already-loaded row list. Each mirrors one
 * SELECT below clause for clause — {@link isDenied}, {@link isLocked} and the
 * grant read in {@link sharePermission} — and both the {@link AccessIndex} and
 * the {@link ResolverCache} paths answer through these, so there is exactly one
 * in-memory copy of each rule to keep in step with its SQL.
 *
 * `rows` may hold rows on resources the SQL would not consider (a vault row for
 * the deny/lock checks); the resource filter here drops them, so a caller can
 * pass one superset to all three.
 */
function rowsDenied(rows: readonly ShareRow[], principalType: "user" | "org", principalId: string): boolean {
  return rows.some((r) =>
    (r.resource_type === "file" || r.resource_type === "folder") &&
    r.permission === "denied" && r.principal_type === principalType && r.principal_id === principalId,
  );
}

function rowsLocked(rows: readonly ShareRow[], userId: string): boolean {
  return rows.some((r) =>
    (r.resource_type === "file" || r.resource_type === "folder") &&
    (r.permission === "locked" || r.permission === "readonly") &&
    (r.principal_type === "org" || (r.principal_type === "user" && r.principal_id === userId)),
  );
}

function rowsGrants(
  rows: readonly ShareRow[],
  userId: string,
  organizationId: string,
  orgClause: boolean,
): ShareRow[] {
  return rows.filter((r) =>
    (r.resource_type === "file" || r.resource_type === "folder" ||
      (r.resource_type === "vault" && r.resource_id === organizationId)) &&
    (r.permission === "view" || r.permission === "edit" || r.permission === "readonly") &&
    ((r.principal_type === "user" && r.principal_id === userId) ||
      (orgClause && r.principal_type === "org" && r.principal_id === organizationId)),
  );
}

/** In-memory {@link isDenied}. The file branch matches `resource_type = 'file'`. */
function indexedIsDenied(
  index: AccessIndex,
  principalType: "user" | "org",
  principalId: string,
  docId: string | null,
  folderIds: string[],
): boolean {
  return rowsDenied(indexedRows(index, docId, folderIds), principalType, principalId);
}

/** In-memory {@link isLocked}: an org row matches whatever its principal id. */
function indexedIsLocked(index: AccessIndex, userId: string, docId: string | null, folderIds: string[]): boolean {
  return rowsLocked(indexedRows(index, docId, folderIds), userId);
}

/** In-memory row set of {@link sharePermission}'s SELECT. */
function indexedGrantRows(
  index: AccessIndex,
  userId: string,
  docId: string | null,
  folderIds: string[],
  organizationId: string,
  orgClause: boolean,
): ShareRow[] {
  return rowsGrants(indexedRows(index, docId, folderIds, organizationId), userId, organizationId, orgClause);
}

/**
 * Every share row {@link isDenied}, {@link isLocked} and {@link sharePermission}
 * could match for one doc — on the doc as a file, on each folder in its chain,
 * and on its vault resource — in ONE read, for the cached path to filter in
 * memory instead of asking four times.
 *
 * Narrowed to org rows and THIS user's rows: every one of the four predicates
 * names either an org principal or `principal_id = userId`, so another
 * member's per-user rows can never match and need not cross the wire.
 */
async function docShareRows(
  db: Queryable,
  userId: string,
  docId: string,
  folderIds: string[],
  organizationId: string,
): Promise<ShareRow[]> {
  const { rows } = await db.query<ShareRow>(
    `SELECT resource_type, resource_id, principal_type, principal_id, permission, access_revision
       FROM shares
      WHERE ((resource_type = 'file' AND resource_id = $1)
          OR (resource_type = 'folder' AND resource_id = ANY($2::text[]))
          OR (resource_type = 'vault' AND resource_id = $3))
        AND (principal_type = 'org' OR (principal_type = 'user' AND principal_id = $4))`,
    [docId, folderIds, organizationId, userId],
  );
  return rows;
}

/**
 * {@link ResolverCache.prefetch}: locations, ancestor chains and share rows for
 * many docs in three queries, whatever the count or the depth.
 *
 * Conservative by construction — a doc is preloaded only when the batch read
 * provably saw what the per-doc reads would have:
 *   · a live note or a files row (never a soft-deleted note: those resolve live,
 *     through `includeDeleted`), joined to its vault exactly like `locateDoc`;
 *   · NOT when the id has both a note and a files row, where `locateDoc`'s
 *     `UNION ALL … LIMIT 1` is the authority on which one wins;
 *   · NOT when its folder chain loops (the per-doc walk would never finish, and
 *     a guess here would be a verdict nobody else reaches).
 * Anything left out is simply resolved the old way.
 */
async function prefetchDocs(db: Queryable, docIds: string[]): Promise<Map<string, PreloadedDoc>> {
  const out = new Map<string, PreloadedDoc>();
  const { rows: located } = await db.query<{
    id: string;
    vault_id: string;
    folder_id: string | null;
    created_by: string | null;
    created_at: Date;
    organization_id: string;
  }>(
    `SELECT n.id, n.vault_id, n.folder_id, n.created_by, n.created_at, v.organization_id
       FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE n.id = ANY($1::text[]) AND n.deleted_at IS NULL
     UNION ALL
     SELECT fi.id, fi.vault_id, fi.folder_id, NULL::text, fi.created_at, v.organization_id
       FROM files fi JOIN vaults v ON v.id = fi.vault_id
      WHERE fi.id = ANY($1::text[])`,
    [docIds],
  );
  const seen = new Map<string, number>();
  for (const r of located) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  const unique = located.filter((r) => seen.get(r.id) === 1);
  if (unique.length === 0) return out;

  const startFolders = [...new Set(unique.map((r) => r.folder_id).filter((f): f is string => f !== null))];
  const parents = new Map<string, string | null>();
  if (startFolders.length > 0) {
    // UNION, not UNION ALL: shared ancestors are read once, and a cycle ends.
    const { rows } = await db.query<{ id: string; parent_id: string | null }>(
      `WITH RECURSIVE chain AS (
          SELECT id, parent_id FROM folders WHERE id = ANY($1::text[])
          UNION
          SELECT f.id, f.parent_id
            FROM folders f
            JOIN chain c ON f.id = c.parent_id
       )
       SELECT id, parent_id FROM chain`,
      [startFolders],
    );
    for (const r of rows) parents.set(r.id, r.parent_id);
  }
  // The same walk as `ancestorFolderIds`: the folder itself, then each parent
  // that still exists, stopping at the root or at a parent with no row.
  const chainOf = (folderId: string | null): string[] | null => {
    const chain: string[] = [];
    const visited = new Set<string>();
    let id = folderId;
    while (id !== null && parents.has(id)) {
      if (visited.has(id)) return null;
      visited.add(id);
      chain.push(id);
      id = parents.get(id) ?? null;
    }
    return chain;
  };

  const docs: Array<{ row: (typeof unique)[number]; folderIds: string[] }> = [];
  for (const row of unique) {
    const folderIds = chainOf(row.folder_id);
    if (folderIds) docs.push({ row, folderIds });
  }
  if (docs.length === 0) return out;

  const folderIds = [...new Set(docs.flatMap((d) => d.folderIds))];
  const orgIds = [...new Set(docs.map((d) => d.row.organization_id))];
  const { rows: shareRows } = await db.query<ShareRow>(
    `SELECT resource_type, resource_id, principal_type, principal_id, permission, access_revision
       FROM shares
      WHERE (resource_type = 'file' AND resource_id = ANY($1::text[]))
         OR (resource_type = 'folder' AND resource_id = ANY($2::text[]))
         OR (resource_type = 'vault' AND resource_id = ANY($3::text[]))`,
    [docs.map((d) => d.row.id), folderIds, orgIds],
  );
  const byResource = new Map<string, ShareRow[]>();
  for (const r of shareRows) {
    const key = shareKey(r.resource_type, r.resource_id);
    const list = byResource.get(key);
    if (list) list.push(r);
    else byResource.set(key, [r]);
  }
  for (const { row, folderIds: chain } of docs) {
    const rows: ShareRow[] = [...(byResource.get(shareKey("file", row.id)) ?? [])];
    for (const f of chain) rows.push(...(byResource.get(shareKey("folder", f)) ?? []));
    rows.push(...(byResource.get(shareKey("vault", row.organization_id)) ?? []));
    out.set(row.id, {
      loc: {
        vaultId: row.vault_id,
        folderId: row.folder_id,
        organizationId: row.organization_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
      },
      folderIds: chain,
      rows,
    });
  }
  return out;
}

export interface DocLocation {
  vaultId: string;
  folderId: string | null;
  organizationId: string;
  /** Creator of the note (null for files, which have no creator column). */
  createdBy: string | null;
  createdAt: Date;
}

/**
 * Locate a doc's note collection, folder, and owning organization (the
 * user-facing vault). A doc_id maps to a `notes` row (rich registry) or a
 * `files` row (id == doc_id); we accept either.
 */
async function locateDoc(
  db: Queryable,
  docId: string,
  /** Also locate a soft-deleted note (Trash reads, restores, pushes into a
   *  tombstoned doc). Everything else keeps treating a deleted doc as absent. */
  includeDeleted = false,
): Promise<DocLocation | null> {
  const { rows } = await db.query<{
    vault_id: string;
    folder_id: string | null;
    organization_id: string;
    created_by: string | null;
    created_at: Date;
  }>(
    `SELECT loc.vault_id, loc.folder_id, loc.created_by, loc.created_at, v.organization_id
       FROM (
         SELECT vault_id, folder_id, created_by, created_at FROM notes  WHERE id = $1 AND (deleted_at IS NULL OR $2::boolean)
         UNION ALL
         SELECT vault_id, folder_id, NULL::text, created_at FROM files  WHERE id = $1
       ) loc
       JOIN vaults v ON v.id = loc.vault_id
      LIMIT 1`,
    [docId, includeDeleted],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    folderId: row.folder_id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface MemberAccessSnapshot {
  mode: "private" | "readonly" | "open";
  accessRevision: number;
  snapshotAt: Date;
}

/** Null is intentional: memberships predating migration 032 keep legacy ACLs. */
export async function memberAccessSnapshot(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<MemberAccessSnapshot | null> {
  const { rows } = await db.query<{
    mode: MemberAccessSnapshot["mode"];
    access_revision: string | number;
    snapshot_at: Date;
  }>(
    `SELECT mode, access_revision, snapshot_at
       FROM member_access_snapshots
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  const row = rows[0];
  return row
    ? {
        mode: row.mode,
        accessRevision: Number(row.access_revision),
        snapshotAt: row.snapshot_at,
      }
    : null;
}

/** Walk parent_id up from a folder, collecting all ancestor folder ids (inclusive). */
export async function ancestorFolderIds(
  db: Queryable,
  folderId: string | null,
): Promise<string[]> {
  if (!folderId) return [];
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
     )
     SELECT id FROM chain`,
    [folderId],
  );
  return rows.map((r) => r.id);
}

async function memberRole(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

/**
 * Highest share permission for a user across a file (if `docId` is set), a set
 * of folders, and the vault itself. Passing `docId = null` resolves a
 * folder resource directly: only the folder rows in `folderIds` (the folder
 * itself + its ancestors) match.
 *
 * Grants come from three scopes, all combined with highest-wins:
 *   - per-user file / folder shares (the classic ACL);
 *   - a vault-scoped grant (resource_type 'vault',
 *     do not rename; resource_id = `organizationId`) — either org-wide
 *     (`principal_type 'org'`, the "Open"/"Read-only" default) or for this user
 *     specifically. A vault-scoped grant is the only thing that reaches notes at
 *     the collection root (folder_id NULL), which have no folder to hang a
 *     share on.
 */
async function sharePermission(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
  organizationId: string,
  isMember: boolean,
  /** False when an org deny covers this resource — see {@link isDenied}. */
  orgGrantsApply = true,
  snapshot?: MemberAccessSnapshot | null,
  resourceCreatedAt?: Date,
  index?: AccessIndex,
): Promise<Permission> {
  // Team (org-wide) grants apply ONLY to actual vault members — never to
  // outsiders who merely know a doc id. They can target a specific folder/file
  // ("Share with team", private-by-default) or the whole vault (Open/
  // Read-only). Per-user grants are inherently scoped, so they need no gate.
  //
  // `orgGrantsApply` is how an item set to Private overrides a vault that is
  // Shared: the org branch drops out for that resource, so the vault-wide grant
  // stops reaching it while explicit personal grants still do.
  const orgGrantClause = isMember && orgGrantsApply
    ? `OR (principal_type = 'org' AND principal_id = $4 AND (
            ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
            OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
            OR (resource_type = 'vault' AND resource_id = $4)
          ))`
    : "";
  // $2 (the doc id) is always referenced with an explicit cast + null guard so
  // Postgres can infer its type even for a folder resource, where docId is null
  // and the file branch is inert.
  const { rows } = index
    ? { rows: indexedGrantRows(index, userId, docId, folderIds, organizationId, isMember && orgGrantsApply) }
    : await db.query<{
    permission: string;
    principal_type: string;
    access_revision: string | number;
  }>(
    `SELECT permission, principal_type, access_revision FROM shares
      WHERE permission IN ('view', 'edit', 'readonly')
        AND (
          (principal_type = 'user' AND principal_id = $1 AND (
            ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
            OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
            OR (resource_type = 'vault' AND resource_id = $4)
          ))
          ${orgGrantClause}
        )`,
    [userId, docId, folderIds, organizationId],
  );
  return grantFromRows(rows, snapshot, resourceCreatedAt);
}

/** Highest-wins over {@link sharePermission}'s matching rows, skipping the org
 *  grants a join snapshot already accounts for. */
function grantFromRows(
  rows: ReadonlyArray<Pick<ShareRow, "permission" | "principal_type" | "access_revision">>,
  snapshot?: MemberAccessSnapshot | null,
  resourceCreatedAt?: Date,
): Permission {
  let best: Permission = "none";
  for (const r of rows) {
    const existingAtJoin = !!snapshot && !!resourceCreatedAt && resourceCreatedAt <= snapshot.snapshotAt;
    if (
      r.principal_type === "org" &&
      existingAtJoin &&
      Number(r.access_revision) <= snapshot.accessRevision
    ) continue;
    if (r.permission === "edit") best = maxPermission(best, "edit");
    else if (r.permission === "view" || r.permission === "readonly") {
      best = maxPermission(best, "view");
    }
  }
  return best;
}

/**
 * True when a lock row covers this resource (a file when `docId` is set, plus
 * any folder in `folderIds`) for this user or the whole vault.
 *
 * Deliberately folder/file only. A vault-scoped lock cannot exist: it would
 * need the same (resource_type, resource_id, principal_type, principal_id) key
 * the vault GRANT already occupies. The vault-wide read-only ceiling is
 * expressed by that grant instead — see {@link vaultBaseline}.
 */
export async function isLocked(
  db: Queryable,
  userId: string,
  docId: string | null,
  folderIds: string[],
): Promise<boolean> {
  // $2 (doc id) is always referenced with a cast + null guard so Postgres can
  // infer its type for a folder resource (docId null → file branch inert).
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission IN ('locked', 'readonly')
        AND (
          principal_type = 'org'
          OR (principal_type = 'user' AND principal_id = $1)
        )
        AND (
          ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [userId, docId, folderIds],
  );
  return rows.length > 0;
}

/**
 * The vault's declared posture: the org-wide grant on the vault resource, or
 * null when there is none (the Private posture).
 *
 * This is a **baseline for everyone**, not just for plain members. Read-only
 * says "Everyone can read everything, not edit", and until now it didn't mean
 * everyone: owners, admins and note creators all kept `edit` through shortcuts
 * that ran before any grant was consulted, so the person who chose the setting
 * was the one person exempt from it. When the baseline is `view`, those
 * shortcuts are skipped and the ordinary highest-wins grant lookup decides —
 * which still lets a folder marked Shared, or a personal edit grant, lift an
 * individual out of it. That is exactly what the panel offers.
 *
 * `sealed` — an org-principal `denied` row on the vault resource — is the
 * Access panel's **Private**, and it is the same rule with nothing left at the
 * bottom: the role shortcut and authorship are both skipped and the vault
 * confers nothing, so only a GRANT reaches a doc. Nobody reads anything, the
 * person who created the vault and wrote every note in it included, until
 * something is shared by name or a folder is shared with the team.
 *
 * It is a row rather than the ABSENCE of one because absence already means
 * something else. "Never shared" and "deliberately sealed" were the same state
 * — no row — and they want opposite answers about the notes people wrote: the
 * first is the private-by-default space `created_by` exists for, the second is
 * a setting whose whole point is that it applies to the person who chose it.
 * Writing the row is also what lets an old vault keep working until someone
 * presses the button, at which point it means what it says.
 *
 * The one thing an item set Private does that `sealed` does not is drop ORG
 * grants on that item. Here they still lift: a sealed vault is a floor you
 * raise things out of one at a time, while an item set Private withdraws one
 * thing from a team that can otherwise reach it.
 *
 * The management path is untouched and role-based (`canManage` in
 * `http/routes/shares.ts`), so an owner who cannot read a note can still
 * change the posture back.
 */
export type VaultPosture = "edit" | "view" | "sealed" | null;

export async function vaultBaseline(
  db: Queryable,
  organizationId: string,
): Promise<VaultPosture> {
  const { rows } = await db.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND principal_type = 'org' AND permission IN ('view', 'edit', 'denied')
      LIMIT 1`,
    [organizationId],
  );
  return postureOf(rows[0]?.permission);
}

function postureOf(p: string | null | undefined): VaultPosture {
  if (p === "edit" || p === "view") return p;
  return p === "denied" ? "sealed" : null;
}

/**
 * {@link memberRole}, {@link memberAccessSnapshot} and {@link vaultBaseline} as
 * ONE round trip. Each column is that function's own SELECT, verbatim, as a
 * scalar subquery (the snapshot is keyed by its primary key, so the LEFT JOIN
 * yields at most one row) — the values cannot differ, only the latency.
 */
async function membershipFacts(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<MembershipFacts> {
  const { rows } = await db.query<{
    role: string | null;
    baseline: string | null;
    mode: MemberAccessSnapshot["mode"] | null;
    access_revision: string | number | null;
    snapshot_at: Date | null;
  }>(
    `SELECT
        (SELECT role FROM member
          WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1) AS role,
        (SELECT permission FROM shares
          WHERE resource_type = 'vault' AND resource_id = $1
            AND principal_type = 'org' AND permission IN ('view', 'edit', 'denied')
          LIMIT 1) AS baseline,
        s.mode, s.access_revision, s.snapshot_at
       FROM (SELECT 1) AS one
       LEFT JOIN member_access_snapshots s
         ON s.organization_id = $1 AND s.user_id = $2`,
    [organizationId, userId],
  );
  const row = rows[0];
  return {
    role: row?.role ?? null,
    baseline: postureOf(row?.baseline),
    snapshot:
      row && row.mode !== null && row.snapshot_at !== null
        ? { mode: row.mode, accessRevision: Number(row.access_revision), snapshotAt: row.snapshot_at }
        : null,
  };
}

/**
 * True when a `denied` row covers the resource — the file itself or any
 * ancestor folder — for `principal`.
 *
 * There are two kinds, and the difference is the whole design:
 *
 * - **user deny** (`principal_type 'user'`) — the Access panel's per-member
 *   *Private*. Absolute: resolved before every allow rule, so it beats the
 *   vault-wide grant, an explicit per-user grant, an admin's blanket edit and
 *   the "creator of the note" escape hatch. That last one is the point —
 *   "keep this away from Sam" has to mean it on the notes Sam wrote.
 *
 * - **org deny** (`principal_type 'org'`) — the *item* set to Private. It says
 *   "this folder is not shared with the team", and it exists because clearing
 *   an item's own rows could never achieve that: a vault-wide Open grant still
 *   reached the item, so Private silently snapped back to Shared. It leaves the
 *   creator and explicit per-user grants standing and drops everything
 *   org-scoped — which is exactly "only you and people you share it with".
 *
 * Both apply to **owners and admins**. A restriction its author is exempt from
 * cannot be checked by its author, and "it works, take my word for it" is not a
 * thing to ship in an access panel. The safety net is not an exemption, it is
 * that the *management* gate is role-based and separate: `canManage` in
 * `http/routes/shares.ts` asks for owner/admin and never for effective
 * permission, so an owner can always lift a restriction they applied to
 * themselves — and the desktop's Access list is built from the local folder, so
 * the row to do it from never disappears either.
 */
export async function isDenied(
  db: Queryable,
  principalType: "user" | "org",
  principalId: string,
  docId: string | null,
  folderIds: string[],
): Promise<boolean> {
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'denied'
        AND principal_type = $4 AND principal_id = $1
        AND (
          ($2::text IS NOT NULL AND resource_type = 'file' AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [principalId, docId, folderIds, principalType],
  );
  return rows.length > 0;
}

export async function effectivePermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
  /** Optional request-scoped memo for the per-vault / per-folder inputs. Changes
   *  nothing about the answer — see {@link ResolverCache}. */
  cache?: ResolverCache,
  /** Resolve a soft-deleted note as if it were live (see `trash/access.ts`). */
  opts: { includeDeleted?: boolean } = {},
): Promise<Permission> {
  // A doc the batch prefetched answers from what that read loaded; anything
  // else — no cache, not prefetched, or a soft-deleted lookup — reads live.
  const pre = cache && opts.includeDeleted !== true ? cache.preloaded(docId) : undefined;
  const loc = pre ? pre.loc : await locateDoc(db, docId, opts.includeDeleted === true);
  if (!loc) return "none";

  const folderIds = pre
    ? pre.folderIds
    : cache
      ? await cache.ancestors(db, loc.folderId)
      : await ancestorFolderIds(db, loc.folderId);

  // With a cache, the four share questions below (two denies, the grant, the
  // lock) are answered from ONE read of every row on this doc, its chain and
  // its vault, filtered by the same predicates the SQL spells out. Without one,
  // each asks the database itself — the reference path the drift tests compare
  // against.
  const rows = pre ? pre.rows : cache ? await docShareRows(db, userId, docId, folderIds, loc.organizationId) : null;
  const denied = async (principalType: "user" | "org", principalId: string) =>
    rows ? rowsDenied(rows, principalType, principalId) : isDenied(db, principalType, principalId, docId, folderIds);
  const locked = async () => (rows ? rowsLocked(rows, userId) : isLocked(db, userId, docId, folderIds));
  const grant = async (
    isMember: boolean,
    orgGrantsApply: boolean,
    snapshot?: MemberAccessSnapshot | null,
    resourceCreatedAt?: Date,
  ) =>
    rows
      ? grantFromRows(
          rowsGrants(rows, userId, loc.organizationId, isMember && orgGrantsApply),
          snapshot,
          resourceCreatedAt,
        )
      : sharePermission(db, userId, docId, folderIds, loc.organizationId, isMember, orgGrantsApply, snapshot, resourceCreatedAt);

  // Denies are first and unconditional. Both kinds outrank the role branch
  // below: what you set in the Access panel applies to you too, or a vault
  // owner can never see the effect of their own restriction and has to take it
  // on trust. The escape hatch is elsewhere and role-based — managing shares
  // (`canManage` in http/routes/shares.ts) is gated on owner/admin, never on
  // effective permission, so an owner can always lift what they set.
  if (await denied("user", userId)) return "none";
  const itemPrivate = await denied("org", loc.organizationId);

  const facts = cache ? await cache.membership(db, loc.organizationId, userId) : null;
  const role = facts ? facts.role : await memberRole(db, loc.organizationId, userId);
  const snapshot = facts ? facts.snapshot : await memberAccessSnapshot(db, loc.organizationId, userId);
  const existingAtJoin = !!snapshot && loc.createdAt <= snapshot.snapshotAt;

  // A join default is a one-time view of content that already existed. It does
  // not rewrite the organization's live posture, and it is not an immutable
  // deny: an org grant written at a later ACL revision can raise it.
  if (existingAtJoin) {
    const direct = await grant(role !== null, !itemPrivate, snapshot, loc.createdAt);
    let snapped: Permission = itemPrivate
      ? "none"
      : snapshot.mode === "open"
        ? "edit"
        : snapshot.mode === "readonly"
          ? "view"
          : "none";
    snapped = maxPermission(snapped, direct);
    if (snapped !== "none" && (await locked())) return "view";
    return snapped;
  }
  // The vault's posture caps EVERY shortcut below it (see `vaultBaseline`).
  // Read-only and Private both skip the role AND the creator rule; they differ
  // only in what the vault itself then confers — `view` for one, nothing at all
  // for the other.
  const baseline = facts ? facts.baseline : await vaultBaseline(db, loc.organizationId);
  const readOnlyVault = baseline === "view";
  const sealedVault = baseline === "sealed";
  const ungrantedVault = baseline === null;
  let granted: Permission;
  if (itemPrivate) {
    // Private = "nobody, until you name them". ONLY explicit per-user grants
    // survive — not the org grant, not the admin shortcut, and not authorship.
    //
    // Authorship is the one that had to go last and is the one that matters:
    // in a vault you set up yourself you wrote nearly everything, so a Private
    // that spares the author is a Private you can never observe, and "it works,
    // trust me" is not a thing to ship in an access panel. Naming yourself in
    // the list below is how you get back in.
    granted = await grant(false, false);
  } else if (readOnlyVault || sealedVault) {
    // The two postures that take BOTH shortcuts away from everyone: the
    // owner/admin blanket edit, and authorship.
    //
    // `sealed` is the Private button, and it had to stop sparing the author to
    // mean anything. In a vault you set up yourself you wrote nearly every note
    // in it, so a Private that spares the author is one you can never observe —
    // press it and the vault looks untouched, which from the seat that pressed
    // it is indistinguishable from a control that does not work.
    //
    // What still reaches through is a GRANT: a per-user share, or an org share
    // on a folder or note ("share this one folder with the team"). That is the
    // shape of a sealed vault — a floor you lift things out of one at a time by
    // naming them. It is also the one difference from an item set Private,
    // which drops org grants on that item too, because there the point is the
    // opposite: withdrawing one thing from a team that can otherwise reach it.
    granted = await grant(role !== null, true);
  } else if (!ungrantedVault && (role === "owner" || role === "admin")) {
    // The blanket role shortcut. A vault that was never shared withdraws it —
    // an owner is not exempt from a vault nobody has been given — but leaves
    // the creator rule below standing, because "no grant" is also the state
    // every private-by-default vault sits in, where people keep what they wrote.
    granted = "edit";
  } else if (role !== null && loc.createdBy && loc.createdBy === userId) {
    // Private-by-default: a member always has edit on a note they created, even
    // with no explicit share (that's what makes "my private notes" work). The
    // `role !== null` gate is load-bearing: a user REMOVED from the vault must
    // lose this grant (their session outlives removal), else they keep edit on
    // notes they authored and can re-mint sync tokens indefinitely.
    granted = "edit";
  } else {
    granted = await grant(role !== null, true); // isMember — gates the org-wide grant
  }

  // Cap overlay: a matching lock caps at view; it never grants.
  if (granted !== "none" && (await locked())) {
    return "view";
  }
  return granted;
}

/**
 * Precomputed context for resolving many users against ONE resource (used by the
 * "who can access" view). Built once, then reused per member so we don't re-walk
 * the folder ancestry for each user.
 *
 * - file resource:   `docId` = the doc id, `folderIds` = ancestors of its folder.
 * - folder resource: `docId` = null,       `folderIds` = the folder + its ancestors.
 */
export interface AccessContext {
  organizationId: string;
  docId: string | null;
  folderIds: string[];
  /**
   * Creator of the note this context describes (null for a folder, or a file).
   *
   * Carried so the "who can access" list applies the same creator rule the
   * enforcer does. Without it the panel reported `none` for a member's own
   * note in a Private vault while `effectivePermission` handed them `edit` —
   * the panel and the thing it describes disagreeing, which is worse than
   * either answer alone.
   */
  createdBy: string | null;
  createdAt: Date;
}

export interface ResolvedAccess {
  permission: Permission;
  /** True when a lock reduced an otherwise-`edit` member down to `view`. */
  capped: boolean;
  /** True when the `none` came from an explicit per-member deny, not from an
   *  absent grant — the UI says "No access · blocked" rather than "not shared". */
  denied?: boolean;
}

export async function buildAccessContext(
  resourceType: "folder" | "file",
  resourceId: string,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<AccessContext | null> {
  const chain = (folderId: string | null) =>
    cache ? cache.ancestors(db, folderId) : ancestorFolderIds(db, folderId);
  if (resourceType === "file") {
    const loc = await locateDoc(db, resourceId);
    if (!loc) return null;
    return {
      organizationId: loc.organizationId,
      docId: resourceId,
      folderIds: await chain(loc.folderId),
      createdBy: loc.createdBy,
      createdAt: loc.createdAt,
    };
  }
  // folder: resolve its owning vault (organization), then walk itself + ancestors.
  const { rows } = await db.query<{ organization_id: string; created_at: Date }>(
    `SELECT v.organization_id, f.created_at
       FROM folders f JOIN vaults v ON v.id = f.vault_id
      WHERE f.id = $1 LIMIT 1`,
    [resourceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    docId: null,
    folderIds: await chain(resourceId),
    createdBy: null, // folders have no creator column in the ACL context
    createdAt: row.created_at,
  };
}

/**
 * {@link buildAccessContext} for many resources of one organization, from the
 * index: the same rows (`locateDoc` prefers a live note over a files row) and
 * the same ancestor chain. A resource the index does not hold falls back to
 * the per-resource read, so an answer never silently changes shape.
 */
export async function buildAccessContextFromIndex(
  index: AccessIndex,
  resourceType: "folder" | "file",
  resourceId: string,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<AccessContext | null> {
  if (resourceType === "file") {
    const note = index.notes.get(resourceId);
    const loc = note ?? index.files.get(resourceId);
    const chain = loc ? indexedAncestors(index, loc.folderId) : null;
    if (!loc || !chain) return buildAccessContext(resourceType, resourceId, db, cache);
    return {
      organizationId: index.organizationId,
      docId: resourceId,
      folderIds: chain,
      createdBy: note?.createdBy ?? null,
      createdAt: loc.createdAt,
    };
  }
  const folder = index.folders.get(resourceId);
  const chain = folder ? indexedAncestors(index, resourceId) : null;
  if (!folder || !chain) return buildAccessContext(resourceType, resourceId, db, cache);
  return {
    organizationId: index.organizationId,
    docId: null,
    folderIds: chain,
    createdBy: null,
    createdAt: folder.createdAt,
  };
}

/** Resolve one user's effective access against a prebuilt {@link AccessContext}. */
export async function resolveAccessForUser(
  ctx: AccessContext,
  userId: string,
  role: string | null,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
  /** Preloaded rows for `ctx.organizationId` — see {@link AccessIndex}. */
  accessIndex?: AccessIndex,
): Promise<ResolvedAccess> {
  const index = accessIndex?.organizationId === ctx.organizationId ? accessIndex : undefined;
  const denied = (principalType: "user" | "org", principalId: string) =>
    index
      ? Promise.resolve(indexedIsDenied(index, principalType, principalId, ctx.docId, ctx.folderIds))
      : isDenied(db, principalType, principalId, ctx.docId, ctx.folderIds);
  const lockedFor = () =>
    index
      ? Promise.resolve(indexedIsLocked(index, userId, ctx.docId, ctx.folderIds))
      : isLocked(db, userId, ctx.docId, ctx.folderIds);
  if (await denied("user", userId)) {
    return { permission: "none", capped: false, denied: true };
  }
  const itemPrivate = await denied("org", ctx.organizationId);
  const snapshot = cache
    ? await cache.snapshot(db, ctx.organizationId, userId)
    : await memberAccessSnapshot(db, ctx.organizationId, userId);
  const existingAtJoin = !!snapshot && ctx.createdAt <= snapshot.snapshotAt;
  if (existingAtJoin) {
    const direct = await sharePermission(
      db,
      userId,
      ctx.docId,
      ctx.folderIds,
      ctx.organizationId,
      role !== null,
      !itemPrivate,
      snapshot,
      ctx.createdAt,
      index,
    );
    let permission: Permission = itemPrivate
      ? "none"
      : snapshot.mode === "open"
        ? "edit"
        : snapshot.mode === "readonly"
          ? "view"
          : "none";
    permission = maxPermission(permission, direct);
    if (permission === "none") return { permission, capped: false, denied: itemPrivate };
    const locked = await lockedFor();
    if (locked && permission === "edit") return { permission: "view", capped: true };
    if (locked) return { permission: "view", capped: false };
    return { permission, capped: false };
  }
  // Mirrors `effectivePermission` branch for branch. They MUST agree: this one
  // renders the "who can access" list, and a list that disagrees with the
  // enforcer is worse than no list.
  const baseline = cache
    ? await cache.baseline(db, ctx.organizationId)
    : await vaultBaseline(db, ctx.organizationId);
  const readOnlyVault = baseline === "view";
  const sealedVault = baseline === "sealed";
  const ungrantedVault = baseline === null;
  const isCreator = role !== null && !!ctx.createdBy && ctx.createdBy === userId;
  const granted: Permission = itemPrivate
    ? // Private: only explicit per-user grants survive — authorship included.
      await sharePermission(db, userId, ctx.docId, ctx.folderIds, ctx.organizationId, false, false, undefined, undefined, index)
    : readOnlyVault || sealedVault
      ? // Both postures skip the role AND authorship; only a grant reaches
        // through. Mirrors `effectivePermission` branch for branch.
        await sharePermission(
          db,
          userId,
          ctx.docId,
          ctx.folderIds,
          ctx.organizationId,
          role !== null,
          true,
          undefined,
          undefined,
          index,
        )
      : !ungrantedVault && (role === "owner" || role === "admin")
        ? "edit"
        : isCreator
          ? "edit"
          : await sharePermission(
              db,
              userId,
              ctx.docId,
              ctx.folderIds,
              ctx.organizationId,
              role !== null, // isMember — gates the org-wide grant
              true,
              undefined,
              undefined,
              index,
            );

  if (granted === "none") return { permission: "none", capped: false, denied: itemPrivate };

  const locked = await lockedFor();
  if (locked && granted === "edit") return { permission: "view", capped: true };
  if (locked) return { permission: "view", capped: false };
  return { permission: granted, capped: false };
}
