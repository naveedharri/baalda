// Test helper: run a reconcile against a given vault tree.
//
// `VaultRegistry.reconcile` deliberately takes NO tree — it reads the full
// recursive walk itself (`ipc.listTree`), because the one tree a caller had
// handy was the sidebar's lazy, top-level-only one, and feeding it in emptied
// 428 real notes. Tests therefore supply the tree the way production does: by
// deciding what the filesystem returns.

import { vi } from "vitest";
import type { TreeNode } from "../../../ipc";
import * as ipc from "../../../ipc";
import type { VaultRegistry } from "../../registry";

/**
 * Stamp `childrenLoaded: true` on every directory, recursively.
 *
 * That flag is how the registry tells the FULL walk from the sidebar's lazy one,
 * and it now refuses to reconcile against a tree that doesn't claim to be complete
 * — a partial tree would read as "the server deleted everything I can't see".
 * Rust sets it on every `list_tree` directory, so a fixture that omits it is
 * describing something production never produces.
 */
export function fullTree(tree: TreeNode): TreeNode {
  if (!tree.isDir) return tree;
  return {
    ...tree,
    childrenLoaded: true,
    children: (tree.children ?? []).map(fullTree),
  };
}

/** Point `listTree` at `tree`, then reconcile. Returns reconcile's promise
 *  un-awaited so callers can park it mid-flight. */
export function reconcileWithTree(
  reg: VaultRegistry,
  input: { organizationId: string; vaultName: string },
  tree: TreeNode,
): Promise<{ seeded: boolean }> {
  vi.mocked(ipc.listTree).mockResolvedValue(fullTree(tree));
  return reg.reconcile(input);
}
