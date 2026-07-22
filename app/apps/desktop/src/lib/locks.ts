// Lock (deny-overlay) helpers shared by the tree, editor, and the vault
// settings Permissions tab. Locks arrive from the server keyed by resource id
// (registry folder id / doc id); the UI thinks in vault-relative paths.

import { sharePrincipalId, sharePrincipalType, shareResourceId, type Share } from "./api";
import type { TreeNode } from "./ipc";
import { syncManager } from "./sync/docSession";

/** Who a lock applies to, from the current user's point of view. */
export type LockScope = "all" | "you" | "member";

export const LOCK_TITLES: Record<LockScope, string> = {
  all: "Locked for everyone — changes won't sync",
  you: "Locked for you — changes won't sync",
  member: "Locked for a member",
};

const RANK: Record<LockScope, number> = { all: 2, you: 1, member: 0 };

/** Reverse-map every tree node to its server resource id via the registry. */
export function resourceIdsByPath(tree: TreeNode | null): Map<string, string> {
  const idToPath = new Map<string, string>();
  const walk = (n: TreeNode) => {
    if (n.isDir) {
      const id = syncManager.registry.getFolderId(n.path);
      if (id) idToPath.set(id, n.path);
    } else {
      const m = syncManager.registry.getMapping(n.path);
      if (m) idToPath.set(m.docId, n.path);
    }
    n.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
  return idToPath;
}

/**
 * Resolve lock rows to tree paths. When several locks hit the same node the
 * strongest scope wins: "all" > "you" > "member".
 */
export function lockScopesByPath(
  tree: TreeNode | null,
  locks: Share[],
  currentUserId: string | undefined,
): Map<string, LockScope> {
  const map = new Map<string, LockScope>();
  if (!tree || locks.length === 0) return map;
  const idToPath = resourceIdsByPath(tree);
  for (const lock of locks) {
    const path = idToPath.get(shareResourceId(lock));
    if (!path) continue;
    const scope: LockScope =
      sharePrincipalType(lock) === "org"
        ? "all"
        : sharePrincipalId(lock) === currentUserId
          ? "you"
          : "member";
    const prev = map.get(path);
    if (!prev || RANK[scope] > RANK[prev]) map.set(path, scope);
  }
  return map;
}

/**
 * Effective lock on a path, including locks inherited from ancestor folders
 * (folder locks apply to everything inside).
 */
export function effectiveLockForPath(
  map: Map<string, LockScope>,
  path: string,
): LockScope | null {
  let best: LockScope | null = map.get(path) ?? null;
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/");
    const scope = map.get(ancestor);
    if (scope && (!best || RANK[scope] > RANK[best])) best = scope;
  }
  return best;
}
