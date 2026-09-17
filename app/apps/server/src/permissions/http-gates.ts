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
 * A SEALED vault (the Access panel's Private) withdraws the owner/admin
 * shortcut AND the creator rule, exactly as the resolver does ([[resolver]]
 * `vaultBaseline`) — you cannot restructure what you cannot read, and there
 * authorship no longer lets you read it. A vault that was merely never shared
 * withdraws the role shortcut only, and its folders' creators keep them.
 */
export async function canEditFolder(
  userId: string,
  folderId: string,
  db: Queryable = defaultPool,
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

  const role = await orgRole(row.organization_id, userId, db);
  if (role === null) return false; // not a member of the vault

  // Overlays first — they outrank the role below, because what the Access panel
  // sets applies to whoever set it.
  const chain = await ancestorFolderIds(db, folderId);
  if (await isDenied(db, "user", userId, null, chain)) return false;
  if (await isLocked(db, userId, null, chain)) return false;
  const itemPrivate = await isDenied(db, "org", row.organization_id, null, chain);
  const baseline = await vaultBaseline(db, row.organization_id);
  const readOnlyVault = baseline === "view";
  const sealedVault = baseline === "sealed";
  const ungrantedVault = baseline === null;

  // An item set Private, a Read-only vault and a sealed vault all skip the
  // shortcuts AND the creator rule, and let the share lookup decide — that is
  // how a folder marked Shared still lifts someone out of any of the three.
  if (itemPrivate || readOnlyVault || sealedVault) {
    const ctx = await buildAccessContext("folder", folderId, db);
    if (!ctx) return false;
    return (await resolveAccessForUser(ctx, userId, role, db)).permission === "edit";
  }
  // A never-shared vault skips only the role shortcut; the creator rule below
  // is the private-by-default space, so it has to stay ordered this way round.
  if (!ungrantedVault && (role === "owner" || role === "admin")) return true;
  if (row.created_by && row.created_by === userId) return true;

  // Else: an explicit user/team edit share on the folder or an ancestor.
  const ctx = await buildAccessContext("folder", folderId, db);
  if (!ctx) return false;
  const resolved = await resolveAccessForUser(ctx, userId, role, db);
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
): Promise<boolean> {
  if (folderId) return canEditFolder(userId, folderId, db);

  const org = await vaultOrg(vaultId, db);
  if (!org) return false;
  const role = await orgRole(org, userId, db);
  if (role === null) return false; // not a member of the vault
  return vaultRootWritable(userId, org, db);
}

/**
 * Is the vault ROOT writable for `userId` at all?
 *
 * True unless the vault posture is Read-only **or sealed**, in which case only
 * an explicit per-user vault-scoped `edit` grant survives — the one thing the
 * resolver's posture branch still honours where there is no folder for a share
 * to hang on. Says nothing about membership or role; callers add that. A vault
 * that was never shared stays writable: that is the private-by-default space,
 * where what you create is yours.
 *
 * Sealed belongs here for the same reason Read-only does, and the failure it
 * prevents is sharper: in a sealed vault nobody can read a note they did not
 * have shared with them, authorship included, so a root create would have
 * handed someone a note that vanished from their own disk the moment it synced.
 * Creating in a vault you cannot read is not a lesser write, it is a worse one.
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
): Promise<boolean> {
  const posture = await vaultBaseline(db, organizationId);
  if (posture !== "view" && posture !== "sealed") return true;
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
 * there is a folder to resolve a lock or a `view` grant against, and the answer
 * is {@link canCreateIn} on that folder: exactly the gate the `files` row's own
 * registration went through, so bytes and row cannot end up with different
 * locks. At the vault root that is `vaultRootWritable` — the same test
 * `canWriteAttachment` applies — so nothing changes for a file sitting at the
 * top of a vault.
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
    if (file) return canCreateIn(userId, vaultId, file.folder_id, db);
  }
  return canWriteAttachment(userId, vaultId, db);
}
