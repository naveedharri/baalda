import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { canCreateIn, canEditDoc } from "../permissions/http-gates.js";
import { createResolverCache, type ResolverCache } from "../permissions/resolver.js";
import {
  TreeOpError,
  dirname,
  resolveFolderParent,
  resolveParentFolder,
  samePath,
  type FolderByPath,
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
  /**
   * The request's permission memo, shared with `canCreateIn`.
   *
   * `canCreateIn` is already memoised per FOLDER, which is what makes 200 notes
   * in one folder pay for it once. A 5,000-note vault spans ~300 folders and
   * paid ~7 queries for each — and 4 of those 7 (the member role, the vault
   * baseline, a folder's ancestor chain) are facts the whole request shares.
   * Memoising the resolver's inputs is the *only* thing this changes; the
   * per-folder verdict is still `canCreateIn`'s, computed the same way.
   */
  resolverCache: ResolverCache;
  /** Per-request path→row caches. See {@link RegisterCache}. */
  cache: RegisterCache;
}

/**
 * Per-request path→row lookup caches, written through by every insert.
 *
 * A registration batch asks the same three questions per item — "is there
 * already a note/file/folder at this path?" — and a 200-note batch asked
 * Postgres 200 times, serially, on ONE checked-out connection. The batch routes
 * PREFILL these with a single `lower(path) = ANY($1)` read per kind; every
 * lookup below then consults the map first and falls back to the single-row
 * query on a miss, so a single-item route behaves exactly as it always did with
 * a cache of size one.
 *
 * Two rules keep this honest:
 *  · an entry is WRITTEN THROUGH on every insert/adopt/move, so `a/b/c` finds
 *    the `a/b` its own batch created three items earlier — the same in-request
 *    ordering the folder route's depth sort already relied on;
 *  · the 23505 race fallbacks read PAST the cache (`fresh`), because the whole
 *    point there is that another connection won and the cache cannot know it.
 */
export interface RegisterCache {
  folders: Map<string, FolderRow | null>;
  notes: Map<string, NoteRow | null>;
  files: Map<string, FileRow | null>;
}

export function createRegisterCache(): RegisterCache {
  return { folders: new Map(), notes: new Map(), files: new Map() };
}

/** Cache key: paths are matched case-insensitively everywhere (m023's
 *  `lower(path)` unique indexes), so the key has to be too. */
function pathKey(path: string): string {
  return path.toLowerCase();
}

export function registerCtx(
  vaultId: string,
  userId: string,
  db: Queryable = defaultPool,
  opts: { resolverCache?: ResolverCache; cache?: RegisterCache } = {},
): RegisterCtx {
  let frozen: Promise<boolean> | null = null;
  const creates = new Map<string, Promise<boolean>>();
  const resolverCache = opts.resolverCache ?? createResolverCache();
  const cache = opts.cache ?? createRegisterCache();
  return {
    db,
    vaultId,
    userId,
    resolverCache,
    cache,
    rootFrozen() {
      frozen ??= isRootFrozen(vaultId, db);
      return frozen;
    },
    canCreateIn(folderId) {
      const key = folderId ?? "";
      let hit = creates.get(key);
      if (!hit) {
        hit = canCreateIn(userId, vaultId, folderId, db, resolverCache);
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

async function folderByPath(
  ctx: RegisterCtx,
  path: string,
  /** Read past the cache. Only the 23505 race fallback wants this: the whole
   *  point there is that another connection won and the cache cannot know it. */
  fresh = false,
): Promise<FolderRow | null> {
  const key = pathKey(path);
  if (!fresh) {
    const hit = ctx.cache.folders.get(key);
    if (hit !== undefined) return hit;
  }
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
  const row = rows[0] ? toFolder(rows[0]) : null;
  ctx.cache.folders.set(key, row);
  return row;
}

/**
 * Prefill the folder cache for every path in `paths` (and, for a note/file
 * batch, every parent DIRECTORY it names) with ONE `lower(path) = ANY($1)`
 * read.
 *
 * A miss is cached as `null` too — that is the whole saving, since "no folder at
 * this path" is the answer for every parent a folder batch is about to create.
 * It stays correct because every create writes through (see `registerFolder`).
 */
export async function prefetchFolders(ctx: RegisterCtx, paths: string[]): Promise<void> {
  const wanted = [...new Set(paths.filter((p) => p !== "").map(pathKey))].filter(
    (k) => !ctx.cache.folders.has(k),
  );
  if (wanted.length === 0) return;
  const { rows } = await ctx.db.query<{
    id: string;
    parent_id: string | null;
    name: string;
    path: string;
    color: string | null;
  }>(
    `SELECT DISTINCT ON (lower(path)) ${FOLDER_COLS} FROM folders
      WHERE vault_id = $1 AND lower(path) = ANY($2::text[])
      ORDER BY lower(path), created_at ASC, id ASC`,
    [ctx.vaultId, wanted],
  );
  for (const k of wanted) ctx.cache.folders.set(k, null);
  for (const r of rows) ctx.cache.folders.set(pathKey(r.path), toFolder(r));
}

/** {@link FolderByPath} backed by the request cache, for `resolveParentFolder`
 *  / `resolveFolderParent`. Shape-adapts to `tree-ops`' FolderRow; `vault_id` is
 *  the ctx's by construction (every cached row was read `WHERE vault_id = $1`). */
function cachedFolderLookup(ctx: RegisterCtx): FolderByPath {
  return async (_db, _vaultId, path) => {
    const row = await folderByPath(ctx, path);
    return row
      ? { id: row.id, vault_id: ctx.vaultId, path: row.path, parent_id: row.parentId }
      : null;
  };
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
    const loc = await resolveFolderParent(
      ctx.db,
      ctx.vaultId,
      input.path,
      input.parentId ?? null,
      cachedFolderLookup(ctx),
    );
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
      const winner = await folderByPath(ctx, storedPath, true);
      if (winner) return { status: "adopted", row: winner, wrote: false };
    }
    throw err;
  }
  const row = { id, parentId: resolvedParent, name: input.name, path: storedPath, color };
  // Write through: the next item in this very batch resolves `a/b/c` against
  // the `a/b` we just inserted, which is what the depth sort assumes.
  ctx.cache.folders.set(pathKey(storedPath), row);
  return { status: "created", wrote: true, row };
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

async function liveNoteByPath(
  ctx: RegisterCtx,
  relPath: string,
  fresh = false,
): Promise<NoteRow | null> {
  const key = pathKey(relPath);
  if (!fresh) {
    const hit = ctx.cache.notes.get(key);
    if (hit !== undefined) return hit;
  }
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
  const row = rows[0] ? toNote(rows[0]) : null;
  ctx.cache.notes.set(key, row);
  return row;
}

/** One `lower(rel_path) = ANY($1)` read for a whole note batch's adopt probes,
 *  plus one for the parent folders their paths name. See {@link RegisterCache}. */
export async function prefetchNotes(ctx: RegisterCtx, relPaths: string[]): Promise<void> {
  const wanted = [...new Set(relPaths.filter((p) => p !== "").map(pathKey))].filter(
    (k) => !ctx.cache.notes.has(k),
  );
  if (wanted.length > 0) {
    const { rows } = await ctx.db.query<{
      id: string;
      folder_id: string | null;
      title: string | null;
      rel_path: string;
    }>(
      `SELECT DISTINCT ON (lower(rel_path)) id, folder_id, title, rel_path FROM notes
        WHERE vault_id = $1 AND lower(rel_path) = ANY($2::text[]) AND deleted_at IS NULL
        ORDER BY lower(rel_path), created_at ASC, id ASC`,
      [ctx.vaultId, wanted],
    );
    for (const k of wanted) ctx.cache.notes.set(k, null);
    for (const r of rows) ctx.cache.notes.set(pathKey(r.rel_path), toNote(r));
  }
  await prefetchFolders(ctx, relPaths.map(dirname));
}

export interface NoteInput {
  relPath: string;
  docId?: string;
  folderId?: string | null;
  title?: string | null;
  color?: unknown;
}

/** One note's planned INSERT, once adopt / resolve / gate / latch have all
 *  passed. Held back so a whole batch's rows go in one statement. */
interface NoteInsertPlan {
  index: number;
  id: string;
  folderId: string | null;
  title: string | null;
  storedRelPath: string;
  color: string | null;
}

/**
 * Register a batch of notes — and, with one item, the single-item route.
 *
 * `registerNote` IS this function with a list of one, which is what makes the
 * batch and the single route incapable of drifting (`bulk-registry-batch.test.ts`
 * "a batch and N single calls produce identical rows and identical codes").
 *
 * The SEQUENCE is unchanged and per item, in the order every incident report in
 * this file is about: **adopt-by-path (case-insensitive, canonical echo) →
 * resolve the parent from the path → the write gate → the frozen-root latch →
 * insert**. What moved is only WHERE the questions are asked:
 *
 *  · the adopt probe and the parent lookup are answered from the request cache,
 *    prefilled by ONE `lower(path) = ANY($1)` read each (`prefetchNotes`);
 *  · the inserts are ONE `INSERT … SELECT FROM unnest(…) ON CONFLICT (id) DO
 *    NOTHING RETURNING id` (measured 2.1× faster than a multi-row VALUES at
 *    1,000 rows, and unlike COPY it keeps `ON CONFLICT`, which is what makes a
 *    retried batch safe);
 *  · the `DO NOTHING` discrimination — "already yours" vs "belongs to another
 *    vault" — is one `= ANY` read instead of one probe per row.
 *
 * Three properties are load-bearing and deliberately preserved:
 *  · **No transaction.** A 23505 on `notes_live_path_ci_uq` aborts the whole
 *    multi-row statement, so the fallback re-runs the planned rows ONE AT A TIME
 *    with each row's own 23505 → adopt-the-winner branch. A transaction here
 *    would take the other 199 items down with the one that raced.
 *  · **Intra-batch identity.** A planned row is written into the path cache
 *    immediately, and its id into `known`, so a second item naming the same path
 *    adopts it and the frozen-root latch sees it — exactly what the sequential
 *    version saw, because its insert had already committed.
 *  · **`rel_path`/`folder_id` agree**: the stored path is the parent's own
 *    spelling, from `resolveParentFolder`, unchanged.
 */
export async function registerNotes(
  ctx: RegisterCtx,
  inputs: NoteInput[],
): Promise<Array<RegisterResult<NoteRow>>> {
  const results = new Array<RegisterResult<NoteRow> | undefined>(inputs.length);
  const plans: NoteInsertPlan[] = [];
  // Ids this batch has already claimed. Seeds the frozen-root latch's existence
  // check, because the sequential version's earlier insert had already landed.
  const known = new Set<string>();

  await prefetchNotes(ctx, inputs.map((i) => i.relPath));

  // The frozen-root latch asks "does a row with this id already exist?" for
  // root-bound items only. One `= ANY` read for the batch instead of one probe
  // per item; nothing else about the latch changes.
  let existingIds: Set<string> | null = null;
  const probeIds = async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const { rows } = await ctx.db.query<{ id: string }>(
      "SELECT id FROM notes WHERE id = ANY($1::text[])",
      [ids],
    );
    return new Set(rows.map((r) => r.id));
  };

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
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
    if (byPath) {
      results[index] = { status: "adopted", row: byPath, wrote: false };
      continue;
    }

    // `relPath` is authoritative; `folderId` must be the folder at its dirname (or
    // is resolved from it). A desktop whose folder map missed a parent otherwise
    // writes a row every client renders in one place and every ACL walk reads in
    // another (2026-08-27 phantom-root-folder).
    let resolvedFolder: string | null;
    let storedRelPath: string;
    try {
      const loc = await resolveParentFolder(
        ctx.db,
        ctx.vaultId,
        input.relPath,
        input.folderId ?? null,
        cachedFolderLookup(ctx),
      );
      resolvedFolder = loc.folderId;
      storedRelPath = loc.relPath;
    } catch (err) {
      if (err instanceof TreeOpError) {
        results[index] = { status: "error", code: "path_folder_mismatch", message: err.message };
        continue;
      }
      throw err;
    }

    // Write permission on the RESOLVED folder, not bare membership — the same gate
    // MCP's `create_note` applies. Without it a user who is read-only on every
    // note in a folder could still fill it with new ones.
    if (!(await ctx.canCreateIn(resolvedFolder))) {
      results[index] = {
        status: "error",
        code: "no_write_access",
        message: "You do not have permission to create a note here.",
      };
      continue;
    }

    // Frozen root: refuse only notes that do not exist yet. Re-registering a root
    // note that predates the latch (a second device, a repeat reconcile) has to
    // keep working, or freezing the root would break sync for the very notes the
    // team froze it to protect.
    if (resolvedFolder === null && (await ctx.rootFrozen())) {
      existingIds ??= await probeIds(
        inputs
          .map((i) => (typeof i.docId === "string" && i.docId ? i.docId : null))
          .filter((d): d is string => !!d),
      );
      if (!existingIds.has(id) && !known.has(id)) {
        results[index] = {
          status: "error",
          code: "root_frozen",
          message: "This vault's root is frozen — create this inside a folder instead.",
        };
        continue;
      }
    }

    plans.push({
      index,
      id,
      folderId: resolvedFolder,
      title: input.title ?? null,
      storedRelPath,
      color: normalizeColor(input.color) ?? null,
    });
    known.add(id);
    // Write through, so a second item in the SAME batch naming this path (or a
    // case-variant of it) adopts this row instead of racing it to a 23505.
    ctx.cache.notes.set(pathKey(storedRelPath), {
      id,
      folderId: resolvedFolder,
      title: input.title ?? null,
      relPath: storedRelPath,
    });
  }

  if (plans.length > 0) await applyNoteInserts(ctx, plans, results);

  return results.map((r, i) => {
    if (r) return r;
    // Unreachable: every index is filled by the loop above or by the insert
    // apply. Kept as a total function rather than a `!`.
    const p = inputs[i];
    return { status: "error", code: "path_folder_mismatch", message: `unresolved: ${p.relPath}` };
  });
}

/**
 * Insert the planned rows and discriminate what `ON CONFLICT (id) DO NOTHING`
 * declined to write. One statement for the batch; a 23505 on the PATH index
 * aborts it, so that case replays the plans one at a time with each row's own
 * adopt-the-winner fallback — the sequential behaviour, verbatim.
 */
async function applyNoteInserts(
  ctx: RegisterCtx,
  plans: NoteInsertPlan[],
  results: Array<RegisterResult<NoteRow> | undefined>,
): Promise<void> {
  // An id repeated inside one batch: only the first row is offered to Postgres,
  // and the rest fall through the "not inserted" branch below exactly as they
  // did when each was its own statement against an already-committed row.
  const seen = new Set<string>();
  const firsts = plans.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  const inserted = new Set<string>();
  try {
    // RETURNING tells us whether the row is actually ours. `DO NOTHING` alone is
    // silent about *why* nothing happened, and answering "created" regardless told
    // the client "doc `id` now belongs to `vaultId`" even when that id was already
    // a note in a DIFFERENT vault — after which /api/sync-token 403s forever.
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by, color)
       SELECT p.id, $2, p.folder_id, p.title, p.rel_path, p.id, $3, p.color
         FROM unnest($1::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS p(id, folder_id, title, rel_path, color)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        firsts.map((p) => p.id),
        ctx.vaultId,
        ctx.userId,
        firsts.map((p) => p.folderId),
        firsts.map((p) => p.title),
        firsts.map((p) => p.storedRelPath),
        firsts.map((p) => p.color),
      ],
    );
    for (const r of rows) inserted.add(r.id);
  } catch (err) {
    // Lost the race against a concurrent register of the same path
    // (`notes_live_path_uq` m021, or `notes_live_path_ci_uq` m023 for a
    // case-variant), which aborts the WHOLE multi-row statement. Replay one at a
    // time so the winner is adopted per row, canonical and all.
    if ((err as { code?: string }).code !== "23505") throw err;
    for (const p of firsts) {
      try {
        const one = await ctx.db.query(
          `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by, color)
           VALUES ($1, $2, $3, $4, $5, $1, $6, $7)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [p.id, ctx.vaultId, p.folderId, p.title, p.storedRelPath, ctx.userId, p.color],
        );
        if ((one.rowCount ?? 0) > 0) inserted.add(p.id);
      } catch (rowErr) {
        if ((rowErr as { code?: string }).code !== "23505") throw rowErr;
        const winner = await liveNoteByPath(ctx, p.storedRelPath, true);
        if (winner) {
          results[p.index] = { status: "adopted", row: winner, wrote: false };
          ctx.cache.notes.set(pathKey(winner.relPath), winner);
          continue;
        }
        throw rowErr;
      }
    }
  }

  // Keyed by PLAN, not by id. A batch that names the same doc_id twice inserts
  // it once; the SECOND plan must take the "already exists" branch below and
  // adopt the row's canonical path, exactly as it did when the first plan's
  // insert had already committed.
  const insertedPlans = new Set<number>();
  for (const p of firsts) if (inserted.has(p.id)) insertedPlans.add(p.index);

  const undecided = plans.filter(
    (p) => results[p.index] === undefined && !insertedPlans.has(p.index),
  );
  const existing = new Map<
    string,
    { vault_id: string; rel_path: string; folder_id: string | null; title: string | null }
  >();
  if (undecided.length > 0) {
    const { rows } = await ctx.db.query<{
      id: string;
      vault_id: string;
      rel_path: string;
      folder_id: string | null;
      title: string | null;
    }>(
      "SELECT id, vault_id, rel_path, folder_id, title FROM notes WHERE id = ANY($1::text[])",
      [[...new Set(undecided.map((p) => p.id))]],
    );
    for (const r of rows) existing.set(r.id, r);
  }

  for (const p of plans) {
    if (results[p.index] !== undefined) continue;
    const created: NoteRow = {
      id: p.id,
      folderId: p.folderId,
      title: p.title,
      relPath: p.storedRelPath,
    };
    if (insertedPlans.has(p.index)) {
      results[p.index] = { status: "created", wrote: true, row: created };
      continue;
    }
    const row = existing.get(p.id);
    if (row && row.vault_id !== ctx.vaultId) {
      results[p.index] = {
        status: "conflict",
        code: "doc_id_conflict",
        message: "doc_id already belongs to another vault",
        id: p.id,
      };
      continue;
    }
    // Re-registering the same note in the same vault is the ordinary adopt path
    // — still a success. But `DO NOTHING` wrote nothing, so answering with the
    // REQUESTED path told the client "this note now lives at `relPath`" about a
    // move that never happened; it then mapped its file to a path the server
    // disagrees with and re-sent it on every reconcile. Echo the row's canonical
    // path/folder instead. Moving a note is `PATCH /api/notes/:id`.
    if (row && row.rel_path !== p.storedRelPath) {
      const adopted: NoteRow = {
        id: p.id,
        folderId: row.folder_id,
        title: row.title,
        relPath: row.rel_path,
      };
      ctx.cache.notes.set(pathKey(row.rel_path), adopted);
      results[p.index] = { status: "adopted", wrote: false, row: adopted };
      continue;
    }
    results[p.index] = { status: "created", wrote: true, row: created };
  }
}

/** One note — {@link registerNotes} with a list of one, so the single-item route
 *  and the batch route are literally the same code. */
export async function registerNote(
  ctx: RegisterCtx,
  input: NoteInput,
): Promise<RegisterResult<NoteRow>> {
  return (await registerNotes(ctx, [input]))[0];
}

// ── files (tree binaries) ──────────────────────────────────────────────────

async function fileByPath(ctx: RegisterCtx, path: string): Promise<FileRow | null> {
  const key = pathKey(path);
  const hit = ctx.cache.files.get(key);
  if (hit !== undefined) return hit;
  const { rows } = await ctx.db.query<{ id: string; folder_id: string | null; path: string }>(
    "SELECT id, folder_id, path FROM files WHERE vault_id = $1 AND lower(path) = lower($2) LIMIT 1",
    [ctx.vaultId, path],
  );
  const r = rows[0];
  const row = r ? { id: r.id, folderId: r.folder_id, path: r.path } : null;
  ctx.cache.files.set(key, row);
  return row;
}

/** One `lower(path) = ANY($1)` read for a whole file batch's adopt probes, plus
 *  one for the parent folders their paths name. See {@link RegisterCache}. */
export async function prefetchFiles(ctx: RegisterCtx, paths: string[]): Promise<void> {
  const wanted = [...new Set(paths.filter((p) => p !== "").map(pathKey))].filter(
    (k) => !ctx.cache.files.has(k),
  );
  if (wanted.length > 0) {
    const { rows } = await ctx.db.query<{ id: string; folder_id: string | null; path: string }>(
      `SELECT DISTINCT ON (lower(path)) id, folder_id, path FROM files
        WHERE vault_id = $1 AND lower(path) = ANY($2::text[])
        ORDER BY lower(path), id ASC`,
      [ctx.vaultId, wanted],
    );
    for (const k of wanted) ctx.cache.files.set(k, null);
    for (const r of rows) {
      ctx.cache.files.set(pathKey(r.path), { id: r.id, folderId: r.folder_id, path: r.path });
    }
  }
  await prefetchFolders(ctx, paths.map(dirname));
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
    const loc = await resolveParentFolder(
      ctx.db,
      ctx.vaultId,
      input.path,
      input.folderId ?? null,
      cachedFolderLookup(ctx),
    );
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
    const moved = { id, folderId: resolvedFolder, path: storedPath };
    // The row left `byId[0].path` and landed here — forget the old key (the
    // cache would otherwise still claim a file at a path nothing occupies) and
    // remember the new one.
    ctx.cache.files.delete(pathKey(byId[0].path));
    ctx.cache.files.set(pathKey(storedPath), moved);
    return { status: "adopted", wrote: true, row: moved };
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
  const created = { id, folderId: resolvedFolder, path: storedPath };
  ctx.cache.files.set(pathKey(storedPath), created);
  return { status: "created", wrote: true, row: created };
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
