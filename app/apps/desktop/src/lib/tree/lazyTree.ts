// Pure helpers for the sidebar's lazily-loaded tree. Kept out of the store (and
// free of any Tauri import — the TreeNode import is type-only, so it erases) so
// the invariants below can be tested in a plain Node environment.

import type { TreeNode } from "../ipc";

/**
 * Every folder whose children have actually been listed, excluding the root,
 * ordered shallowest first.
 *
 * `refreshTree` re-lists these so a refresh doesn't silently un-load whatever
 * the user had expanded. The ordering is load-bearing: `setChildrenAt` only
 * descends through nodes that already carry children, so a nested folder can't
 * be filled in before its parent is.
 */
export function loadedFolderPaths(node: TreeNode | null): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (!n.isDir) return;
    if (n.path !== "" && n.childrenLoaded === true) out.push(n.path);
    n.children?.forEach(walk);
  };
  if (node) walk(node);
  return out.sort((a, b) => a.split("/").length - b.split("/").length);
}

/** Immutably replace one node's `children` (by path) in a lazy-loaded tree. */
export function setChildrenAt(
  node: TreeNode,
  path: string,
  children: TreeNode[],
): TreeNode {
  // Filling in a folder's children is also what makes it *loaded* — that flag is
  // the only thing separating "this folder has no notes" from "nobody has opened
  // it yet", and the sidebar labels the first case "empty".
  if (node.path === path) return { ...node, children, childrenLoaded: true };
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((c) => setChildrenAt(c, path, children)),
  };
}
