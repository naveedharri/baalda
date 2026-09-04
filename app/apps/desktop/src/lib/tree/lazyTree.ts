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

/**
 * A fresh listing of one folder, with the previously-loaded subtrees carried
 * over: a sub-folder present in both keeps its old `children`/`childrenLoaded`
 * (the listing only knows it as an unloaded placeholder), so re-listing a
 * folder never folds up what the user had expanded beneath it. Sub-folders that
 * left the listing drop out; new ones arrive as placeholders.
 */
export function mergeChildren(previous: TreeNode[] | undefined, fresh: TreeNode[]): TreeNode[] {
  if (!previous || previous.length === 0) return fresh;
  const byPath = new Map<string, TreeNode>();
  for (const p of previous) if (p.isDir && p.childrenLoaded === true) byPath.set(p.path, p);
  if (byPath.size === 0) return fresh;
  return fresh.map((node) => {
    if (!node.isDir || node.childrenLoaded === true) return node;
    const loaded = byPath.get(node.path);
    return loaded ? { ...node, children: loaded.children, childrenLoaded: true } : node;
  });
}

/** The node at `path` in a lazy-loaded tree, or null if it isn't loaded. */
export function nodeAt(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    if (!c.isDir) continue;
    if (path === c.path || path.startsWith(`${c.path}/`)) return nodeAt(c, path);
  }
  return null;
}

/**
 * The folders a watcher batch can have changed the LISTING of, for a targeted
 * sidebar refresh (#82): a modified or removed file changes only its parent
 * folder's listing. Returns null when the batch has a structural change (`tree`:
 * a folder created/removed/renamed, a non-note file) — those can move whole
 * subtrees, and only a full re-list is honest there.
 */
export function implicatedFolders(
  changes: ReadonlyArray<{ path: string; kind: "modified" | "removed" | "tree" }>,
): Set<string> | null {
  const dirs = new Set<string>();
  for (const c of changes) {
    if (c.kind === "tree") return null;
    const i = c.path.lastIndexOf("/");
    dirs.add(i === -1 ? "" : c.path.slice(0, i));
  }
  return dirs;
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
