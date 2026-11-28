// Lock (deny-overlay) helpers shared by the tree, editor, and the vault
// settings Permissions tab. Locks arrive from the server keyed by resource id
// (registry folder id / doc id); the UI thinks in vault-relative paths.

import {
  sharePrincipalId,
  sharePrincipalType,
  shareResourceId,
  shareResourceType,
  type Share,
} from "./api";
import type { TreeNode } from "./ipc";
import { syncManager } from "./sync/docSession";

/**
 * Who a lock applies to, from the current user's point of view.
 *
 * `vault` is not a row anyone placed on this item: it is the whole-vault
 * Read-only posture reaching down. It keeps its own name so the badge can say
 * so — "Locked for everyone" on all several hundred rows of a read-only vault
 * describes the right state with the wrong cause, and sends people looking for
 * an item setting that does not exist.
 */
export type LockScope = "all" | "vault" | "you" | "member";

export const LOCK_TITLES: Record<LockScope, string> = {
  all: "Locked for everyone. Changes won't sync",
  vault: "Everyone can only view this vault. Changes won't sync",
  you: "Locked for you. Changes won't sync",
  member: "Locked for a member",
};

/**
 * Strongest scope wins when several locks hit one node.
 *
 * `vault` outranks the per-person scopes — it covers strictly more people, so
 * naming one of them would understate it — but sits UNDER `all`, so an item
 * that carries its own Everyone lock keeps the per-item wording. That ordering
 * is the whole point of the scope: it is the label of last resort, used exactly
 * when nothing more specific applies.
 */
const RANK: Record<LockScope, number> = { all: 3, vault: 2, you: 1, member: 0 };

/**
 * Lock scopes by path, plus the paths where the CALLER holds their own
 * per-user `edit` row. Among one person's rows the deepest wins (resolver
 * `userItemVerdict`), so such a row lifts that person's own ("you") lock on
 * any ancestor folder: Can view on a folder, Can edit on one subfolder.
 * Org ("all") locks still cap, exactly as on the server.
 */
export type LockScopeMap = Map<string, LockScope> & { personalLifts?: ReadonlySet<string> };

/** Reverse-map every tree node to its server resource id via the registry. */
export function resourceIdsByPath(tree: TreeNode | null): Map<string, string> {
  const idToPath = new Map<string, string>();
  const walk = (n: TreeNode) => {
    if (n.isDir) {
      const id = syncManager.registry.getFolderId(n.path);
      if (id) idToPath.set(id, n.path);
    } else {
      // A note answers through the doc map, a tree binary through the `files`
      // map. Both are doc_ids a lock can name, and a file that resolved to no
      // path would silently lose its "Restricted" badge.
      const m = syncManager.registry.getMapping(n.path);
      if (m) idToPath.set(m.docId, n.path);
      const fileId = syncManager.registry.getFileId(n.path);
      if (fileId) idToPath.set(fileId, n.path);
    }
    n.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
  return idToPath;
}

/** True when the vault is read-only because its Team subscription lapsed. */
export function hasBillingLapsedLock(locks: readonly Share[]): boolean {
  return locks.some((l) => shareResourceType(l) === "vault" && l.reason === "billing_lapsed");
}

/**
 * Whether Unlock can remove this row. A group's Can view is reported as the
 * caller's own `readonly` row (`reason: "group_view"`, id `group-view:<id>`) so
 * the item shows padlocked, but it is the group's grant, not a lock: there is no
 * share row with that id, and the way to change it is the group's access.
 */
export function isRemovableLock(lock: Share): boolean {
  return lock.reason !== "group_view";
}

/** True when the overlay carries the whole-vault Read-only posture. */
export function hasVaultLock(locks: readonly Share[]): boolean {
  return locks.some((l) => shareResourceType(l) === "vault");
}

/**
 * The rows that sit on an ITEM — everything except the whole-vault posture.
 *
 * Every consumer that maps a lock back to a folder or a note wants this, and
 * only the tree badge wants the posture. Filtering here rather than at each
 * call site is what keeps the posture row from surviving on the coincidence
 * that an org id never matches a folder or doc id.
 */
export function itemLockRows(locks: readonly Share[]): Share[] {
  return locks.filter((l) => shareResourceType(l) !== "vault");
}

/**
 * Resolve lock rows to tree paths. When several locks hit the same node the
 * strongest scope wins: "all" > "vault" > "you" > "member".
 *
 * A `vault` row is the whole-vault Read-only posture, which the server reports
 * as a synthetic lock (see `GET /vaults/:id/locks`). It names no resource of
 * its own — it is a lock on the ROOT — so it seeds EVERY path before the item
 * rows are read. That is the point: a read-only vault has to look locked on
 * every folder and note, because to the person reading the sidebar those are
 * the same state. The seed uses the `vault` scope rather than `all` so only a
 * path with an Everyone row of its OWN gets the per-item wording.
 *
 * `lifts` is what keeps that seed honest. Read-only is a BASELINE, not a
 * ceiling: the server resolves a doc by taking the max over the vault grant and
 * every `edit` row on the item and its ancestors, so a folder set to Shared, or
 * a personal grant on one note, hands the reader edit back. Those rows arrive
 * from the same endpoint, and each one clears the seed from its own path and
 * everything under it. An item's explicit `locked` row still wins afterwards,
 * which is the resolver's rule too — a lock caps even a lifted grant.
 */
export function lockScopesByPath(
  tree: TreeNode | null,
  locks: Share[],
  currentUserId: string | undefined,
  lifts: readonly Share[] = [],
  /**
   * Resolve ids through this id → path map instead of the tree. The sidebar
   * tree is lazy, so a check made for paths nobody expanded (the text pass,
   * closed-app edits) passes the registry's full map (`idToPathIndex`).
   */
  index?: ReadonlyMap<string, string>,
): LockScopeMap {
  const map: LockScopeMap = new Map<string, LockScope>();
  if ((!tree && !index) || locks.length === 0) return map;
  if (hasVaultLock(locks)) {
    if (index) {
      for (const p of index.values()) map.set(p, "vault");
    } else if (tree) {
      const seed = (n: TreeNode) => {
        map.set(n.path, "vault");
        n.children?.forEach(seed);
      };
      tree.children?.forEach(seed);
    }
  }
  const idToPath = index ?? resourceIdsByPath(tree);
  // Before the item rows, so an explicit `locked` row inside a lifted folder
  // still lands and still wins.
  const personalLifts = new Set<string>();
  for (const lift of lifts) {
    const liftedAt = idToPath.get(shareResourceId(lift));
    if (liftedAt === undefined) continue;
    if (sharePrincipalType(lift) === "user" && sharePrincipalId(lift) === currentUserId) {
      personalLifts.add(liftedAt);
    }
    const prefix = liftedAt + "/";
    for (const [path, scope] of map) {
      if (scope !== "vault") continue;
      if (path === liftedAt || path.startsWith(prefix)) map.delete(path);
    }
  }
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
  if (personalLifts.size > 0) map.personalLifts = personalLifts;
  return map;
}

/**
 * Whether a path is read-only FOR THE CALLER: an Everyone lock, the vault
 * posture, or the caller's own row. Another member's row (the `member` scope,
 * which owners/admins see so they can Unlock a legacy lock) is a badge only;
 * it never makes the caller's own editor read-only. `member` ranks lowest, so
 * the effective scope is `member` only when nothing else applies.
 */
export function lockBlocksCaller(map: LockScopeMap, path: string): boolean {
  const scope = effectiveLockForPath(map, path);
  return scope !== null && scope !== "member";
}

/**
 * Effective lock on a path, including locks inherited from ancestor folders
 * (folder locks apply to everything inside).
 *
 * The `vault` scope is the exception: it is never inherited. The posture seeds
 * EVERY path directly, so a path that lacks it lacks it on purpose — a grant
 * lifted that note or folder out of the vault's Read-only baseline. Folding an
 * ancestor's `vault` down would put the padlock straight back on the one note a
 * personal grant made editable, and open it read-only on its first frame.
 */
export function effectiveLockForPath(
  map: LockScopeMap,
  path: string,
): LockScope | null {
  let best: LockScope | null = map.get(path) ?? null;
  const personalLifts = map.personalLifts;
  // Once the walk passes the caller's own `edit` row, their own ancestor locks
  // no longer apply (deepest per-user row wins, resolver `userItemVerdict`).
  let liftedForYou = personalLifts?.has(path) ?? false;
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join("/");
    const scope = map.get(ancestor);
    if (scope && scope !== "vault" && !(scope === "you" && liftedForYou)) {
      if (!best || RANK[scope] > RANK[best]) best = scope;
    }
    if (personalLifts?.has(ancestor)) liftedForYou = true;
  }
  return best;
}
