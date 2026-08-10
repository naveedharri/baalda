// The sidebar's BASE arrangement — what the tree looks like before the user's
// own drag-and-drop arrangement is layered on top of it.
//
// Two layers, and the order between them is the whole design:
//
//   sortTree()  →  the base order, from a preference (recent / A–Z)
//   applyOrder() →  the user's manual per-folder arrangement, pinned on top
//
// Because `applyOrder` ranks the items a folder has been arranged with and
// leaves every *unranked* item in the order it received, sorting first means
// changing the sort can never disturb an arrangement someone made by hand: a
// folder they dragged into place keeps its position, while the folders and
// files they never touched — including everything inside that folder — follow
// the sort. That is the property to preserve if this is ever refactored.
//
// Pure and dependency-free (the TreeNode import is type-only) so it tests in a
// plain Node environment.

import type { TreeNode } from "../ipc";

/** How the sidebar arranges anything the user hasn't arranged themselves. */
export type TreeSort = "recent" | "name";

export const TREE_SORTS: Array<{ id: TreeSort; label: string; hint: string }> = [
  { id: "recent", label: "Recently modified", hint: "Newest notes first" },
  { id: "name", label: "Name (A–Z)", hint: "Alphabetical" },
];

/** Sidebar rows are titles, so compare them the way a reader would: "note 10"
 *  after "note 9", case- and accent-insensitively. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function byName(a: TreeNode, b: TreeNode): number {
  return collator.compare(a.name, b.name);
}

/**
 * Sort a tree level (and, recursively, everything under it).
 *
 * Folders always come first and always sort A–Z, in BOTH modes. A folder's
 * mtime moves whenever anything inside it does, so sorting folders by recency
 * would shuffle the sidebar's skeleton every time a note is saved — the part of
 * the tree a user navigates by muscle memory. Recency is a property of the
 * notes, so that is where the mode applies. (This is also what "default to
 * recent for the files, mostly not the folders" asks for.)
 *
 * Ties and missing mtimes (0/absent) fall back to name order, so the result is
 * total and stable rather than dependent on what `read_dir` happened to yield.
 */
export function sortTree(nodes: TreeNode[], mode: TreeSort): TreeNode[] {
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const n of nodes) (n.isDir ? dirs : files).push(n);

  dirs.sort(byName);
  files.sort(
    mode === "name"
      ? byName
      : (a, b) => (b.modified ?? 0) - (a.modified ?? 0) || byName(a, b),
  );

  return [...dirs, ...files].map((n) =>
    n.children ? { ...n, children: sortTree(n.children, mode) } : n,
  );
}
