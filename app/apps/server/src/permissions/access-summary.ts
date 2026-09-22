import type pg from "pg";
import {
  buildAccessContextFromIndex,
  type AccessContext,
  type AccessIndex,
  type ResolverCache,
  resolveAccessForUser,
} from "./resolver.js";

/**
 * "What access do these people have to this selection?" for the Access panel.
 *
 * A folder or vault root expands to every folder and document under it, and
 * each one is resolved for every selected person by the real resolver
 * ({@link resolveAccessForUser}). The rows it reads come from one
 * {@link AccessIndex} loaded per request, so a 7,000-note vault is a handful of
 * queries rather than ~5 per note per person, and one request can answer every
 * visible row of the panel at once.
 */

type Queryable = Pick<pg.Pool, "query">;

export type SummaryResource = { resourceType: "folder" | "file" | "vault"; resourceId: string };
export type SummaryTarget = { resourceType: "folder" | "file"; resourceId: string };
export type SummaryMode = "open" | "readonly" | "private" | "mixed";

/** Where a root belongs according to the index: `true` when it is this
 *  organization's, `false` when the index does not hold it. */
export function indexHoldsResource(index: AccessIndex, resource: SummaryResource): boolean {
  if (resource.resourceType === "vault") return resource.resourceId === index.organizationId;
  if (resource.resourceType === "folder") return index.folders.has(resource.resourceId);
  return index.notes.has(resource.resourceId) || index.files.has(resource.resourceId);
}

/**
 * Expand compact roots exactly as the old recursive query did: a vault root is
 * every folder, live note and file; a folder root is itself, its descendant
 * folders and the live notes and files in them; a file root is itself.
 */
export function summaryTargetsFromIndex(index: AccessIndex, resources: readonly SummaryResource[]): SummaryTarget[] {
  const out = new Map<string, SummaryTarget>();
  const add = (resourceType: "folder" | "file", resourceId: string) =>
    out.set(`${resourceType}\u0000${resourceId}`, { resourceType, resourceId });

  if (resources.some((resource) => resource.resourceType === "vault")) {
    for (const id of index.folders.keys()) add("folder", id);
    for (const id of index.notes.keys()) add("file", id);
    for (const id of index.files.keys()) add("file", id);
    return [...out.values()];
  }

  const children = new Map<string, string[]>();
  for (const [id, folder] of index.folders) {
    if (folder.parentId === null) continue;
    const list = children.get(folder.parentId);
    if (list) list.push(id);
    else children.set(folder.parentId, [id]);
  }
  const subtree = new Set<string>();
  const stack = resources
    .filter((resource) => resource.resourceType === "folder" && index.folders.has(resource.resourceId))
    .map((resource) => resource.resourceId);
  while (stack.length) {
    const id = stack.pop()!;
    if (subtree.has(id)) continue;
    subtree.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  for (const id of subtree) add("folder", id);
  for (const [id, note] of index.notes) if (note.folderId && subtree.has(note.folderId)) add("file", id);
  for (const [id, file] of index.files) if (file.folderId && subtree.has(file.folderId)) add("file", id);
  for (const resource of resources) {
    if (resource.resourceType !== "file") continue;
    if (index.notes.has(resource.resourceId) || index.files.has(resource.resourceId)) add("file", resource.resourceId);
  }
  return [...out.values()];
}

/** One summary per group of roots, each stopping at its first disagreement. */
export async function summarizeAccess(input: {
  db: Queryable;
  index: AccessIndex;
  cache: ResolverCache;
  groups: readonly (readonly SummaryResource[])[];
  userIds: readonly string[];
  roles: ReadonlyMap<string, string>;
}): Promise<SummaryMode[]> {
  const { db, index, cache, userIds, roles } = input;
  const modes: SummaryMode[] = [];
  for (const group of input.groups) {
    let agreed: Exclude<SummaryMode, "mixed"> | null = null;
    let mixed = false;
    const note = (permission: "edit" | "view" | "none") => {
      const mode = permission === "edit" ? "open" : permission === "view" ? "readonly" : "private";
      if (agreed === null) agreed = mode;
      else if (agreed !== mode) mixed = true;
    };
    const resolveAll = async (ctx: AccessContext) => {
      for (const userId of userIds) {
        note((await resolveAccessForUser(ctx, userId, roles.get(userId) ?? null, db, cache, index)).permission);
        if (mixed) return;
      }
    };
    for (const target of summaryTargetsFromIndex(index, group)) {
      const ctx = await buildAccessContextFromIndex(index, target.resourceType, target.resourceId, db, cache);
      if (!ctx) continue; // deleted between expansion and resolution
      await resolveAll(ctx);
      if (mixed) break;
    }
    if (!mixed && agreed === null) {
      // An empty scope still has an authoritative posture and personal vault
      // grants. A synthetic root has no creator/folder/item overlay, exactly the
      // facts available for content that does not exist yet.
      await resolveAll({
        organizationId: index.organizationId,
        docId: null,
        folderIds: [],
        createdBy: null,
        createdAt: new Date(),
      });
    }
    modes.push(mixed ? "mixed" : agreed ?? "private");
  }
  return modes;
}
