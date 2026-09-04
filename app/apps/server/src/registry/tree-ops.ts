import type pg from "pg";

/**
 * Structural operations on a vault's folder/note tree, shared by the
 * session-authenticated HTTP registry routes and the MCP tools.
 *
 * These two entry points used to implement the same moves separately, which is
 * how they drifted: only one of them guarded re-parenting, only one of them
 * disconnected live editors, and each had its own copy of the LIKE-escaping.
 * Anything that must be true of a move regardless of *who* asked for it lives
 * here — data integrity (no cycles, no cross-vault parents, no path collisions)
 * and the path-prefix rewrites.
 *
 * Authorization deliberately stays OUT. The callers gate differently and both
 * are right: HTTP resolves the session user against `canEditFolder`/`canEditDoc`,
 * MCP additionally checks the token's vault scope. Pushing either into these
 * helpers would force one caller's rules onto the other.
 */

type Queryable = Pick<pg.Pool, "query">;

/** basename of a `/`-separated vault-relative path. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** dirname of a `/`-separated vault-relative path; `""` for a root-level path. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Do two vault-relative paths name the same item? Compared **case-insensitively**,
 * because most of our clients cannot tell them apart.
 *
 * macOS (APFS default) and Windows are case-INSENSITIVE, so `Projects/Community`
 * and `Projects/community` are one directory on disk. Postgres `TEXT` compares
 * case-sensitively, so the server used to store both as distinct rows with
 * distinct `doc_id`s — and then every desktop mapped ONE file to TWO docs. Each
 * doc egested to disk, the watcher fired, the other doc ingested a file that
 * disagreed with its CRDT state and wrote back, forever: the 2026-09-04 BenAI OS
 * runaway, 189 MB of updates an hour, where 328 notes (0.5% of the vault) were
 * 26% of all CRDT bytes. Migration 021's `notes_live_path_uq` does not catch it
 * — the collision is case-only, so both rows satisfy an exact-path unique index.
 *
 * A vault that syncs between a Mac and a Linux box therefore cannot safely hold
 * case-variant siblings: the Mac physically cannot represent both. We treat them
 * as one item everywhere (the same call Git makes with `core.ignorecase`), which
 * costs a case-sensitive Linux vault the ability to keep `a.md` and `A.md` apart
 * and buys every other vault immunity from the fork.
 *
 * `toLowerCase()`, not `localeCompare`: it must agree exactly with the
 * `lower()`-based unique indexes in migration 023 for the backstop to hold.
 */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A vault-relative path the tree can hold: non-empty, no leading/trailing `/`,
 * no empty, `.` or `..` segments. Same shape the desktop's `resolve_in_vault`
 * enforces on disk, so a path the server accepts is one every client can write.
 */
export function assertValidRelPath(path: string, what = "path"): void {
  const bad =
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) throw new TreeOpError(`Invalid ${what} "${path}"`);
}

/**
 * Load the folder at `path` in `vaultId`, or null.
 *
 * Matched case-insensitively (see {@link samePath}), so a client that walked a
 * case-insensitive disk and reports `Projects/community` resolves to the
 * existing `Projects/Community` row instead of being told to create a twin.
 * The returned row carries the CANONICAL stored path — callers hand that back to
 * the client so it converges on one spelling.
 *
 * Ordered so the result is stable when a pre-migration-023 vault still holds
 * case-variant twins: oldest wins, matching migration 023's keeper rule.
 */
export async function findFolderByPath(
  db: Queryable,
  vaultId: string,
  path: string,
): Promise<FolderRow | null> {
  const { rows } = await db.query<FolderRow>(
    `SELECT id, vault_id, path, parent_id FROM folders
      WHERE vault_id = $1 AND lower(path) = lower($2)
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [vaultId, path],
  );
  return rows[0] ?? null;
}

/**
 * The folder a note (or file) at `relPath` belongs to — derived from the path,
 * and checked against the caller's `folderId` when one is given.
 *
 * A note's location is stored twice: `rel_path` (what every client renders and
 * writes to disk) and `folder_id` (what every ACL walk and the root-freeze latch
 * read). Nothing used to tie them together, and the two surfaces that create
 * notes took both as independent inputs. The 2026-08-27 phantom-root-folder
 * incident is what that allows: an assistant passed `folderId` of
 * `Team/BenAI/…/Daily` with a `relPath` that dropped the `Team/` prefix. The
 * freeze saw a parent and let it through; every desktop then rendered a
 * root-level `BenAI/` folder that no folder row backed, materialized an empty
 * placeholder for it, and re-created it after every local delete (disk
 * deletions never propagate). Separately, 100+ notes had been registered with
 * `folderId: null` and a nested path — "at the root" for permissions, so
 * folder shares never reached them.
 *
 * Rules:
 *  - `folderId` given → that folder must exist in this vault AND its path must
 *    equal `dirname(relPath)`. A mismatch is refused, not silently repaired —
 *    the caller (usually an LLM) needs to learn which of its two inputs is wrong.
 *  - `folderId` absent/null → resolve by `dirname(relPath)`: `""` is the root
 *    (null); otherwise the folder at that path must already exist.
 *
 * The parent is matched case-insensitively ({@link samePath}), and the returned
 * `relPath` is rewritten onto the parent's OWN spelling. Both matter: a client
 * reporting `Projects/community/x.md` when the folder row says
 * `Projects/Community` must resolve to that folder rather than be told to create
 * a twin, and the stored path must then agree with it exactly, or migration
 * 022's `dirname(rel_path) === folder.path` invariant would hold only up to case
 * and the next move would refuse itself.
 */
export interface ResolvedLocation {
  /** Resolved parent folder id; `null` = vault root. */
  folderId: string | null;
  /** The path to store: the parent's spelling + the caller's basename. */
  relPath: string;
}

/** Join a parent path (possibly `""` for the root) and a basename. */
export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export async function resolveParentFolder(
  db: Queryable,
  vaultId: string,
  relPath: string,
  folderId: string | null | undefined,
): Promise<ResolvedLocation> {
  assertValidRelPath(relPath);
  const dir = dirname(relPath);
  if (folderId != null) {
    const folder = await findFolder(db, folderId);
    if (!folder) throw new TreeOpError("Unknown folder");
    if (folder.vault_id !== vaultId) throw new TreeOpError("Folder is in a different vault");
    if (!samePath(folder.path, dir)) {
      throw new TreeOpError(
        `"${relPath}" is not inside folder "${folder.path}" — use relPath "${folder.path}/${basename(relPath)}" or the folder whose path is "${dir}"`,
      );
    }
    return { folderId: folder.id, relPath: joinPath(folder.path, basename(relPath)) };
  }
  if (dir === "") return { folderId: null, relPath };
  const byPath = await findFolderByPath(db, vaultId, dir);
  if (!byPath) throw new TreeOpError(`No folder at "${dir}" — create it first`);
  return { folderId: byPath.id, relPath: joinPath(byPath.path, basename(relPath)) };
}

/**
 * Folder twin of {@link resolveParentFolder}: the parent of a folder at `path`,
 * checked against `parentId` when given. `folders.path`/`parent_id` carry the
 * same duplicated-location hazard as notes.
 */
export async function resolveFolderParent(
  db: Queryable,
  vaultId: string,
  path: string,
  parentId: string | null | undefined,
): Promise<ResolvedLocation> {
  assertValidRelPath(path, "folder path");
  const dir = dirname(path);
  if (parentId != null) {
    const parent = await findFolder(db, parentId);
    if (!parent) throw new TreeOpError("Unknown parent folder");
    if (parent.vault_id !== vaultId) throw new TreeOpError("Parent folder is in a different vault");
    if (!samePath(parent.path, dir)) {
      throw new TreeOpError(`Folder path "${path}" is not inside its parent "${parent.path}"`);
    }
    return { folderId: parent.id, relPath: joinPath(parent.path, basename(path)) };
  }
  if (dir === "") return { folderId: null, relPath: path };
  const byPath = await findFolderByPath(db, vaultId, dir);
  if (!byPath) throw new TreeOpError(`No folder at "${dir}" — create it first`);
  return { folderId: byPath.id, relPath: joinPath(byPath.path, basename(path)) };
}

/** Escape SQL LIKE metacharacters (\ % _) so a value is matched literally under
 *  `LIKE … ESCAPE '\'`. Single home: a folder named `100%_done` must not widen a
 *  subtree rewrite or a cascade delete into unrelated notes. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** A move/rename was refused for an integrity reason (not permissions). */
export class TreeOpError extends Error {}

/** Rewrite the path prefix of every descendant folder + note of a moved folder.
 *  `oldPath`/`newPath` are the folder's own paths; children share the prefix. */
export async function rewriteDescendantPaths(
  db: Queryable,
  vaultId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  // Postgres substring is 1-indexed; keep everything AFTER the old prefix. The
  // $4::int cast is load-bearing: a bare text param would select substring's
  // REGEX overload (substring(text FROM text)) and silently return NULL.
  const from = oldPath.length + 1;
  // $3 is the LIKE prefix with %/_ escaped so a folder path containing SQL
  // wildcards cannot match (and rewrite) unrelated notes/folders. The substring
  // offset ($4) is the true prefix length, unaffected by escaping.
  const prefix = likeEscape(oldPath);
  await db.query(
    `UPDATE folders
        SET path = $2 || substring(path FROM $4::int)
      WHERE vault_id = $1 AND path LIKE $3 || '/%' ESCAPE '\\'`,
    [vaultId, newPath, prefix, from],
  );
  await db.query(
    `UPDATE notes
        SET rel_path = $2 || substring(rel_path FROM $4::int), updated_at = now()
      WHERE vault_id = $1 AND rel_path LIKE $3 || '/%' ESCAPE '\\'`,
    [vaultId, newPath, prefix, from],
  );
}

export interface FolderRow {
  id: string;
  vault_id: string;
  path: string;
  parent_id: string | null;
}

/** Load a folder's identity columns, or null if it doesn't exist. */
export async function findFolder(db: Queryable, folderId: string): Promise<FolderRow | null> {
  const { rows } = await db.query<FolderRow>(
    "SELECT id, vault_id, path, parent_id FROM folders WHERE id = $1",
    [folderId],
  );
  return rows[0] ?? null;
}

/**
 * Would making `candidateParentId` the parent of `folderId` create a cycle?
 *
 * Every ACL query in the codebase walks `parent_id` with
 * `WITH RECURSIVE … UNION ALL`, which does not dedupe — so a cycle makes those
 * walks run forever. One unguarded re-parent (a folder moved under its own
 * descendant) would therefore wedge every permission check touching that
 * subtree, indefinitely, for everyone.
 *
 * `UNION` (not `UNION ALL`) below on purpose: this guard has to terminate even
 * when run against a tree that is ALREADY corrupt.
 */
async function wouldCycle(
  db: Queryable,
  folderId: string,
  candidateParentId: string,
): Promise<boolean> {
  if (candidateParentId === folderId) return true;
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE descendants AS (
        SELECT id FROM folders WHERE parent_id = $1
        UNION
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
     )
     SELECT id FROM descendants WHERE id = $2 LIMIT 1`,
    [folderId, candidateParentId],
  );
  return rows.length > 0;
}

export interface MoveFolderInput {
  /** `undefined` leaves it unchanged; a string sets it. */
  path?: string;
  name?: string;
  /** `undefined` leaves it unchanged; `null` moves it to the vault root. */
  parentId?: string | null;
}

/**
 * Where a folder ends up after `input`, with `path` and `parentId` agreeing:
 *  - `path` given → it is authoritative; a `parentId`, when also given, must be
 *    the folder at `dirname(path)`, else the parent is resolved from the path.
 *  - only `parentId` given → the folder keeps its name and follows the parent
 *    (`null` = the vault root).
 *  - neither → unchanged.
 */
export async function planFolderMove(
  db: Queryable,
  folder: FolderRow,
  input: MoveFolderInput,
): Promise<{ path: string; parentId: string | null }> {
  if (input.path !== undefined) {
    // `relPath` from the resolver, not `input.path`: it carries the parent's own
    // spelling, so the subtree keeps one consistent prefix.
    const resolved = await resolveFolderParent(db, folder.vault_id, input.path, input.parentId);
    return { path: resolved.relPath, parentId: resolved.folderId };
  }
  if (input.parentId !== undefined) {
    const name = input.name ?? basename(folder.path);
    if (input.parentId === null) return { path: name, parentId: null };
    const parent = await findFolder(db, input.parentId);
    if (!parent) throw new TreeOpError("Unknown destination folder");
    // A cross-vault parent would put a folder in one vault under a tree in
    // another, so the subtree's paths and its ACL would resolve in different
    // collections.
    if (parent.vault_id !== folder.vault_id) {
      throw new TreeOpError("Destination folder is in a different vault");
    }
    return { path: `${parent.path}/${name}`, parentId: parent.id };
  }
  if (input.name !== undefined && input.name !== basename(folder.path)) {
    // A rename in place: same parent, new last segment.
    const dir = dirname(folder.path);
    return { path: dir ? `${dir}/${input.name}` : input.name, parentId: folder.parent_id };
  }
  return { path: folder.path, parentId: folder.parent_id };
}

/**
 * Rename and/or move a folder, rewriting every descendant path in place. Ids are
 * never touched, so open CRDT docs and backlinks survive the move (the spec
 * invariant: key by doc_id, never by path).
 */
export async function moveFolder(
  db: Queryable,
  folderId: string,
  input: MoveFolderInput,
): Promise<{ id: string; vaultId: string; name: string; path: string }> {
  const folder = await findFolder(db, folderId);
  if (!folder) throw new TreeOpError("Unknown folder");

  const oldPath = folder.path;
  const plan = await planFolderMove(db, folder, input);
  const newPath = plan.path;
  const newName = input.name ?? basename(newPath);
  // Always written: `path` and `parent_id` are resolved together (see
  // `planFolderMove`), so re-parenting by path alone lands on the right parent.
  const newParentId: string | null = plan.parentId;

  if (newParentId != null && newParentId !== folder.parent_id) {
    if (await wouldCycle(db, folderId, newParentId)) {
      throw new TreeOpError("Cannot move a folder inside itself");
    }
  }

  // `samePath`, not `!==`: a pure case change of the folder's own name (`docs` →
  // `Docs`) is a legal rename, but landing on a DIFFERENT folder that already
  // holds this path up to case would fork the subtree across two rows that are
  // one directory on disk. Surfaced as a refusal so the caller sees why, rather
  // than as a bare 23505 from `folders_vault_path_ci_uq` (migration 023).
  if (!samePath(newPath, oldPath)) {
    const clash = await db.query(
      "SELECT 1 FROM folders WHERE vault_id = $1 AND lower(path) = lower($2) AND id <> $3 LIMIT 1",
      [folder.vault_id, newPath, folderId],
    );
    if ((clash.rowCount ?? 0) > 0) {
      throw new TreeOpError("A folder already exists at that path");
    }
  }

  await db.query(
    "UPDATE folders SET path = $1, name = $2, parent_id = $4 WHERE id = $3",
    [newPath, newName, folderId, newParentId],
  );
  if (newPath !== oldPath) {
    await rewriteDescendantPaths(db, folder.vault_id, oldPath, newPath);
  }
  return { id: folderId, vaultId: folder.vault_id, name: newName, path: newPath };
}

export interface NoteRow {
  id: string;
  vault_id: string;
  rel_path: string;
  title: string | null;
  folder_id: string | null;
}

/** Load a live (non-deleted) note's identity columns, or null. */
export async function findNote(db: Queryable, docId: string): Promise<NoteRow | null> {
  const { rows } = await db.query<NoteRow>(
    `SELECT id, vault_id, rel_path, title, folder_id
       FROM notes WHERE id = $1 AND deleted_at IS NULL`,
    [docId],
  );
  return rows[0] ?? null;
}

export interface MoveNoteInput {
  /** `undefined` leaves it unchanged. */
  relPath?: string;
  title?: string | null;
  /** `undefined` leaves it unchanged; `null` moves it to the vault root. */
  folderId?: string | null;
}

/**
 * Where a note ends up after `input`, with `rel_path` and `folder_id` agreeing
 * (see {@link resolveParentFolder} for why that is not optional):
 *  - `relPath` given → authoritative; `folderId`, when also given, must be the
 *    folder at `dirname(relPath)`, else the parent is resolved from the path.
 *  - only `folderId` given → the note keeps its filename and follows the folder
 *    (`null` = the vault root).
 *  - neither → unchanged.
 * Callers gate the root-freeze latch and destination permissions on the
 * RESOLVED parent, which is why this is exported separately from the write.
 */
export async function planNoteMove(
  db: Queryable,
  note: NoteRow,
  input: MoveNoteInput,
): Promise<{ relPath: string; folderId: string | null }> {
  if (input.relPath !== undefined) {
    const resolved = await resolveParentFolder(db, note.vault_id, input.relPath, input.folderId);
    return { relPath: resolved.relPath, folderId: resolved.folderId };
  }
  if (input.folderId !== undefined) {
    const name = basename(note.rel_path);
    if (input.folderId === null) return { relPath: name, folderId: null };
    const parent = await findFolder(db, input.folderId);
    if (!parent) throw new TreeOpError("Unknown destination folder");
    if (parent.vault_id !== note.vault_id) {
      throw new TreeOpError("Destination folder is in a different vault");
    }
    return { relPath: `${parent.path}/${name}`, folderId: parent.id };
  }
  return { relPath: note.rel_path, folderId: note.folder_id };
}

/** Rename, retitle, and/or move a single note. Its doc_id never changes. */
export async function moveNote(
  db: Queryable,
  docId: string,
  input: MoveNoteInput,
): Promise<{ id: string; vaultId: string; relPath: string; title: string | null; folderId: string | null }> {
  const note = await findNote(db, docId);
  if (!note) throw new TreeOpError("Unknown note");

  const title = input.title === undefined ? note.title : input.title;
  const { relPath, folderId } = await planNoteMove(db, note, input);

  // Compared up to case (see the folder twin above): renaming `notes.md` →
  // `Notes.md` is legal, but moving onto a path another live note already holds
  // case-insensitively is the fork that the 2026-09-04 runaway was made of.
  if (!samePath(relPath, note.rel_path)) {
    // Surface the collision as a refusal rather than letting the partial unique
    // indexes (`notes_live_path_uq` m021, `notes_live_path_ci_uq` m023) throw a
    // bare 23505.
    const clash = await db.query(
      "SELECT 1 FROM notes WHERE vault_id = $1 AND lower(rel_path) = lower($2) AND deleted_at IS NULL AND id <> $3 LIMIT 1",
      [note.vault_id, relPath, docId],
    );
    if ((clash.rowCount ?? 0) > 0) throw new TreeOpError("A note already exists at that path");
  }

  await db.query(
    "UPDATE notes SET rel_path = $1, title = $2, folder_id = $3, updated_at = now() WHERE id = $4",
    [relPath, title, folderId, docId],
  );
  return { id: docId, vaultId: note.vault_id, relPath, title, folderId };
}

/** Does this folder directly contain any live note or subfolder? */
export async function folderIsEmpty(db: Queryable, folderId: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (
        (SELECT count(*) FROM notes WHERE folder_id = $1 AND deleted_at IS NULL)
      + (SELECT count(*) FROM folders WHERE parent_id = $1)
     )::text AS n`,
    [folderId],
  );
  return rows[0]?.n === "0";
}

/**
 * Delete a folder subtree: soft-delete its notes (they keep their doc_id, so a
 * teammate with one open loses tree visibility rather than their content), then
 * remove the folder rows (`ON DELETE CASCADE` clears descendant folders).
 *
 * Returns the soft-deleted note ids so the caller can purge their derived index
 * rows and kick any live editors. Those side effects stay at the call site
 * because they differ per caller (only MCP disconnected sockets before this).
 *
 * The cascade matches on **both** `folder_id` and the path prefix. They can
 * disagree: `moveNote` lets `relPath` and `folderId` be set independently, so a
 * note can sit under this folder by one measure and not the other. Matching only
 * one would leave a note behind whose folder no longer exists.
 */
export async function deleteFolderCascade(
  db: Queryable,
  folderId: string,
): Promise<{ vaultId: string; path: string; deletedNoteIds: string[] }> {
  const folder = await findFolder(db, folderId);
  if (!folder) throw new TreeOpError("Unknown folder");

  // $2 is an exact path match; $3 is the LIKE prefix with %/_ escaped so a folder
  // path containing wildcards cannot widen the soft-delete beyond its subtree.
  // RETURNING id gives us exactly the cascade's victims.
  const { rows: cascaded } = await db.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
        SELECT id FROM folders WHERE id = $1
        UNION
        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
     )
     UPDATE notes SET deleted_at = now()
      WHERE vault_id = $4 AND deleted_at IS NULL
        AND (
          folder_id IN (SELECT id FROM subtree)
          OR rel_path = $2
          OR rel_path LIKE $3 || '/%' ESCAPE '\\'
        )
      RETURNING id`,
    [folderId, folder.path, likeEscape(folder.path), folder.vault_id],
  );
  // Tombstone EVERY folder in the subtree before the cascade removes the rows.
  // Notes soft-delete and therefore announce their own deletion; folders were
  // erased without a trace, so any device still holding one locally
  // re-registered it on its next pull — the "deleted folder keeps coming back"
  // bug. Keyed by folder id (what clients persist), so an id match proves the
  // local folder is THIS deleted one and not a same-named successor.
  await db.query(
    `WITH RECURSIVE subtree AS (
        SELECT id, vault_id, path FROM folders WHERE id = $1
        UNION
        SELECT f.id, f.vault_id, f.path FROM folders f JOIN subtree s ON f.parent_id = s.id
     )
     INSERT INTO folder_tombstones (id, vault_id, path)
     SELECT id, vault_id, path FROM subtree
     ON CONFLICT (id) DO NOTHING`,
    [folderId],
  );
  await db.query("DELETE FROM folders WHERE id = $1", [folderId]);
  return {
    vaultId: folder.vault_id,
    path: folder.path,
    deletedNoteIds: cascaded.map((n) => n.id),
  };
}
