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

/** Point `listTree` at `tree`, then reconcile. Returns reconcile's promise
 *  un-awaited so callers can park it mid-flight. */
export function reconcileWithTree(
  reg: VaultRegistry,
  input: { organizationId: string; vaultName: string },
  tree: TreeNode,
): Promise<{ seeded: boolean }> {
  vi.mocked(ipc.listTree).mockResolvedValue(tree);
  return reg.reconcile(input);
}
