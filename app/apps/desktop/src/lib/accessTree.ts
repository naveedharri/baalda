// Which rows the Access panel's item list shows, given the vault tree and the
// set of open folders.
//
// Pure, and separate from the component, for one reason: the rule that a folder
// with `childrenLoaded` unset is *expandable, not empty* is the whole fix for
// "I can't reach the notes inside a folder". The sidebar loads folders lazily,
// so an un-clicked folder arrives with no children at all — and treating that
// as "nothing inside" is what hid every note the user hadn't already opened
// elsewhere. A rule that subtle belongs somewhere a test can hold it still.

import type { TreeNode } from "./ipc";

export interface AccessRow {
  key: string;
  kind: "folder" | "file";
  /** Server id: a folder id, or a note's doc_id. */
  id: string;
  path: string;
  name: string;
  depth: number;
  /** Folders only: offer a twisty? True when there is (or might be) something
   *  inside — see the note above about un-listed folders. */
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
 * Flatten the tree into indented rows, leaving a collapsed folder's contents
 * out.
 *
 * An unregistered folder (no server id) is skipped as a ROW — it can't own a
 * share — but is still walked into, so registered notes underneath it stay
 * reachable.
 */
export function visibleAccessRows(
  tree: TreeNode | null,
  expanded: ReadonlySet<string>,
  resolve: AccessTreeResolvers,
): AccessRow[] {
  const out: AccessRow[] = [];

  const walk = (node: TreeNode, depth: number): void => {
    if (!node.isDir) {
      const docId = resolve.docId(node.path);
      if (docId) {
        out.push({
          key: `file:${docId}`,
          kind: "file",
          id: docId,
          path: node.path,
          name: accessRowName(node.path, true),
          depth,
          expandable: false,
        });
      }
      return;
    }

    const folderId = resolve.folderId(node.path);
    if (folderId) {
      out.push({
        key: `folder:${folderId}`,
        kind: "folder",
        id: folderId,
        path: node.path,
        name: accessRowName(node.path),
        depth,
        // Unlisted (`childrenLoaded` absent) ⇒ assume there IS something.
        expandable: node.childrenLoaded !== true || (node.children?.length ?? 0) > 0,
      });
      if (!expanded.has(node.path)) return;
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };

  for (const child of tree?.children ?? []) walk(child, 0);
  return out;
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
