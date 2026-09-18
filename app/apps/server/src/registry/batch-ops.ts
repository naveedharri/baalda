import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { canCreateIn, canEditDoc } from "../permissions/http-gates.js";
import {
  TreeOpError,
  resolveFolderParent,
  resolveParentFolder,
  samePath,
} from "./tree-ops.js";

/**
 * Registration of ONE structural row — the shared body of `POST /api/folders`,
 * `POST /api/notes`, `POST /api/files` and their `/batch` twins.
 *
 * This file exists because those two surfaces must not drift. The single-item
 * routes carry a decade of incident scar tissue in a very particular ORDER —
 * adopt-by-path first (case-insensitively, echoing the row's canonical
 * spelling), then resolve the parent from the path, then the write gate, then
 * the frozen-root latch, then an `ON CONFLICT DO NOTHING RETURNING` insert whose
 * empty result is discriminated into "already yours" vs "belongs to another
 * vault", then a 23505 fallback that adopts the winner of a same-path race.
 * Re-deriving that sequence for a batch endpoint would not be a refactor, it
 * would be a second implementation of the 2026-08-25 and 2026-09-04 runaways.
 *
 * So the rule is: the routes decide *HTTP* (status codes, bodies, broadcasts)
 * and nothing else; everything that decides what lands in Postgres is here.
 *
 * Authorization DOES live here, unlike `tree-ops.ts`. The gates are part of the
 * sequence — `canCreateIn` runs after the adopt path and before the latch, and
 * moving it out would let a batch route get the order subtly wrong — and both
 * callers gate identically, which is exactly the condition `tree-ops` fails.
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * Is this vault's ROOT closed to new folders/notes?
 *
 * "Freeze root" is a structural latch, not a permission: once a team has agreed
 * the top-level shape, nothing new lands beside it — by anyone, owners and
 * admins included. Making it role-scoped would defeat the point, because the
 * accidental root folder is nearly always created by someone who *does* have
 * permission. An owner/admin lifts the latch first, then creates.
 *
 * Only the root is affected. Everything nested keeps its normal ACL.
 *
 * Lives here rather than in `http/routes/registry.ts` (which re-exports it for
 * its existing importers) so `batch-ops` does not import a route module.
 */
export async function isRootFrozen(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  const { rows } = await db.query<{ root_frozen: boolean }>(
    "SELECT root_frozen FROM vaults WHERE id = $1",
    [vaultId],
  );
  return rows[0]?.root_frozen === true;
}

/** Colors are a short id from the client's palette (`lib/appearance`), or null
 *  to clear. Anything else is ignored rather than stored. */
export function normalizeColor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 32) return undefined;
  return value;
}

/** Why a registration was refused. Mirrors `BulkErrorCode`'s registration half. */
export type RegisterCode =
  | "path_folder_mismatch"
  | "no_write_access"
  | "root_frozen"
  | "doc_id_conflict";

export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  color: string | null;
}

export interface NoteRow {
  id: string;
  folderId: string | null;
  title: string | null;
  relPath: string;
}

export interface FileRow {
  id: string;
  folderId: string | null;
  path: string;
}

/**
 * The result of registering one row.
 *
 * `created` vs `adopted` is the ONLY thing separating a 201 from a 200 on the
 * single-item routes, and it is also what tells a batch caller whether a
 * `registry` broadcast is owed — so it is reported rather than inferred from
 * whether the echoed path matches what was asked for.
 */
export type RegisterResult<Row> =
  /** `wrote` = this call changed the vault's STRUCTURE, so a `registry`
   *  broadcast is owed. True for every create, and for the one adopt that is
   *  really a move (a `files` row whose id turned up at another path). False for
   *  the ordinary adopts, which is why a repeat reconcile is silent. */
  | { status: "created"; row: Row; wrote: true }
  | { status: "adopted"; row: Row; wrote: boolean }
  | { status: "conflict"; code: "doc_id_conflict"; message: string; id: string }
  | { status: "error"; code: Exclude<RegisterCode, "doc_id_conflict">; message: string };

/** A registration that cannot collide on id across vaults. Folders have no
 *  doc_id namespace at all, and a `files` id that turns up elsewhere in THIS
 *  vault is a move, not a conflict — so neither route can answer `conflict`, and
 *  saying so in the type keeps the callers from writing a dead branch. */
export type StructResult<Row> = Exclude<RegisterResult<Row>, { status: "conflict" }>;

/**
 * Per-REQUEST memo for the two lookups every item in a batch repeats.
 *
 * Both answers are properties of the vault (or of one folder), not of the item,
 * and a 200-note batch would otherwise ask Postgres the same question 200 times.
 * Scoped to one request deliberately: a longer-lived cache would keep serving a
 * lifted frozen-root latch, or a just-granted share, for as long as it lived.
 *
 * A single-item route builds one of these too, so the two paths run the exact
 * same code with a cache of size one.
 */
export interface RegisterCtx {
  db: Queryable;
  vaultId: string;
  userId: string;
  rootFrozen(): Promise<boolean>;
  canCreateIn(folderId: string | null): Promise<boolean>;
}

export function registerCtx(vaultId: string, userId: string, db: Queryable = defaultPool): RegisterCtx {
  let frozen: Promise<boolean> | null = null;
  const creates = new Map<string, Promise<boolean>>();
  return {
    db,
    vaultId,
    userId,
    rootFrozen() {
      frozen ??= isRootFrozen(vaultId, db);
      return frozen;
    },
    canCreateIn(folderId) {
      const key = folderId ?? "";
      let hit = creates.get(key);
      if (!hit) {
        hit = canCreateIn(userId, vaultId, folderId, db);
        creates.set(key, hit);
      }
      return hit;
    },
  };
}

// ── folders ────────────────────────────────────────────────────────────────

const FOLDER_COLS = "id, parent_id, name, path, color";

function toFolder(r: {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  color: string | null;
}): FolderRow {
  return { id: r.id, parentId: r.parent_id, name: r.name, path: r.path, color: r.color };
}

async function folderByPath(ctx: RegisterCtx, path: string): Promise<FolderRow | null> {
  // Ordered by age so a pre-index duplicate pair resolves to the SAME winner on
  // every device, not to whichever row the planner returned first.
  const { rows } = await ctx.db.query<{
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
    color: string | null;
  }>(
    `SELECT ${FOLDER_COLS} FROM folders
      WHERE vault_id = $1 AND lower(path) = lower($2)
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [ctx.vaultId, path],
  );
  return rows[0] ? toFolder(rows[0]) : null;
}

export interface FolderInput {
  path: string;
  name: string;
  parentId?: string | null;
  color?: unknown;
  sort?: number;
}

export async function registerFolder(
  ctx: RegisterCtx,
  input: FolderInput,
): Promise<StructResult<FolderRow>> {
  // A given path maps to one folder per vault — adopt an existing row rather
  // than duplicating it (reconcile and on-demand create can race). Matched
  // case-insensitively and echoed CANONICAL: a Mac and a Windows box see one
  // directory where Postgres would store two rows, and the desktop that then
  // maps its file to the twin's doc_id is the 2026-09-04 ping-pong.
  const existing = await folderByPath(ctx, input.path);
  if (existing) return { status: "adopted", row: existing, wrote: false };

  // `path` is authoritative; `parentId` must be the folder at its dirname (or is
  // resolved from it when absent). `storedPath` is `path` rewritten onto the
  // parent's own spelling, so a subtree never mixes cases across levels.
  let resolvedParent: string | null;
  let storedPath: string;
  try {
    const loc = await resolveFolderParent(ctx.db, ctx.vaultId, input.path, input.parentId ?? null);
    resolvedParent = loc.folderId;
    storedPath = loc.relPath;
  } catch (err) {
    if (err instanceof TreeOpError) {
      return { status: "error", code: "path_folder_mismatch", message: err.message };
    }
    throw err;
  }

  // Write permission on the RESOLVED parent, not bare membership: a lock, a
  // `view` grant or the vault-wide Read-only posture has to stop new folders
  // landing. After the adopt path, so re-registering keeps working.
  if (!(await ctx.canCreateIn(resolvedParent))) {
    return {
      status: "error",
      code: "no_write_access",
      message: "You do not have permission to create a folder here.",
    };
  }

  // Frozen root: only NEW root folders are refused, judged on the RESOLVED
  // parent so a nested path with no parentId is not mistaken for a root create.
  if (resolvedParent === null && (await ctx.rootFrozen())) {
    return {
      status: "error",
      code: "root_frozen",
      message: "This vault's root is frozen — create this inside a folder instead.",
    };
  }

  const id = randomUUID();
  const color = normalizeColor(input.color) ?? null;
  try {
    await ctx.db.query(
      `INSERT INTO folders (id, vault_id, parent_id, name, path, sort, created_by, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.vaultId, resolvedParent, input.name, storedPath, input.sort ?? 0, ctx.userId, color],
    );
  } catch (err) {
    // Lost the race against another device registering the same path
    // (`folders_vault_path_uq` m022 / `folders_vault_path_ci_uq` m023). Adopt
    // the winner — before those indexes this race produced 2–5 rows per path
    // and split a folder's notes across them.
    if ((err as { code?: string }).code === "23505") {
      const winner = await folderByPath(ctx, storedPath);
      if (winner) return { status: "adopted", row: winner, wrote: false };
    }
    throw err;
  }
  return {
    status: "created",
    wrote: true,
    row: { id, parentId: resolvedParent, name: input.name, path: storedPath, color },
  };
}

// ── notes ──────────────────────────────────────────────────────────────────

function toNote(r: {
  id: string;
  folder_id: string | null;
  title: string | null;
  rel_path: string;
}): NoteRow {
  return { id: r.id, folderId: r.folder_id, title: r.title, relPath: r.rel_path };
}

async function liveNoteByPath(ctx: RegisterCtx, relPath: string): Promise<NoteRow | null> {
  const { rows } = await ctx.db.query<{
    id: string;
    folder_id: string | null;
    title: string | null;
    rel_path: string;
  }>(
    `SELECT id, folder_id, title, rel_path FROM notes
      WHERE vault_id = $1 AND lower(rel_path) = lower($2) AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [ctx.vaultId, relPath],
  );
  return rows[0] ? toNote(rows[0]) : null;
}

export interface NoteInput {
  relPath: string;
  docId?: string;
  folderId?: string | null;
  title?: string | null;
  color?: unknown;
}

export async function registerNote(
  ctx: RegisterCtx,
  input: NoteInput,
): Promise<RegisterResult<NoteRow>> {
  // Client may supply a stable doc_id (generated locally); else we mint one.
  const id = typeof input.docId === "string" && input.docId ? input.docId : randomUUID();

  // A live note already at this path IS this note — return it so the caller
  // adopts its doc_id. Registering the same path under a DIFFERENT id used to
  // create a second live row, forking the note's identity: two devices then map
  // one file to two docs, and every external write bounces between them,
  // duplicating the content each cycle (2026-08-25 runaway daily notes).
  // Case-insensitive, because a case-variant of a live path is the SAME FILE on
  // macOS and Windows (2026-09-04 BenAI OS runaway) — `notes_live_path_uq` (m021)
  // could not see that: a case-only difference satisfies an exact-path index.
  const byPath = await liveNoteByPath(ctx, input.relPath);
  if (byPath) return { status: "adopted", row: byPath, wrote: false };

  // `relPath` is authoritative; `folderId` must be the folder at its dirname (or
  // is resolved from it). A desktop whose folder map missed a parent otherwise
  // writes a row every client renders in one place and every ACL walk reads in
  // another (2026-08-27 phantom-root-folder).
  let resolvedFolder: string | null;
  let storedRelPath: string;
  try {
    const loc = await resolveParentFolder(ctx.db, ctx.vaultId, input.relPath, input.folderId ?? null);
    resolvedFolder = loc.folderId;
    storedRelPath = loc.relPath;
  } catch (err) {
    if (err instanceof TreeOpError) {
      return { status: "error", code: "path_folder_mismatch", message: err.message };
    }
    throw err;
  }

  // Write permission on the RESOLVED folder, not bare membership — the same gate
  // MCP's `create_note` applies. Without it a user who is read-only on every
  // note in a folder could still fill it with new ones.
  if (!(await ctx.canCreateIn(resolvedFolder))) {
    return {
      status: "error",
      code: "no_write_access",
      message: "You do not have permission to create a note here.",
    };
  }

  // Frozen root: refuse only notes that do not exist yet. Re-registering a root
  // note that predates the latch (a second device, a repeat reconcile) has to
  // keep working, or freezing the root would break sync for the very notes the
  // team froze it to protect.
  if (resolvedFolder === null && (await ctx.rootFrozen())) {
    const { rowCount } = await ctx.db.query("SELECT 1 FROM notes WHERE id = $1", [id]);
    if (!rowCount) {
      return {
        status: "error",
        code: "root_frozen",
        message: "This vault's root is frozen — create this inside a folder instead.",
      };
    }
  }

  // RETURNING tells us whether the row is actually ours. `DO NOTHING` alone is
  // silent about *why* nothing happened, and answering "created" regardless told
  // the client "doc `id` now belongs to `vaultId`" even when that id was already
  // a note in a DIFFERENT vault — after which /api/sync-token 403s forever.
  let inserted;
  try {
    inserted = await ctx.db.query(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by, color)
       VALUES ($1, $2, $3, $4, $5, $1, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        id,
        ctx.vaultId,
        resolvedFolder,
        input.title ?? null,
        storedRelPath,
        ctx.userId,
        normalizeColor(input.color) ?? null,
      ],
    );
  } catch (err) {
    // Lost the race against a concurrent register of the same path
    // (`notes_live_path_uq` m021, or `notes_live_path_ci_uq` m023 for a
    // case-variant). The winner's row is this note — adopt it, canonical and all.
    if ((err as { code?: string }).code === "23505") {
      const winner = await liveNoteByPath(ctx, storedRelPath);
      if (winner) return { status: "adopted", row: winner, wrote: false };
    }
    throw err;
  }

  if (inserted.rowCount === 0) {
    const { rows: existing } = await ctx.db.query<{
      vault_id: string;
      rel_path: string;
      folder_id: string | null;
      title: string | null;
    }>("SELECT vault_id, rel_path, folder_id, title FROM notes WHERE id = $1", [id]);
    const row = existing[0];
    if (row && row.vault_id !== ctx.vaultId) {
      return {
        status: "conflict",
        code: "doc_id_conflict",
        message: "doc_id already belongs to another vault",
        id,
      };
    }
    // Re-registering the same note in the same vault is the ordinary adopt path
    // — still a success. But `DO NOTHING` wrote nothing, so answering with the
    // REQUESTED path told the client "this note now lives at `relPath`" about a
    // move that never happened; it then mapped its file to a path the server
    // disagrees with and re-sent it on every reconcile. Echo the row's canonical
    // path/folder instead. Moving a note is `PATCH /api/notes/:id`.
    if (row && row.rel_path !== storedRelPath) {
      return {
        status: "adopted",
        wrote: false,
        row: { id, folderId: row.folder_id, title: row.title, relPath: row.rel_path },
      };
    }
  }

  return {
    status: "created",
    wrote: true,
    row: { id, folderId: resolvedFolder, title: input.title ?? null, relPath: storedRelPath },
  };
}

// ── files (tree binaries) ──────────────────────────────────────────────────

async function fileByPath(ctx: RegisterCtx, path: string): Promise<FileRow | null> {
  const { rows } = await ctx.db.query<{ id: string; folder_id: string | null; path: string }>(
    "SELECT id, folder_id, path FROM files WHERE vault_id = $1 AND lower(path) = lower($2) LIMIT 1",
    [ctx.vaultId, path],
  );
  const r = rows[0];
  return r ? { id: r.id, folderId: r.folder_id, path: r.path } : null;
}

export interface FileInput {
  path: string;
  docId?: string;
  folderId?: string | null;
}

export async function registerFile(
  ctx: RegisterCtx,
  input: FileInput,
): Promise<StructResult<FileRow>> {
  const id = typeof input.docId === "string" && input.docId ? input.docId : randomUUID();

  // A file already at this path IS this file. First, before anything else:
  // re-registration is the NORMAL case (every device registers every binary it
  // holds on every pass), it lets a second device adopt the incumbent's id
  // rather than earning a bare 23505 from `files_vault_path_ci_uq` (m023), and
  // it runs before `resolveParentFolder` — which THROWS for a folder this server
  // does not know yet, so a device one pass behind on folders would otherwise be
  // told `path_folder_mismatch` about a file that is already registered.
  const byPath = await fileByPath(ctx, input.path);
  if (byPath) return { status: "adopted", row: byPath, wrote: false };

  let resolvedFolder: string | null;
  let storedPath: string;
  try {
    const loc = await resolveParentFolder(ctx.db, ctx.vaultId, input.path, input.folderId ?? null);
    resolvedFolder = loc.folderId;
    storedPath = loc.relPath;
  } catch (err) {
    if (err instanceof TreeOpError) {
      return { status: "error", code: "path_folder_mismatch", message: err.message };
    }
    throw err;
  }

  // Resolution can normalise the path (a `folderId` whose folder is spelled
  // differently), so ask once more for the canonical form. Same adoption.
  if (!samePath(storedPath, input.path)) {
    const canonical = await fileByPath(ctx, storedPath);
    if (canonical) return { status: "adopted", row: canonical, wrote: false };
  }

  // This id exists but not at this path: the file was renamed or moved on disk.
  // It is a MOVE, never a second row — `doc_id` is identity.
  const { rows: byId } = await ctx.db.query<{ path: string }>(
    "SELECT path FROM files WHERE id = $1 AND vault_id = $2",
    [id, ctx.vaultId],
  );

  // Same create gate as notes and folders; a `files` row is a syncable doc like
  // any other. The check is on the DESTINATION folder either way; a move
  // additionally needs edit on the file itself, since moving it is a write.
  if (!(await ctx.canCreateIn(resolvedFolder))) {
    return {
      status: "error",
      code: "no_write_access",
      message: "You do not have permission to create a file here.",
    };
  }

  if (byId[0]) {
    if (!(await canEditDoc(ctx.userId, id, ctx.db))) {
      return {
        status: "error",
        code: "no_write_access",
        message: "You do not have permission to create a file here.",
      };
    }
    await ctx.db.query("UPDATE files SET folder_id = $2, path = $3 WHERE id = $1", [
      id,
      resolvedFolder,
      storedPath,
    ]);
    // A MOVE: the row changed, so this adopt does owe a broadcast.
    return { status: "adopted", wrote: true, row: { id, folderId: resolvedFolder, path: storedPath } };
  }

  // Frozen root: same rule as notes — refuse only files that do not exist yet
  // (an existing one was answered by the adoption branch above).
  if (resolvedFolder === null && (await ctx.rootFrozen())) {
    return {
      status: "error",
      code: "root_frozen",
      message: "This vault's root is frozen — create this inside a folder instead.",
    };
  }

  await ctx.db.query(
    "INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    [id, ctx.vaultId, resolvedFolder, storedPath],
  );
  return { status: "created", wrote: true, row: { id, folderId: resolvedFolder, path: storedPath } };
}

/**
 * Depth of a vault-relative path, for ordering a folder batch.
 *
 * The server sorts the batch by this and resolves each parent in-request, which
 * is what deletes the client's level-by-level `runPool` loop: the caller sends
 * every folder it has in one request, in any order, and `a/b/c` still finds
 * `a/b` because `a/b` was inserted three items earlier in the same pass.
 */
export function pathDepth(path: string): number {
  let n = 1;
  for (let i = 0; i < path.length; i++) if (path[i] === "/") n++;
  return n;
}
