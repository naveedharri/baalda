import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import {
  memberAccessSnapshot,
  memberGroupIds,
  personalVaultLevel,
  type PersonalVaultLevel,
  vaultBaseline,
} from "./resolver.js";

type Queryable = Pick<pg.Pool, "query">;

/**
 * The set of doc_ids in a vault a user may **read** (spec 05 §3.1). This is the
 * set-based dual of `effectivePermission` ([[resolver]]) for one whole vault, so
 * the vault channel can compute a subscriber's readable set in a couple of
 * queries instead of one resolve per doc.
 *
 * Mirrors the resolver exactly (here "vault" is the note collection; the
 * owner/admin/member role belongs to its owning organization, the user-facing
 * vault):
 *   - a vault-scoped view/edit grant (org-wide "Open"/"Read-only" for
 *     members, or per-user) -> every (non-deleted) note + file in the vault.
 *     Owner and admin reach this through the org-wide grant like anyone else,
 *     so a Private vault (no grant) leaves them scoped too;
 *   - otherwise             -> docs reachable via a share (view/edit) on the doc
 *     itself or any ancestor folder (folder grants inherit down), plus the docs
 *     the caller created — except in a SEALED vault (the Access panel's
 *     Private), which drops authorship for everyone and leaves only the shares.
 *
 * `locked` is a cap overlay that only takes edit->view; it never grants read, so
 * it's absent here. `denied` (per-member "No access") IS here: it removes read,
 * so every set below subtracts it last — see `deniedDocsInVault`.
 *
 * Read = view OR edit, so the channel streams content to view-only grantees too.
 */
/**
 * Resolve a user's vault-level posture: their org, role, and whether they have
 * vault-wide read (a vault-scoped Open/Read-only grant, org-wide or per-user).
 *
 * Owner and admin used to answer `vaultWide: true` outright, before any grant
 * was read. That made a Private vault mean "private from the team" to a member
 * and nothing at all to the person who set it, and it was the single widest
 * bypass in the system: this one boolean feeds the readable set, the folder
 * tree, blob reads, the graph, MCP search, the registry pull and the live
 * channel's `ready.revoked`. The role now buys exactly what it buys everywhere
 * else — the org-wide grant, which Shared and Read-only write and Private does
 * not — so all eight surfaces follow the posture without a line of their own.
 * See [[resolver]] `vaultBaseline`.
 *
 * A person's OWN vault level (`personal`, a per-user row on the vault resource)
 * replaces the org posture for them — [[resolver]] `personalVaultLevel`:
 * `edit`/`view` is vault-wide read whatever the posture, `denied` is NOT
 * vault-wide read even in a Shared vault.
 */
export async function vaultAccess(
  db: Queryable,
  userId: string,
  vaultId: string,
): Promise<{
  organizationId: string;
  role: string | null;
  vaultWide: boolean;
  personal: PersonalVaultLevel;
  /** The access groups whose grants apply to this person: their groups while
   *  they are a member with no vault level of their own, else none ([[resolver]]
   *  `rowsGroupGrant` — a person's own level ignores groups). */
  groupIds: string[];
  /** One of `groupIds` holds a grant on the whole vault. */
  groupVault: boolean;
} | null> {
  const org = await db.query<{ organization_id: string; role: string | null }>(
    `SELECT v.organization_id, m.role
       FROM vaults v
       LEFT JOIN member m
         ON m."organizationId" = v.organization_id AND m."userId" = $2
      WHERE v.id = $1`,
    [vaultId, userId],
  );
  const row = org.rows[0];
  if (!row) return null;
  const personal = await personalVaultLevel(db, row.organization_id, userId);
  const base = { organizationId: row.organization_id, role: row.role, personal };
  if (personal !== null) return { ...base, vaultWide: personal !== "denied", groupIds: [], groupVault: false };
  const groupIds = row.role !== null ? await memberGroupIds(db, row.organization_id, userId) : [];
  const groupVault =
    groupIds.length > 0 &&
    ((
      await db.query(
        `SELECT 1 FROM shares
          WHERE resource_type = 'vault' AND resource_id = $1
            AND principal_type = 'group' AND principal_id = ANY($2::text[])
            AND permission IN ('view', 'edit')
          LIMIT 1`,
        [row.organization_id, groupIds],
      )
    ).rowCount ?? 0) > 0;
  const orgClause = row.role !== null ? "principal_type = 'org' OR" : "";
  const grant = await db.query(
    `SELECT 1 FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND permission IN ('view', 'edit', 'readonly')
        AND (${orgClause} (principal_type = 'user' AND principal_id = $2))
      LIMIT 1`,
    [row.organization_id, userId],
  );
  return { ...base, vaultWide: groupVault || (grant.rowCount ?? 0) > 0, groupIds, groupVault };
}

/**
 * True only when `userId` can read EVERY note and file in the vault, which is
 * what the shortcuts for path-only data assume: hash-named `attachments/`
 * blobs, their extracted text in search, and a whole-vault checkpoint revert.
 *
 * `vaultWide` alone is not that. It says a vault-level grant reaches the
 * person, but a per-user or team `denied` row on a folder or file still takes
 * items away (the readable set subtracts them last), and a Private join
 * snapshot hides what existed before they joined. In either case the caller
 * must judge each item instead, so this answers false and the attachment gates
 * fall back to "referenced by a note you can read".
 */
export async function readsWholeVault(
  db: Queryable,
  userId: string,
  vaultId: string,
  access?: Awaited<ReturnType<typeof vaultAccess>>,
): Promise<boolean> {
  const a = access === undefined ? await vaultAccess(db, userId, vaultId) : access;
  if (!a?.vaultWide) return false;
  const { rowCount } = await db.query(
    `SELECT 1 FROM shares s
      WHERE s.org_id = $1
        AND s.permission = 'denied'
        AND s.resource_type IN ('folder', 'file')
        AND ((s.principal_type = 'user' AND s.principal_id = $2) OR s.principal_type = 'org')
        AND (
          EXISTS (SELECT 1 FROM folders f WHERE f.id = s.resource_id AND f.vault_id = $3)
          OR EXISTS (SELECT 1 FROM notes n WHERE n.id = s.resource_id AND n.vault_id = $3)
          OR EXISTS (SELECT 1 FROM files fl WHERE fl.id = s.resource_id AND fl.vault_id = $3)
        )
      LIMIT 1`,
    [a.organizationId, userId, vaultId],
  );
  if ((rowCount ?? 0) > 0) return false;
  if (a.personal === null) {
    const snapshot = await memberAccessSnapshot(db, a.organizationId, userId);
    if (snapshot?.mode === "private") {
      // A Private snapshot hides only what existed at the join, so most such
      // members still read everything. Ask exactly: the readable set is a
      // subset of the live docs, so equal sizes mean equal sets.
      const readable = await listReadableDocsInVault(userId, vaultId, db);
      const { rows } = await db.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM notes WHERE vault_id = $1 AND deleted_at IS NULL)
              + (SELECT count(*) FROM files WHERE vault_id = $1) AS n`,
        [vaultId],
      );
      return readable.size === Number(rows[0]?.n ?? -1);
    }
  }
  return true;
}

/**
 * doc_ids in this vault covered by a `denied` row for `principalId`, folded
 * down through folder inheritance.
 *
 * Two callers, matching the resolver's two kinds of deny ([[resolver]]):
 *   - `'user'` — the per-member Private. Subtracted from EVERY set below,
 *     because it has to beat the owner/admin branch, the vault-wide grant
 *     branch and the created_by branch, which are three different queries.
 *     One subtraction at the end can't be forgotten in one of them.
 *   - `'org'`  — the item set to Private. Subtracted only from what the TEAM
 *     could otherwise reach, so the creator and explicit grantees keep it.
 */
async function anyDenyRows(
  db: Queryable,
  principalType: "user" | "org",
  principalId: string,
): Promise<boolean> {
  // The overwhelmingly common answer is "none", and without this the two calls
  // below each scan the vault's whole `notes` UNION `files` to fold an EMPTY
  // seed down through folder inheritance — twice per `listReadableDocsInVault`,
  // which every connect, every registry pull and every backfill runs. This is
  // one indexed probe on `shares`, and it is only ever skipped when the answer
  // it protects is provably the empty set.
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'denied'
        AND principal_type = $1 AND principal_id = $2
        AND resource_type IN ('folder', 'file')
      LIMIT 1`,
    [principalType, principalId],
  );
  return rows.length > 0;
}

/**
 * A PER-USER deny decides only where it is the deepest of that person's rows
 * ([[resolver]] `userItemVerdict`): a per-user grant (edit/view/readonly) on a
 * deeper folder or on the file lifts it, a deeper deny re-applies it. `locked`
 * never decides. `dec` walks every folder of the vault top-down carrying the
 * nearest per-user decisive permission.
 */
const USER_DECISION_CTE = `
  user_rows AS (
     SELECT resource_type, resource_id, permission FROM shares
      WHERE principal_type = 'user' AND principal_id = $1
        AND resource_type IN ('folder', 'file')
        AND permission IN ('edit', 'view', 'readonly', 'denied')
  ),
  dec AS (
     SELECT f.id, u.permission AS perm
       FROM folders f
       LEFT JOIN user_rows u ON u.resource_type = 'folder' AND u.resource_id = f.id
      WHERE f.vault_id = $2 AND f.parent_id IS NULL
     UNION ALL
     SELECT f.id, COALESCE(u.permission, d.perm)
       FROM folders f
       JOIN dec d ON f.parent_id = d.id AND f.vault_id = $2
       LEFT JOIN user_rows u ON u.resource_type = 'folder' AND u.resource_id = f.id
  )`;

async function userDeniedDocsInVault(db: Queryable, userId: string, vaultId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE ${USER_DECISION_CTE}
     SELECT n.id FROM notes n
       LEFT JOIN dec d ON d.id = n.folder_id
       LEFT JOIN user_rows u ON u.resource_type = 'file' AND u.resource_id = n.id
      WHERE n.vault_id = $2 AND COALESCE(u.permission, d.perm) = 'denied'
     UNION
     SELECT fi.id FROM files fi
       LEFT JOIN dec d ON d.id = fi.folder_id
       LEFT JOIN user_rows u ON u.resource_type = 'file' AND u.resource_id = fi.id
      WHERE fi.vault_id = $2 AND COALESCE(u.permission, d.perm) = 'denied'`,
    [userId, vaultId],
  );
  return new Set(rows.map((r) => r.id));
}

async function userDeniedFolderIds(db: Queryable, userId: string, vaultId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE ${USER_DECISION_CTE}
     SELECT id FROM dec WHERE perm = 'denied'`,
    [userId, vaultId],
  );
  return new Set(rows.map((r) => r.id));
}

async function deniedDocsInVault(
  db: Queryable,
  principalType: "user" | "org",
  principalId: string,
  vaultId: string,
): Promise<Set<string>> {
  if (!(await anyDenyRows(db, principalType, principalId))) return new Set();
  if (principalType === "user") return userDeniedDocsInVault(db, principalId, vaultId);
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE denied_seed AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission = 'denied'
           AND principal_type = $3 AND principal_id = $1
     ),
     denied_subtree AS (
        SELECT id, parent_id FROM folders WHERE vault_id = $2 AND id IN (SELECT id FROM denied_seed)
        UNION
        SELECT f.id, f.parent_id FROM folders f JOIN denied_subtree d ON f.parent_id = d.id AND f.vault_id = $2
     ),
     denied_files AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'file' AND permission = 'denied'
           AND principal_type = $3 AND principal_id = $1
     )
     SELECT n.id FROM notes n
       WHERE n.vault_id = $2
         AND (n.folder_id IN (SELECT id FROM denied_subtree) OR n.id IN (SELECT id FROM denied_files))
     UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (fi.folder_id IN (SELECT id FROM denied_subtree) OR fi.id IN (SELECT id FROM denied_files))`,
    [principalId, vaultId, principalType],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Note/file ids in this vault that an item-level Private hides from `userId` —
 * a per-member deny, or the team's (org) deny. The registry's adopt-by-path
 * refuses exactly these when the caller cannot read them: answering with their
 * id named private items to anyone who guessed the path.
 */
export async function listPrivateHiddenDocsInVault(
  userId: string,
  organizationId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const [mine, team] = await Promise.all([
    deniedDocsInVault(db, "user", userId, vaultId),
    deniedDocsInVault(db, "org", organizationId, vaultId),
  ]);
  for (const id of team) mine.add(id);
  return mine;
}

/** Folder ids denied to `principalId`, including everything below them. */
async function deniedFolderIds(
  db: Queryable,
  principalType: "user" | "org",
  principalId: string,
  vaultId: string,
): Promise<Set<string>> {
  // Same short-circuit as {@link deniedDocsInVault}: an empty seed can only fold
  // down to an empty set, so the recursive walk is worth a cheap probe first.
  if (!(await anyDenyRows(db, principalType, principalId))) return new Set();
  if (principalType === "user") return userDeniedFolderIds(db, principalId, vaultId);
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE denied_seed AS (
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission = 'denied'
           AND principal_type = $2 AND principal_id = $1
     ),
     denied_subtree AS (
        SELECT id, parent_id FROM folders WHERE id IN (SELECT id FROM denied_seed)
        UNION
        SELECT f.id, f.parent_id FROM folders f JOIN denied_subtree d ON f.parent_id = d.id
     )
     SELECT DISTINCT id FROM denied_subtree`,
    [principalId, principalType],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * One implementation, two questions. `deleted: false` answers "what may this user
 * read?"; `deleted: true` answers "which of this vault's docs that they'd be
 * allowed to read are now **gone**?" — the tombstone set the desktop reconciler
 * needs to tell a delete from a revoke.
 *
 * They MUST share one body. The client applies the difference between them by
 * removing files from disk, so if the two permission algebras ever drifted, the
 * drift would show up as a note being deleted off someone's disk. A single
 * predicate swap can't drift.
 */
/**
 * A memo for the USER-INDEPENDENT reads inside {@link listDocsInVault}, shared
 * by several users' computations that answer the SAME event (the vault
 * channel's per-message ACL refresh, where every connected member recomputes at
 * once). Only reads whose SQL takes no user id go in it — the vault's whole doc
 * list, the team's (org) item denies and the org posture — so sharing one can
 * never hand one person another's answer. Callers must create a fresh memo per
 * event, AFTER that event arrived: a memo is as fresh as its first read, and
 * that read started after the change it answers was committed.
 */
export type SharedVaultReads = Map<string, Promise<unknown>>;

function shareRead<T>(shared: SharedVaultReads | undefined, key: string, read: () => Promise<T>): Promise<T> {
  if (!shared) return read();
  let p = shared.get(key) as Promise<T> | undefined;
  if (!p) {
    const fresh = read();
    p = fresh;
    shared.set(key, fresh);
    // A failed read is never handed to a later caller.
    fresh.catch(() => {
      if (shared.get(key) === fresh) shared.delete(key);
    });
  }
  return p;
}

async function listDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable,
  opts: { deleted: boolean },
  shared?: SharedVaultReads,
): Promise<Set<string>> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return new Set(); // unknown vault
  const { organizationId, role, vaultWide, personal, groupIds } = access;

  // The ONLY difference between the two sets. `files` has no `deleted_at`
  // column, so a tombstone can never be a file — the UNIONs below drop out.
  const livePredicate = opts.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";

  // Non-privileged (private-by-default): readable docs are the union of
  //   - notes the user created (created_by) — ONLY while still a member;
  //   - docs under a folder shared to the user OR the team (org grant), walking
  //     the subtree since folder grants inherit down;
  //   - files/notes shared directly to the user or the team.
  // Both the creator branch and the org ($3) branches are gated by membership
  // ($4) so a REMOVED member (session outlives removal) loses read on notes
  // they authored — matching resolver.effectivePermission's creator rule.
  //
  // `orgGrants` ($5) is run BOTH ways when an item is set to Private: once
  // normally, and once with the team's grants switched off, which yields
  // exactly the docs this user reaches personally (created, or shared to them
  // by name). Subtracting `orgDenied` minus that personal set is what makes
  // Private mean "not the team" rather than "not anyone".
  //
  // A soft-deleted note keeps `created_by`, `folder_id` and its `shares` rows, so
  // this resolves a tombstone's permission exactly as it did while the note lived.
  const isMember = role !== null;
  const filesUnion = opts.deleted
    ? ""
    : `UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (($4 AND $6 AND fi.created_by = $1
               AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = fi.id AND n.deleted_at IS NULL))
              OR fi.folder_id IN (SELECT id FROM subtree) OR fi.id IN (SELECT id FROM shared_files)
              OR EXISTS (SELECT 1 FROM user_vault_grant))`;
  // Deleting a folder HARD-deletes its rows (`tree-ops.ts deleteFolder`) after
  // soft-deleting the notes inside, and `notes.folder_id` is `ON DELETE SET
  // NULL`. So for a tombstone the walk above finds nothing: the folder that
  // carried the member's share no longer exists, the note's `folder_id` is null,
  // and a member whose access ran through a folder share was told nothing at all.
  //
  // That is not a cosmetic gap. "Absent from BOTH lists" is how the desktop
  // spells REVOKED, and a revocation is removed outright with no recoverable
  // copy, under a cap an authoritative pass lifts. An owner deleting a shared
  // folder while the member's app was closed therefore erased those files on the
  // next launch, with the deletion cap and the trash copy — the two things built
  // for exactly this — never consulted.
  //
  // `folder_tombstones` still holds the deleted subtree's ids AND paths, so the
  // ancestry is recoverable from the path even though the rows are gone. Only
  // the tombstone question asks for this: a LIVE note's `folder_id` is
  // authoritative and must stay the only thing that decides it.
  //
  // Expand each path into its bounded list of ancestor paths, then equijoin.
  // Prefix EXISTS joins compared every tombstone to every shared folder and
  // every deleted note to every tombstone (#317). Materializing that scan only
  // prevented repeated planning; it still grew as the product of both sets.
  const deadFolderCte = opts.deleted
    ? `,
       dead_ancestors AS MATERIALIZED (
          SELECT ft.id, array_to_string(p.parts[1:depth.n], '/') AS path
            FROM folder_tombstones ft
            CROSS JOIN LATERAL (SELECT string_to_array(lower(ft.path), '/') AS parts) p
            CROSS JOIN LATERAL generate_series(1, cardinality(p.parts) - 1) depth(n)
           WHERE ft.vault_id = $2
       ),
       dead_folder_paths AS MATERIALIZED (
          SELECT lower(ft.path) AS path, ft.deleted_at FROM folder_tombstones ft
           WHERE ft.vault_id = $2
             AND (ft.id IN (SELECT id FROM shared_folders)
               OR ft.id IN (
                 SELECT a.id FROM dead_ancestors a
                 JOIN folders f ON lower(f.path) = a.path AND f.vault_id = $2
                 JOIN subtree s ON s.id = f.id
               ))
       ),
       deleted_ancestors AS MATERIALIZED (
          SELECT n.id, n.created_at, array_to_string(p.parts[1:depth.n], '/') AS path
            FROM notes n
            CROSS JOIN LATERAL (SELECT string_to_array(lower(n.rel_path), '/') AS parts) p
            CROSS JOIN LATERAL generate_series(1, cardinality(p.parts) - 1) depth(n)
           WHERE n.vault_id = $2 AND n.deleted_at IS NOT NULL
       ),
       dead_docs AS (
          SELECT a.id FROM deleted_ancestors a
          JOIN dead_folder_paths d ON d.path = a.path
           -- A historical folder share cannot claim a later same-path note.
           AND d.deleted_at >= a.created_at
       )`
    : "";
  const deadFolderPredicate = opts.deleted
    ? "OR n.id IN (SELECT id FROM dead_docs)"
    : "";
  // `creatorCounts` exists for the rescue call below: under item-Private,
  // authorship no longer keeps a doc, so the "reaches it personally" set is
  // per-user shares ONLY. The normal call keeps it — a member still reads the
  // notes they wrote.
  const scopedDocs = async (orgGrants: boolean, creatorCounts = true): Promise<Set<string>> => {
    const { rows } = await db.query<{ id: string }>(
      `WITH RECURSIVE shared_folders AS (
          SELECT resource_id AS id FROM shares
           WHERE resource_type = 'folder' AND permission IN ('view', 'edit', 'readonly')
             AND (
               (principal_type = 'user' AND principal_id = $1)
               OR ($4 AND $5 AND principal_type = 'org' AND principal_id = $3)
               OR (principal_type = 'group' AND principal_id = ANY($7::text[]))
             )
       ),
       subtree AS (
          SELECT id FROM folders WHERE vault_id = $2 AND id IN (SELECT id FROM shared_folders)
          UNION
          SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id AND f.vault_id = $2
       ),
       shared_files AS (
          SELECT resource_id AS id FROM shares
           WHERE resource_type = 'file' AND permission IN ('view', 'edit', 'readonly')
             AND (
               (principal_type = 'user' AND principal_id = $1)
               OR ($4 AND $5 AND principal_type = 'org' AND principal_id = $3)
               OR (principal_type = 'group' AND principal_id = ANY($7::text[]))
             )
       ),
       -- A per-USER grant on the VAULT resource, which reaches every doc in it.
       -- resolver.sharePermission has always matched this row in its personal
       -- branch and this set did not, so a user holding one on an item-Private
       -- doc was READABLE to the resolver and ABSENT from the set. By the
       -- desktop's rule a disagreement leaves the WHOLE revoked group, so one
       -- such doc stalled every revocation cleanup on that device, forever.
       --
       -- Deliberately per-user only: the ORG-principal vault grant is the vault
       -- posture, which vaultAccess has already answered as vaultWide.
       --
       -- A group's vault grant reaches every doc the same way (groups are a
       -- named set of people: they rescue from item-Private like a per-user
       -- grant does). $7 is empty when groups do not apply to this person.
       user_vault_grant AS (
          SELECT 1 FROM shares
           WHERE resource_type = 'vault' AND resource_id = $3
             AND permission IN ('view', 'edit', 'readonly')
             AND ((principal_type = 'user' AND principal_id = $1)
               OR (principal_type = 'group' AND principal_id = ANY($7::text[])))
       )${deadFolderCte}
       SELECT n.id FROM notes n
         WHERE n.vault_id = $2 AND n.${livePredicate}
           AND (
             ($4 AND $6 AND n.created_by = $1)
             OR n.folder_id IN (SELECT id FROM subtree)
             OR n.id IN (SELECT id FROM shared_files)
             OR EXISTS (SELECT 1 FROM user_vault_grant)
             ${deadFolderPredicate}
           )
       ${filesUnion}`,
      [userId, vaultId, organizationId, isMember, orgGrants, creatorCounts, groupIds],
    );
    return new Set(rows.map((r) => r.id));
  };

  // Both denies apply to everyone, owners and admins included — see
  // [[resolver]] for why a restriction its author is exempt from is not one.
  // The org deny is rescued only by an explicit per-user share (`personal`
  // below, which deliberately does NOT count authorship): Private means
  // "nobody until you name them", and in a vault you set up yourself you wrote
  // nearly everything.
  const userDenied = await deniedDocsInVault(db, "user", userId, vaultId);
  // Read-only below (never mutated), so a shared instance is safe.
  const orgDenied = await shareRead(shared, `orgDenied\u0000${organizationId}\u0000${vaultId}`, () =>
    deniedDocsInVault(db, "org", organizationId, vaultId),
  );

  // A SEALED vault (the Access panel's Private) stops authorship keeping a doc,
  // exactly as an item set Private does — the resolver's posture branch skips
  // both the role and the creator rule, so `creatorCounts` has to go with it or
  // the set and the resolver disagree about every note its author wrote. Org and
  // per-user grants still lift, which is what makes "sealed vault, one folder
  // shared with the team" work. A vault that was merely never shared is NOT
  // this: there, people keep what they wrote.
  //
  // A person's own vault level replaces the posture for them, and drops
  // authorship the same way (`view` reaches everything anyway; `denied` is the
  // per-person sealed).
  const sealed =
    personal !== null ||
    (await shareRead(shared, `baseline\u0000${organizationId}`, () => vaultBaseline(db, organizationId))) ===
      "sealed";

  let reachable: Set<string>;
  if (vaultWide) {
    const all = await shareRead(shared, `all\u0000${opts.deleted ? "deleted" : "live"}\u0000${vaultId}`, async () => {
      const { rows } = await db.query<{ id: string }>(
        opts.deleted
          ? `SELECT id FROM notes WHERE vault_id = $1 AND ${livePredicate}`
          : `SELECT id FROM notes WHERE vault_id = $1 AND ${livePredicate}
             UNION
             SELECT id FROM files WHERE vault_id = $1`,
        [vaultId],
      );
      return new Set(rows.map((r) => r.id));
    });
    // `reachable` is edited below; the shared set must stay untouched.
    reachable = new Set(all);
  } else {
    // A personal `denied` drops org item grants too (resolver
    // `personalVaultLevel`): only per-user shares reach the person.
    reachable = await scopedDocs(personal !== "denied", !sealed);
  }

  // The join snapshot is part of the vault-wide baseline a person's own vault
  // level replaces, so it is ignored when they have one.
  const snapshot = personal !== null ? null : await memberAccessSnapshot(db, organizationId, userId);
  if (snapshot) {
    const existingRows = await db.query<{ id: string }>(
      opts.deleted
        ? `SELECT id FROM notes
            WHERE vault_id = $1 AND ${livePredicate} AND created_at <= $2`
        : `SELECT id FROM notes
            WHERE vault_id = $1 AND ${livePredicate} AND created_at <= $2
           UNION
           SELECT id FROM files WHERE vault_id = $1 AND created_at <= $2`,
      [vaultId, snapshot.snapshotAt],
    );
    const existing = new Set(existingRows.rows.map((row) => row.id));
    if (snapshot.mode === "private") {
      for (const id of existing) reachable.delete(id);

      // Personal grants always survive the initial snapshot. Team grants only
      // survive when their ACL revision is newer than the one captured at join.
      // Group grants survive it too: a group is a named set of people.
      const allowed = await db.query<{ id: string }>(
        `WITH RECURSIVE allowed_folders AS (
           SELECT resource_id AS id FROM shares
            WHERE resource_type = 'folder'
              AND permission IN ('view', 'edit', 'readonly')
              AND ((principal_type = 'user' AND principal_id = $1)
                OR (principal_type = 'group' AND principal_id = ANY($6::text[]))
                OR (principal_type = 'org' AND principal_id = $3
                    AND access_revision > $4))
         ), subtree AS (
           SELECT id FROM folders WHERE vault_id = $2 AND id IN (SELECT id FROM allowed_folders)
           UNION
           SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id AND f.vault_id = $2
         ), allowed_files AS (
           SELECT resource_id AS id FROM shares
            WHERE resource_type = 'file'
              AND permission IN ('view', 'edit', 'readonly')
              AND ((principal_type = 'user' AND principal_id = $1)
                OR (principal_type = 'group' AND principal_id = ANY($6::text[]))
                OR (principal_type = 'org' AND principal_id = $3
                    AND access_revision > $4))
         ), vault_grant AS (
           SELECT 1 FROM shares
            WHERE resource_type = 'vault' AND resource_id = $3
              AND permission IN ('view', 'edit', 'readonly')
              AND ((principal_type = 'user' AND principal_id = $1)
                OR (principal_type = 'group' AND principal_id = ANY($6::text[]))
                OR (principal_type = 'org' AND principal_id = $3
                    AND access_revision > $4))
         )
         SELECT n.id FROM notes n
          WHERE n.vault_id = $2 AND n.${livePredicate} AND n.created_at <= $5
            AND (n.folder_id IN (SELECT id FROM subtree)
              OR n.id IN (SELECT id FROM allowed_files)
              OR EXISTS (SELECT 1 FROM vault_grant))
         ${
           opts.deleted
             ? ""
             : `UNION
                SELECT f.id FROM files f
                 WHERE f.vault_id = $2 AND f.created_at <= $5
                   AND (f.folder_id IN (SELECT id FROM subtree)
                     OR f.id IN (SELECT id FROM allowed_files)
                     OR EXISTS (SELECT 1 FROM vault_grant))`
         }`,
        [userId, vaultId, organizationId, snapshot.accessRevision, snapshot.snapshotAt, groupIds],
      );
      for (const row of allowed.rows) reachable.add(row.id);
    } else {
      for (const id of existing) reachable.add(id);
    }
  }

  if (orgDenied.size > 0) {
    const personal = await scopedDocs(false, false);
    for (const id of orgDenied) if (!personal.has(id)) reachable.delete(id);
  }
  return subtract(reachable, userDenied);
}

/** `a` minus `b`, in place on `a`. */
function subtract(a: Set<string>, b: Set<string>): Set<string> {
  for (const id of b) a.delete(id);
  return a;
}

export async function listReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
  shared?: SharedVaultReads,
): Promise<Set<string>> {
  return listDocsInVault(userId, vaultId, db, { deleted: false }, shared);
}

/**
 * doc_ids in this vault the caller could read but that are now **soft-deleted**.
 *
 * Why this exists: "absent from `GET /api/notes`" is ambiguous — it means either
 * *deleted* or *you lost read access*, because that route is ACL-filtered.
 * Absence alone can't distinguish them, and neither can `effectivePermission`:
 * `locateDoc` filters `deleted_at IS NULL`, so a deleted doc resolves to "none",
 * exactly like no access. So deletion has to be *stated*, never inferred.
 *
 * Both outcomes now remove the local file (a revocation that leaves a readable
 * `.md` on the ex-reader's disk is cosmetic), but they remain distinct: the
 * client caps them against separate budgets and reports them differently, and
 * an unanswered tombstone question still means "change nothing" — see
 * `lib/sync/inbound.ts`.
 *
 * Permission-filtered rather than "every deleted id in the vault". If a teammate
 * lost the share AND the note was deleted, the id is withheld and the client
 * falls into its "absent from both" branch — where the file is removed as a
 * REVOCATION rather than as a delete.
 *
 * That fallback is the harsher route, not the gentler one, and it is worth being
 * plain about: a revocation is removed outright with no `.context/trash` copy,
 * and on an authoritative pass its cap is lifted. So every case where a doc the
 * caller could once read is *deleted* must be answered here rather than left to
 * fall through — which is why the `deleted` branch resolves a share through
 * `folder_tombstones` when the folder that carried it has been hard-deleted.
 * An endpoint that cannot answer at all still means "change nothing".
 */
export async function listDeletedReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  return listDocsInVault(userId, vaultId, db, { deleted: true });
}

export interface VaultFolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort: number;
  created_by: string | null;
  created_at: Date;
  /** Palette id from the client's `lib/appearance`, or null. Vault-wide, so a
   *  folder tinted on one machine is tinted for the whole team. */
  color: string | null;
}

/**
 * Folders a user may SEE in the tree (private-by-default). An Open/Read-only
 * vault shows every folder to everyone who holds its grant, owners and admins
 * included — and a Private vault shows them no more than anyone else;
 * otherwise a member sees folders
 * they created, folders shared to them or the team (+ their subtrees, since
 * grants inherit down), and the ANCESTORS of anything visible so the path to a
 * shared note/folder is never missing a link.
 */
export async function listVisibleFolders(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<VaultFolderRow[]> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return [];
  const all = await db.query<VaultFolderRow>(
    "SELECT id, vault_id, parent_id, name, path, sort, created_by, created_at, color FROM folders WHERE vault_id = $1 ORDER BY sort, path",
    [vaultId],
  );
  // A per-member deny hides the folder from that person outright. An org deny
  // (item Private) hides it from the TEAM — so it does not apply to an
  // owner/admin or to someone with a personal vault grant, and a folder the
  // user created themselves stays visible either way (that's "only you").
  const userDenied = await deniedFolderIds(db, "user", userId, vaultId);
  const orgDenied = await deniedFolderIds(db, "org", access.organizationId, vaultId);
  // Item Private withdraws the team grant, but explicit per-user grants still
  // reach their subtree, exactly as they do for notes. Empty folders have no
  // readable note to bring them into the tree, so this must be folder-based.
  if (orgDenied.size > 0) {
    // A group's whole-vault grant rescues like a personal one ([[resolver]]
    // `rowsGroupGrant` applies on an item set Private).
    if (access.personal === "edit" || access.personal === "view" || access.groupVault) {
      orgDenied.clear();
    } else {
      const { rows: personalFolders } = await db.query<{ id: string }>(
        `WITH RECURSIVE granted AS (
           SELECT f.id FROM folders f JOIN shares s ON s.resource_id = f.id
            WHERE f.vault_id = $2 AND s.resource_type = 'folder'
              AND ((s.principal_type = 'user' AND s.principal_id = $1)
                OR (s.principal_type = 'group' AND s.principal_id = ANY($3::text[])))
              AND s.permission IN ('view', 'edit', 'readonly')
           UNION
           SELECT f.id FROM folders f JOIN granted g ON f.parent_id = g.id AND f.vault_id = $2
         ) SELECT id FROM granted`,
        [userId, vaultId, access.groupIds],
      );
      for (const row of personalFolders) orgDenied.delete(row.id);
    }
  }
  // Neither deny is undone by authorship — see `listDocsInVault`.
  const hidden = (id: string) => userDenied.has(id) || orgDenied.has(id);
  // A per-user grant deeper than a per-user deny lifts that subfolder, so its
  // denied ANCESTORS stay in the tree as the path to it (names only; their
  // notes stay hidden) — the same "never a missing link" rule as below.
  // Folders a per-user deny hides but that hold a note a deeper per-user row
  // lifted — the path to that note. Only read when such a deny exists.
  const liftedHomes = new Set<string>();
  if (userDenied.size > 0 || orgDenied.size > 0) {
    const readableHere = await listReadableDocsInVault(userId, vaultId, db);
    const { rows: homes } = await db.query<{ folder_id: string }>(
      `SELECT DISTINCT folder_id FROM notes
        WHERE vault_id = $1 AND deleted_at IS NULL AND folder_id = ANY($2::text[]) AND id = ANY($3::text[])
       UNION
       SELECT DISTINCT folder_id FROM files
        WHERE vault_id = $1 AND folder_id = ANY($2::text[]) AND id = ANY($3::text[])`,
      [vaultId, [...new Set([...userDenied, ...orgDenied])], [...readableHere]],
    );
    for (const h of homes) liftedHomes.add(h.folder_id);
  }
  const finish = (shown: VaultFolderRow[]): VaultFolderRow[] => {
    const byId = new Map(all.rows.map((f) => [f.id, f]));
    const ids = new Set(shown.map((f) => f.id));
    const starts = [...shown];
    for (const id of liftedHomes) {
      const home = byId.get(id);
      if (home && !ids.has(id)) {
        ids.add(id);
        starts.push(home);
      }
    }
    for (const f of starts) {
      let parent = f.parent_id;
      while (parent && !ids.has(parent)) {
        ids.add(parent);
        parent = byId.get(parent)?.parent_id ?? null;
      }
    }
    return all.rows.filter((f) => ids.has(f.id));
  };
  // A person's own vault level replaces the join snapshot (see `listDocsInVault`).
  const snapshot = access.personal !== null ? null : await memberAccessSnapshot(db, access.organizationId, userId);
  if (access.vaultWide && snapshot?.mode !== "private") {
    return finish(all.rows.filter((f) => !hidden(f.id)));
  }

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  // A personal `denied` drops org item grants, so team folder shares seed nothing.
  const isMember = access.role !== null && access.personal !== "denied";
  // Authorship seeds the tree everywhere EXCEPT in a SEALED vault, which drops
  // it for everyone (see `listDocsInVault`). Leaving it in would show a folder
  // whose every note has gone — the tree and the notes in it disagreeing about
  // the same setting.
  const authorSeeds =
    access.personal === null && (await vaultBaseline(db, access.organizationId)) !== "sealed";
  const { rows: visibleIds } = await db.query<{ id: string }>(
    `WITH RECURSIVE seed AS (
        SELECT id FROM folders WHERE vault_id = $2 AND $6 AND created_by = $1
        UNION
        SELECT resource_id AS id FROM shares
         WHERE resource_type = 'folder' AND permission IN ('view', 'edit', 'readonly')
           AND (
             (principal_type = 'user' AND principal_id = $1)
             OR ($4 AND principal_type = 'org' AND principal_id = $3)
             OR (principal_type = 'group' AND principal_id = ANY($7::text[]))
           )
     ),
     down AS (
        SELECT id, parent_id FROM folders WHERE vault_id = $2 AND id IN (SELECT id FROM seed)
        UNION
        SELECT f.id, f.parent_id FROM folders f JOIN down d ON f.parent_id = d.id AND f.vault_id = $2
     ),
     note_folders AS (
        SELECT DISTINCT folder_id AS id FROM notes
         WHERE vault_id = $2 AND deleted_at IS NULL AND folder_id IS NOT NULL
           AND id = ANY($5::text[])
     ),
     up AS (
        SELECT id, parent_id FROM folders
         WHERE vault_id = $2
           AND id IN (SELECT id FROM down UNION SELECT id FROM note_folders)
        UNION
        SELECT f.id, f.parent_id FROM folders f JOIN up u ON f.id = u.parent_id AND f.vault_id = $2
     )
     SELECT DISTINCT id FROM up`,
    [userId, vaultId, access.organizationId, isMember, [...readable], authorSeeds, access.groupIds],
  );
  const visible = new Set(visibleIds.map((r) => r.id));
  if (snapshot?.mode === "private") {
    const { rows: snapshotVisible } = await db.query<{ id: string }>(
      `WITH RECURSIVE granted AS (
         SELECT resource_id AS id FROM shares
          WHERE resource_type = 'folder'
            AND permission IN ('view', 'edit', 'readonly')
            AND ((principal_type = 'user' AND principal_id = $1)
              OR (principal_type = 'group' AND principal_id = ANY($6::text[]))
              OR (principal_type = 'org' AND principal_id = $3
                  AND access_revision > $4))
       ), down AS (
         SELECT id, parent_id FROM folders
          WHERE vault_id = $2 AND id IN (SELECT id FROM granted)
         UNION
         SELECT f.id, f.parent_id FROM folders f JOIN down d ON f.parent_id = d.id AND f.vault_id = $2
       ), note_folders AS (
         SELECT DISTINCT folder_id AS id FROM notes
          WHERE vault_id = $2 AND deleted_at IS NULL AND folder_id IS NOT NULL
            AND id = ANY($5::text[])
         UNION
         SELECT DISTINCT folder_id AS id FROM files
          WHERE vault_id = $2 AND folder_id IS NOT NULL AND id = ANY($5::text[])
       ), up AS (
         SELECT id, parent_id FROM folders
          WHERE vault_id = $2
            AND id IN (SELECT id FROM down UNION SELECT id FROM note_folders)
         UNION
         SELECT f.id, f.parent_id FROM folders f JOIN up u ON f.id = u.parent_id AND f.vault_id = $2
       )
       SELECT id FROM up`,
      [userId, vaultId, access.organizationId, snapshot.accessRevision, [...readable], access.groupIds],
    );
    const admitted = new Set(snapshotVisible.map((row) => row.id));
    for (const folder of all.rows) {
      if (folder.created_at <= snapshot.snapshotAt && !admitted.has(folder.id)) {
        visible.delete(folder.id);
      }
    }
  }
  return finish(all.rows.filter((f) => visible.has(f.id) && !hidden(f.id)));
}
