// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { permissionMode, syntheticRootContext, type SummaryMode } from "./access-summary.js";
import {
  buildAccessContextFromIndex,
  type AccessIndex,
  type ResolverCache,
  resolveAccessForUser,
} from "./resolver.js";

/**
 * The member Access tab's whole map in one pass: every folder, note and file
 * of one collection resolved ONCE for one person, folder agreement folded
 * bottom-up. Each answer equals what `POST /access/summaries` gives that single
 * row (`summarizeAccess` with one group `[item]`): a note/file is its own
 * permission; a folder is the mode its whole subtree (itself, descendant
 * folders, the live notes and files in them) agrees on, else "mixed". The
 * summaries route re-resolves every item once per ancestor group and loads the
 * index per request; this loads it once and resolves n items.
 */

type Queryable = Pick<pg.Pool, "query">;

/** `/health` feature flag for `GET /vaults/:id/access-board`. */
export const ACCESS_BOARD_FEATURE = "access-board";

/** Wire encoding, one char per item: open | readonly | private | mixed. */
export type BoardMode = "e" | "v" | "n" | "m";
export const BOARD_MODE_CHAR: Record<SummaryMode, BoardMode> = {
  open: "e",
  readonly: "v",
  private: "n",
  mixed: "m",
};

type Own = Exclude<SummaryMode, "mixed">;

export interface BoardItems {
  folderIds: readonly string[];
  noteIds: readonly string[];
  fileIds: readonly string[];
}

export interface BoardModesResult {
  /** folder id → its subtree mode. */
  folders: Map<string, SummaryMode>;
  /** note or file id → its own mode. */
  docs: Map<string, Own>;
}

export async function boardModes(input: {
  db: Queryable;
  index: AccessIndex;
  cache: ResolverCache;
  vaultId: string;
  userId: string;
  role: string | null;
  /** Ids the caller lists (the access-tree SELECTs). An id the index lacks
   *  (raced a create) still resolves through the context builder's DB fallback. */
  items: BoardItems;
}): Promise<BoardModesResult> {
  const { db, index, cache, vaultId, userId, role, items } = input;

  // `null` = no context (deleted between listing and resolution), skipped by
  // the fold exactly as summarizeAccess skips it.
  const resolve = async (type: "folder" | "file", id: string): Promise<Own | null> => {
    const ctx = await buildAccessContextFromIndex(index, type, id, db, cache);
    if (!ctx) return null;
    return permissionMode((await resolveAccessForUser(ctx, userId, role, db, cache, index)).permission);
  };
  let synthetic: Own | undefined;
  const emptyScope = async (): Promise<Own> => {
    if (synthetic === undefined) {
      synthetic = permissionMode(
        (await resolveAccessForUser(syntheticRootContext(index), userId, role, db, cache, index)).permission,
      );
    }
    return synthetic;
  };

  // Every folder of this collection the index holds, plus any listed one.
  const folderIds = new Set<string>(items.folderIds);
  for (const [id, f] of index.folders) if (f.vaultId === vaultId) folderIds.add(id);
  const ownFolder = new Map<string, Own | null>();
  for (const id of folderIds) ownFolder.set(id, await resolve("folder", id));

  const docIds = new Set<string>([...items.noteIds, ...items.fileIds]);
  const ownDoc = new Map<string, Own | null>();
  for (const id of docIds) ownDoc.set(id, await resolve("file", id));

  // Subtree agreement. Contributions mirror summaryTargetsFromIndex: child
  // folders by index parent, live notes/files by index folderId.
  type Agg = Own | "mixed" | null;
  const join = (a: Agg, b: Agg): Agg => (a === null ? b : b === null ? a : a === b ? a : "mixed");
  const agg = new Map<string, Agg>();
  for (const id of folderIds) agg.set(id, ownFolder.get(id) ?? null);
  const addDocs = async (docs: Map<string, { vaultId: string; folderId: string | null }>) => {
    for (const [id, d] of docs) {
      if (d.vaultId !== vaultId || !d.folderId || !agg.has(d.folderId)) continue;
      let own = ownDoc.get(id);
      if (own === undefined) {
        own = await resolve("file", id);
        ownDoc.set(id, own);
      }
      agg.set(d.folderId, join(agg.get(d.folderId)!, own ?? null));
    }
  };
  await addDocs(index.notes);
  await addDocs(index.files);

  // Deepest first, so a folder folds its children's finished subtrees.
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const chain: string[] = [];
    let cur: string | null = id;
    let base = 0;
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      const d = depth.get(cur);
      if (d !== undefined) { base = d; break; }
      seen.add(cur);
      chain.push(cur);
      cur = index.folders.get(cur)?.parentId ?? null;
    }
    for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i], ++base);
    return depth.get(id)!;
  };
  const ordered = [...folderIds].sort((a, b) => depthOf(b) - depthOf(a));
  for (const id of ordered) {
    const parent = index.folders.get(id)?.parentId ?? null;
    if (parent !== null && agg.has(parent)) agg.set(parent, join(agg.get(parent)!, agg.get(id)!));
  }

  const folders = new Map<string, SummaryMode>();
  for (const id of folderIds) {
    const a = agg.get(id)!;
    folders.set(id, a ?? (await emptyScope()));
  }
  const docs = new Map<string, Own>();
  for (const id of docIds) docs.set(id, ownDoc.get(id) ?? (await emptyScope()));
  return { folders, docs };
}

/** Align modes to the listing order: folders, then notes, then files. */
export function encodeBoardModes(result: BoardModesResult, items: BoardItems): string {
  let out = "";
  for (const id of items.folderIds) out += BOARD_MODE_CHAR[result.folders.get(id) ?? "private"];
  for (const id of items.noteIds) out += BOARD_MODE_CHAR[result.docs.get(id) ?? "private"];
  for (const id of items.fileIds) out += BOARD_MODE_CHAR[result.docs.get(id) ?? "private"];
  return out;
}
