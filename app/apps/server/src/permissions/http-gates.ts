import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole, vaultOrg } from "./lookup.js";
import {
  ancestorFolderIds,
  buildAccessContext,
  effectivePermission,
  isDenied,
  isLocked,
  resolveAccessForUser,
  vaultBaseline,
  type ResolverCache,
} from "./resolver.js";
import { listReadableDocsInVault, vaultAccess } from "./vault-docs.js";

type Queryable = Pick<pg.Pool, "query">;

/** Escape SQL LIKE metacharacters so a value is matched literally under
 *  `LIKE … ESCAPE '\'`. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Authorization gates for the session-authenticated HTTP registry/blob routes.
 *
 * These exist so the HTTP layer stops authorizing structural mutations on bare
 * vault membership and instead uses the SAME per-doc/per-folder ACL the MCP
 * layer already enforces (`effectivePermission` / `folderWritePermission`).
 * Owner/admin, a note's creator, and edit-share holders keep their access; a
 * plain member with no grant no longer can mutate content they cannot read.
 */

/** May `userId` edit (rename/move/delete) note or file `docId`? Mirrors the
 *  MCP `requireEditableNote` gate: owner/admin, the note's creator, or an
 *  edit share — with a lock capping to view (→ false). */
export async function canEditDoc(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  return (await effectivePermission(userId, docId, db)) === "edit";
}

/**
 * May `userId` modify folder `folderId` (rename / re-parent / delete)?
 *
 * Allowed for the vault owner/admin, the folder's creator (mirrors the note
 * creator rule so a member can still manage their own private folders), or a
 * user/team edit share on the folder or any ancestor. A lock on the folder or
 * any ancestor makes it read-only for everyone (owners/admins included),
 * matching `folderWritePermission` in the MCP service.
 *
 * The vault posture, exactly as the resolver applies it ([[resolver]]
 * `vaultBaseline`):
 *   · Read-only withdraws the owner/admin shortcut AND the creator rule for
 *     everyone — it is the lock — and only an edit grant lifts someone out.
 *   · Private (`sealed`) keeps the owner/admin shortcut and withdraws the
 *     creator rule from members — you cannot restructure what you cannot read,
 *     and there authorship no longer lets a member read it (#217).
 *   · A vault that was never shared keeps the owner/admin shortcut too: a
 *     folder nobody has been given cannot be "someone else's" to its owner, and
 *     withdrawing it refused owners inside every folder a teammate made or that
 *     predates `created_by` (#217). Members keep the creator rule there.
 */
export async function canEditFolder(
  userId: string,
  folderId: string,
  db: Queryable = defaultPool,
  /** Request-scoped memo for the per-vault / per-folder inputs. Never changes
   *  the answer — see `permissions/resolver.ts ResolverCache`. */
  cache?: ResolverCache,
): Promise<boolean> {
  const { rows } = await db.query<{
    created_by: string | null;
    organization_id: string;
  }>(
    `SELECT f.created_by, v.organization_id
       FROM folders f JOIN vaults v ON v.id = f.vault_id
      WHERE f.id = $1`,
    [folderId],
  );
  const row = rows[0];
  if (!row) return false;

  const role = cache
    ? await cache.role(db, row.organization_id, userId)
    : await orgRole(row.organization_id, userId, db);
  if (role === null) return false; // not a member of the vault

  // Overlays first — they outrank the role below, because what the Access panel
  // sets applies to whoever set it.
  const chain = cache
    ? await cache.ancestors(db, folderId)
    : await ancestorFolderIds(db, folderId);
  if (await isDenied(db, "user", userId, null, chain)) return false;
  if (await isLocked(db, userId, null, chain)) return false;
  const itemPrivate = await isDenied(db, "org", row.organization_id, null, chain);
  const baseline = cache
    ? await cache.baseline(db, row.organization_id)
    : await vaultBaseline(db, row.organization_id);
  const readOnlyVault = baseline === "view";
  const sealedVault = baseline === "sealed";
  const privileged = role === "owner" || role === "admin";

  // An item set Private, a Read-only vault and (for members) a sealed vault all
  // skip the shortcuts AND the creator rule, and let the share lookup decide —
  // that is how a folder marked Shared still lifts someone out of any of them.
  if (itemPrivate || readOnlyVault || (sealedVault && !privileged)) {
    const ctx = await buildAccessContext("folder", folderId, db, cache);
    if (!ctx) return false;
    return (await resolveAccessForUser(ctx, userId, role, db, cache)).permission === "edit";
  }
  // Shared, Private and never-shared all keep the owner/admin shortcut here.
  if (privileged) return true;
  if (row.created_by && row.created_by === userId) return true;

  // Else: an explicit user/team edit share on the folder or an ancestor.
  const ctx = await buildAccessContext("folder", folderId, db, cache);
  if (!ctx) return false;
  const resolved = await resolveAccessForUser(ctx, userId, role, db, cache);
  return resolved.permission === "edit";
}

/** A blob row as the ACL gates need to see it: where it lives, and whether it
 *  is a tree file with a doc of its own. */
export interface BlobAclRow {
  vault_id?: string | null;
  rel_path: string | null;
  doc_id?: string | null;
}

/**
 * The `files` row a blob's `doc_id` names, if it is really there.
 *
 * `blobs.doc_id` is client-supplied (the desktop registers the file first and
 * then uploads its bytes with the same id), so it can name a row that does not
 * exist yet or one that has since been deleted. Every gate below asks THIS
 * rather than trusting the column: an unresolvable doc_id falls back to the
 * path heuristic, so a half-finished registration degrades to the old
 * behaviour instead of making the bytes unreachable for everyone.
 */
async function fileDoc(
  db: Queryable,
  vaultId: string,
  docId: string,
): Promise<{ folder_id: string | null } | null> {
  const { rows } = await db.query<{ folder_id: string | null }>(
    "SELECT folder_id FROM files WHERE id = $1 AND vault_id = $2",
    [docId, vaultId],
  );
  return rows[0] ?? null;
}

/**
 * May `userId` read attachment blob `relPath` in vault `vaultId`?
 *
 * TWO BRANCHES, and which one applies is decided by the blob's `doc_id`:
 *
 *   · **a tree file** (`doc_id` names a `files` row) — the answer is
 *     `effectivePermission`, the same resolver every note goes through. A
 *     `.xlsx` in a shared folder is readable by exactly the people who can read
 *     a `.md` beside it, and the folder walk, org grants, the sealed posture,
 *     per-user denies and `locked` caps all come along for free. This is what
 *     PR3 exists for: before it, a member shared one folder could open its
 *     notes and not its files.
 *   · **an `attachments/` drop** (no `doc_id`: the hash-named blobs the editor
 *     writes, and everything that predates this) — unchanged. Those have no ACL
 *     row of their own, so access derives from the notes that embed them: a
 *     caller with vault-wide read (an Open/Read-only grant) sees every blob,
 *     including orphaned ones, while a scoped member may fetch one only if some
 *     note they can READ references it. That closes the IDOR where any member
 *     could download every attachment, and it stays best-effort by design — the
 *     reference check reads `note_index.content`, so a just-embedded attachment
 *     becomes fetchable to other readers once its note is indexed (attachment
 *     sync is already eventually-consistent).
 */
export async function canReadAttachment(
  userId: string,
  vaultId: string,
  relPath: string | null,
  docId: string | null = null,
  db: Queryable = defaultPool,
): Promise<boolean> {
  if (docId && (await fileDoc(db, vaultId, docId))) {
    return (await effectivePermission(userId, docId, db)) !== "none";
  }
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return false; // unknown vault or not a member
  if (access.vaultWide) return true; // owner/admin or vault-wide grant
  if (!relPath) return false; // legacy blob w/o a path — no readable note to tie it to

  const readable = await listReadableDocsInVault(userId, vaultId, db);
  if (readable.size === 0) return false;
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM note_index
      WHERE vault_id = $1 AND doc_id = ANY($2::text[])
        AND content LIKE '%' || $3 || '%' ESCAPE '\\'
      LIMIT 1`,
    [vaultId, [...readable], likeEscape(relPath)],
  );
  return rows.length > 0;
}

/**
 * Filter a vault's blob list to the ones `userId` may read (see
 * {@link canReadAttachment}). The same two branches, applied to a batch.
 *
 * Tree files are settled by intersecting their `doc_id`s with
 * `listReadableDocsInVault` — ONE query for the whole list, and the set-based
 * dual of the `effectivePermission` the single-blob gate runs. It is asked even
 * for a vault-wide reader, because that set already accounts for the grant and
 * still subtracts a per-user deny, so a file someone was explicitly refused
 * does not reappear in a listing.
 *
 * Everything else — no `doc_id`, or one that names no `files` row — goes
 * through the path heuristic unchanged: vault-wide readers get all of it, a
 * scoped member only what a readable note references. That test runs in
 * Postgres, one `LIKE` per (path, readable note). It used to `SELECT content`
 * for every readable doc and concatenate the lot into one JS string — i.e. pull
 * an entire vault's markdown into the heap of a list request, on a path a
 * scoped member hits on every attachment sync.
 */
export async function filterReadableBlobs<T extends BlobAclRow>(
  userId: string,
  vaultId: string,
  blobs: T[],
  db: Queryable = defaultPool,
): Promise<T[]> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access) return [];

  // Which of the claimed doc_ids are really `files` rows in this vault. A
  // claim that resolves to nothing is not a tree file, so its blob falls into
  // the path branch below rather than being judged on a doc that isn't there.
  const claimed = [...new Set(blobs.map((b) => b.doc_id).filter((d): d is string => !!d))];
  let readableDocs = new Set<string>();
  let realDocs = new Set<string>();
  if (claimed.length > 0) {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM files WHERE vault_id = $1 AND id = ANY($2::text[])",
      [vaultId, claimed],
    );
    realDocs = new Set(rows.map((r) => r.id));
    if (realDocs.size > 0) readableDocs = await listReadableDocsInVault(userId, vaultId, db);
  }
  const isTreeFile = (b: T): boolean => !!b.doc_id && realDocs.has(b.doc_id);
  const rest = blobs.filter((b) => !isTreeFile(b));
  // The caller's order is the caller's (the list route sorts by rel_path in
  // SQL), so the two branches decide membership and the original array decides
  // sequence — never `[...files, ...rest]`.
  const keep = new Set<T>(
    blobs.filter((b) => isTreeFile(b) && readableDocs.has(b.doc_id as string)),
  );
  if (rest.length > 0) {
    const visibleRest = access.vaultWide
      ? rest
      : await filterByNoteReference(userId, vaultId, rest, db);
    for (const b of visibleRest) keep.add(b);
  }
  return blobs.filter((b) => keep.has(b));
}

/** The `attachments/` half of {@link filterReadableBlobs}: blobs a scoped
 *  member may see only because a note they can read points at them. */
async function filterByNoteReference<T extends BlobAclRow>(
  userId: string,
  vaultId: string,
  blobs: T[],
  db: Queryable,
): Promise<T[]> {
  const readable = await listReadableDocsInVault(userId, vaultId, db);
  if (readable.size === 0) return [];
  // A falsy rel_path can never match (it has no needle to search for), so it is
  // dropped here exactly as the old `!!b.rel_path` guard dropped it.
  const paths = [...new Set(blobs.map((b) => b.rel_path).filter((p): p is string => !!p))];
  if (paths.length === 0) return [];

  // Two parallel arrays, not one: the escaped form is what LIKE matches, the raw
  // form is what maps the answer back onto the blob rows.
  const { rows } = await db.query<{ rel_path: string }>(
    `SELECT p.rel_path
       FROM unnest($3::text[], $4::text[]) AS p(rel_path, needle)
      WHERE EXISTS (
        SELECT 1 FROM note_index ni
         WHERE ni.vault_id = $1 AND ni.doc_id = ANY($2::text[])
           AND ni.content LIKE '%' || p.needle || '%' ESCAPE '\\'
      )`,
    [vaultId, [...readable], paths, paths.map(likeEscape)],
  );
  const referenced = new Set(rows.map((r) => r.rel_path));
  return blobs.filter((b) => !!b.rel_path && referenced.has(b.rel_path));
}

/**
 * May `userId` CREATE a folder / note / file at `folderId` in `vaultId`?
 *
 * Creating is a write, and until now the HTTP registry's three create routes
 * asked only "are you a member of this vault?" — so a read-only user could not
 * change a single note but could add as many as they liked next to them. The
 * three ways a vault turns read-only (a `locked` share, a `view` grant, the
 * vault-wide Read-only posture) all have to close this door too, or "read-only"
 * means "cannot edit what already exists".
 *
 * Inside a folder this is exactly {@link canEditFolder} — the same gate MCP's
 * `create_note` / `create_folder` already use (`folderWritePermission`), so the
 * two surfaces cannot drift.
 *
 * At the vault ROOT there is no folder row to resolve against, and the two
 * surfaces legitimately differ: MCP keeps root writes admin-only, HTTP has
 * never applied that rule and a plain member creating a note at the top of
 * their own vault is the normal case. So the root check enforces only the
 * read-only contract: under the Read-only posture nobody creates at the root —
 * owners and admins included, because `vaultBaseline` caps every shortcut for
 * everyone (see the resolver) and an owner who can still add notes has not
 * really set the vault read-only. The way back is the Access panel, which is
 * role-gated through `shares.ts canManage` and so is unaffected; a per-user
 * vault-scoped `edit` grant also lifts one person out, exactly as it does for
 * editing an existing root note.
 */
export async function canCreateIn(
  userId: string,
  vaultId: string,
  folderId: string | null,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<boolean> {
  if (folderId) return canEditFolder(userId, folderId, db, cache);

  const org = await vaultOrg(vaultId, db);
  if (!org) return false;
  const role = cache ? await cache.role(db, org, userId) : await orgRole(org, userId, db);
  if (role === null) return false; // not a member of the vault
  return vaultRootWritable(userId, org, db, cache);
}

/**
 * Is the vault ROOT writable for `userId` at all?
 *
 * True unless the vault posture is Read-only, or sealed (Private) for a caller
 * who is not an owner or admin. In those cases only an explicit per-user
 * vault-scoped `edit` grant survives — the one thing the resolver's posture
 * branch still honours where there is no folder for a share to hang on. Says
 * nothing about membership; callers add that. A vault that was never shared
 * stays writable: that is the private-by-default space, where what you create
 * is yours.
 *
 * Read-only refuses owners and admins too: it is the lock. Private does not:
 * it withdraws the team, and its owners and admins keep full access, root
 * creates included (#217). For a MEMBER, sealed belongs here for the same
 * reason Read-only does, and the failure it prevents is sharper: a member in a
 * sealed vault cannot read a note that was not shared with them, authorship
 * included, so a root create would hand them a note that vanished from their
 * own disk the moment it synced.
 *
 * Shared with the MCP layer (`folderWritePermission`), whose root branch is
 * admin-only and so was the one place a restricted vault still let writes
 * through: an owner could not touch a single existing note but could keep
 * creating new ones at the root.
 */
export async function vaultRootWritable(
  userId: string,
  organizationId: string,
  db: Queryable = defaultPool,
  cache?: ResolverCache,
): Promise<boolean> {
  const posture = cache
    ? await cache.baseline(db, organizationId)
    : await vaultBaseline(db, organizationId);
  if (posture !== "view" && posture !== "sealed") return true;
  if (posture === "sealed") {
    // Private keeps the people who run the vault — mirrors the resolver.
    const role = cache
      ? await cache.role(db, organizationId, userId)
      : await orgRole(organizationId, userId, db);
    if (role === "owner" || role === "admin") return true;
  }
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE resource_type = 'vault' AND resource_id = $1
        AND principal_type = 'user' AND principal_id = $2
        AND permission = 'edit'
      LIMIT 1`,
    [organizationId, userId],
  );
  return rows.length > 0;
}

/**
 * May `userId` UPLOAD an attachment blob into `vaultId`?
 *
 * Attachments carry no folder_id and no per-blob ACL row (see
 * {@link canReadAttachment}: read access is derived from the notes that embed
 * them), so there is no folder to resolve a lock or a `view` grant against —
 * only the vault-wide posture applies here, and it is the one that matters:
 * under Read-only NOBODY adds bytes to the vault, owners and admins included,
 * exactly as `vaultBaseline` caps every other write. A per-user vault-scoped
 * `edit` grant lifts one person out, as everywhere else.
 *
 * Known limit, now confined to the blobs it was always really about: a member
 * who is read-only only because of a folder lock or a folder `view` grant can
 * still upload a hash-named `attachments/` blob. It is inert on its own — it
 * becomes visible to anyone else only when a note they can read references it,
 * and writing that reference is gated by the note's own permission. A blob that
 * belongs to a tree file goes through {@link canWriteBlob} instead, which HAS a
 * folder to resolve those two overlays against.
 */
export async function canWriteAttachment(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const access = await vaultAccess(db, userId, vaultId);
  if (!access || access.role === null) return false; // unknown vault or not a member
  return vaultRootWritable(userId, access.organizationId, db);
}

/**
 * May `userId` WRITE (publish, replace the text of, or delete) this blob?
 *
 * The single gate every blob mutation now asks, and the place the folder-lock
 * hole in {@link canWriteAttachment} finally closes — for the blobs that can
 * close it. A blob with a `doc_id` IS a file at a known place in the tree, so
 * there is a doc to resolve a lock or a `view` grant against, and that question
 * is asked FIRST ({@link canEditDoc}) — the same gate a rename or a registry
 * delete of that file answers to, so bytes and row cannot end up with different
 * locks. A blob whose `doc_id` names no registered file yet is a fresh upload:
 * there is nothing to have edit rights ON, so it falls through to the vault
 * posture.
 *
 * Without a resolvable `doc_id` there is still no folder to ask about, and the
 * vault-wide posture remains the whole answer. That is the documented limit
 * {@link canWriteAttachment} describes, now scoped to the blobs it was always
 * really about: the hash-named `attachments/` drops, which are inert until a
 * note someone can edit points at them.
 */
export async function canWriteBlob(
  userId: string,
  blob: BlobAclRow,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const vaultId = blob.vault_id;
  if (!vaultId) return false; // a legacy row with no collection has no folder and no posture
  if (blob.doc_id) {
    const file = await fileDoc(db, vaultId, blob.doc_id);
    if (file) {
      // The file ALREADY EXISTS, so `canCreateIn` on its folder is not the whole
      // question: it answers "may you put something here", and a share that caps
      // THIS DOC at view — a `locked` row, or a view-only grant on the file —
      // does not show up in it at all. Create rights in the folder were
      // therefore enough to destroy someone else's file bytes.
      //
      // Asked in two steps rather than swapped for `canEditDoc` outright,
      // because the resolver and the folder gate disagree in a direction that
      // matters: in a vault that was never shared, `effectivePermission`
      // withdraws the owner/admin shortcut (the private-by-default space) and
      // answers `none` for a file nobody is recorded as having authored, while
      // `canCreateIn` correctly still lets the owner write in their own vault.
      // So an explicit `view` — the cap this is about — refuses, and everything
      // else keeps the folder answer.
      if (await canEditDoc(userId, blob.doc_id, db)) return true;
      if ((await effectivePermission(userId, blob.doc_id, db)) === "view") return false;
      return canCreateIn(userId, vaultId, file.folder_id, db);
    }
  }
  return canWriteAttachment(userId, vaultId, db);
}
