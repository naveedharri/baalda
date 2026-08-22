// Which rows the Access panel's item list shows.
//
// Pure, and separate from the component, because two rules here are subtle
// enough to need a test holding them still:
//
//  1. The list is built from the SERVER's structure, not from this machine's
//     disk. An item set to Private leaves the disk (a revocation that leaves a
//     readable copy behind is cosmetic), and the panel used to draw its rows
//     from the disk — so making something Private removed the only row you
//     could un-Private it from. A restriction you cannot see is one you cannot
//     lift.
//  2. In the local-tree fallback, a folder with `childrenLoaded` unset is
//     *expandable, not empty*. The sidebar loads folders lazily, so an
//     un-clicked folder arrives with no children — and calling that "nothing
//     inside" hid every note the user hadn't already opened elsewhere.

import type { TreeNode } from "./ipc";

/** One folder or note the panel can administer, before nesting is worked out. */
export interface AccessEntry {
  kind: "folder" | "file";
  /** Server id: a folder id, or a note's doc_id. */
  id: string;
  /** Vault-relative path. */
  path: string;
  /** Folders only. `undefined` means "not listed yet" — see rule 2 above. */
  hasChildren?: boolean;
}

export interface AccessRow extends AccessEntry {
  key: string;
  name: string;
  depth: number;
  /** Folders only: offer a twisty? */
  expandable: boolean;
}

export interface AccessTreeResolvers {
  /** Server folder id for a vault-relative path, or null if unregistered. */
  folderId: (path: string) => string | null;
  /** doc_id for a vault-relative note path, or null if unregistered. */
  docId: (path: string) => string | null;
}

/** basename, optionally without the `.md` a note's title never shows. */
export function accessRowName(path: string, stripMd = false): string {
  const last = path.split("/").pop() ?? path;
  return stripMd ? last.replace(/\.md$/i, "") : last;
}

/**
 * Entries from the server's structure listing (`listAccessTree`).
 *
 * This is the authoritative source: it is not ACL-filtered, so it includes the
 * items the caller has shut themselves out of — which are exactly the ones they
 * need to reach in order to change their minds.
 */
export function entriesFromServer(input: {
  folders: Array<{ id: string; path: string }>;
  notes: Array<{ id: string; relPath: string }>;
}): AccessEntry[] {
  const folderPaths = input.folders.map((f) => f.path);
  const allPaths = [...folderPaths, ...input.notes.map((n) => n.relPath)];
  const hasChildren = (dir: string) => allPaths.some((p) => p.startsWith(`${dir}/`));
  return [
    ...input.folders.map((f) => ({
      kind: "folder" as const,
      id: f.id,
      path: f.path,
      hasChildren: hasChildren(f.path),
    })),
    ...input.notes.map((n) => ({ kind: "file" as const, id: n.id, path: n.relPath })),
  ];
}

/**
 * Entries from the local sidebar tree — the fallback for a listing that hasn't
 * arrived (or was refused). Carries rule 2: an un-listed folder is expandable.
 *
 * An unregistered folder is skipped as an entry (it can't own a share) but is
 * still walked into, so registered notes beneath it stay reachable.
 */
export function entriesFromTree(
  tree: TreeNode | null,
  resolve: AccessTreeResolvers,
): AccessEntry[] {
  const out: AccessEntry[] = [];
  const walk = (node: TreeNode): void => {
    if (!node.isDir) {
      const docId = resolve.docId(node.path);
      if (docId) out.push({ kind: "file", id: docId, path: node.path });
      return;
    }
    const folderId = resolve.folderId(node.path);
    if (folderId) {
      out.push({
        kind: "folder",
        id: folderId,
        path: node.path,
        hasChildren: node.childrenLoaded !== true ? undefined : (node.children?.length ?? 0) > 0,
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of tree?.children ?? []) walk(child);
  return out;
}

/**
 * Nest a flat entry list into indented rows, leaving a collapsed folder's
 * contents out.
 *
 * Depth and parentage come from the path, which is the only thing both sources
 * agree on. Sorted folders-first then alphabetically within each level, so the
 * list is stable however the server ordered it.
 */
export function rowsFromEntries(
  entries: readonly AccessEntry[],
  expanded: ReadonlySet<string>,
): AccessRow[] {
  const sorted = [...entries].sort((a, b) => {
    const ad = a.path.split("/").length;
    const bd = b.path.split("/").length;
    // Compare level by level so a folder always precedes its own contents.
    const aParts = a.path.split("/");
    const bParts = b.path.split("/");
    for (let i = 0; i < Math.min(ad, bd); i++) {
      if (aParts[i] === bParts[i]) continue;
      const aLeaf = i === ad - 1 && a.kind === "file";
      const bLeaf = i === bd - 1 && b.kind === "file";
      if (aLeaf !== bLeaf) return aLeaf ? 1 : -1; // folders before notes
      return aParts[i].localeCompare(bParts[i]);
    }
    return ad - bd;
  });

  const collapsed = sorted
    .filter((e) => e.kind === "folder" && !expanded.has(e.path))
    .map((e) => `${e.path}/`);
  const hidden = (path: string) => collapsed.some((prefix) => path.startsWith(prefix));

  return sorted
    .filter((e) => !hidden(e.path))
    .map((e) => ({
      ...e,
      key: `${e.kind}:${e.id}`,
      name: accessRowName(e.path, e.kind === "file"),
      depth: e.path.split("/").length - 1,
      // `undefined` (not listed yet) counts as expandable — refusing the twisty
      // on an un-listed folder is the bug rule 2 exists to prevent.
      expandable: e.kind === "folder" && e.hasChildren !== false,
    }));
}

/** Has the sidebar already listed this folder's contents? */
export function folderChildrenLoaded(tree: TreeNode | null, path: string): boolean {
  const find = (node: TreeNode): TreeNode | null => {
    if (node.path === path) return node;
    for (const child of node.children ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const child of tree?.children ?? []) {
    const hit = find(child);
    if (hit) return hit.childrenLoaded === true;
  }
  return false;
}

/** Every folder path above `path` — what has to be open for it to be visible. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}
