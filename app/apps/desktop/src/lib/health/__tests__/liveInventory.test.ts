// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVaultHealth } from "../useVaultHealth";
import { useStore } from "../../../store";
import * as ipc from "../../ipc";
import { authManager } from "../../auth/authManager";
import type { VaultHealthSnapshot } from "../types";

vi.mock("../../auth/authManager", () => ({ authManager: { api: { listAccessTree: vi.fn(), vaultStorage: vi.fn() } } }));
vi.mock("../../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});
vi.mock("../../ipc", () => ({ vaultStats: vi.fn(), vaultChecks: vi.fn(), listTree: vi.fn() }));
vi.mock("../../sync/docSession", () => ({ syncManager: {
  registry: { healthInventory: () => null },
  syncFailures: () => ({ registry: [], content: [], limitCode: null }),
  syncLog: () => [], onSyncLog: () => () => {},
} }));
vi.mock("../model", () => ({ buildHealthReport: () => ({ verdict: "syncing", issues: [] }) }));

const patch = (state: Record<string, unknown>) =>
  (useStore as unknown as { setState: (state: Record<string, unknown>) => void }).setState(state);
let root: Root;
let host: HTMLDivElement;
let snapshot: VaultHealthSnapshot;
function Probe() { snapshot = useVaultHealth(); return null; }
const tree = (count: number): ipc.TreeNode => ({ id: "root", path: "", name: "vault", isDir: true,
  children: Array.from({ length: count }, (_, i) => ({ id: String(i), path: `${i}.md`, name: `${i}.md`, isDir: false })) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  patch({ vault: { path: "/vault", epoch: 1 }, syncEnabled: true, vaultSyncStatus: "connected",
    syncProgress: { phase: "downloading", done: 1, total: 100 }, docIdByPath: {},
    docSyncState: {}, titles: [], members: [] });
  vi.mocked(ipc.vaultStats).mockResolvedValue({ attachments: { count: 0 }, notes: { bytes: 10 } } as never);
  vi.mocked(ipc.vaultChecks).mockResolvedValue({} as never);
  vi.mocked(ipc.listTree).mockResolvedValue(tree(3));
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it("updates local counts during download and removal without a manual refresh or repeated integrity scans", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(snapshot.inventory.local.notes).toBe(3);
  expect(ipc.vaultChecks).not.toHaveBeenCalled();
  vi.mocked(ipc.listTree).mockResolvedValue(tree(8));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(snapshot.inventory.local.notes).toBe(8);
  await act(async () => patch({ syncProgress: { phase: "removing", done: 1, total: 8 }, docIdByPath: { "1.md": "id" } }));
  expect(ipc.listTree).toHaveBeenCalledTimes(2);
  vi.mocked(ipc.listTree).mockResolvedValue(tree(2));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(snapshot.inventory.local.notes).toBe(2);
  expect(ipc.vaultChecks).not.toHaveBeenCalled();
  await act(async () => patch({ syncProgress: null }));
  expect(ipc.vaultChecks).toHaveBeenCalledTimes(1);
  const reads = vi.mocked(ipc.listTree).mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(ipc.listTree).toHaveBeenCalledTimes(reads);
});

it("does not overlap slow samples and discards a previous vault's response", async () => {
  let finish!: (value: ipc.TreeNode) => void;
  vi.mocked(ipc.listTree).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(ipc.listTree).toHaveBeenCalledTimes(1);
  await act(async () => patch({ vault: { path: "/other", epoch: 2 } }));
  expect(snapshot.inventory.local.notes).toBe(3);
  await act(async () => finish(tree(99)));
  expect(snapshot.inventory.local.notes).toBe(3);
});


it("uses admin storage paths for missing-server checks without downloading private notes", async () => {
  patch({ session: { user: { id: "owner" } }, members: [{ userId: "owner", role: "owner" }] });
  const { syncManager } = await import("../../sync/docSession");
  Object.assign(syncManager.registry, { vaultId: "v1", healthInventory: () => ({
    hasServerVault: true, notePaths: [], folderPaths: [], filePaths: [],
  }) });
  vi.mocked(authManager.api.listAccessTree).mockResolvedValue({
    notes: [{ id: "n0", relPath: "0.md" }, { id: "n1", relPath: "1.md" }], folders: [], files: [],
  });
  await act(async () => root.render(createElement(Probe)));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(snapshot.inventory.serverStored?.notes).toBe(2);
  expect(snapshot.inventory.server?.notes).toBe(0);
  expect(snapshot.inventory.deviceOnlyNotes).toEqual(["2.md"]);
  expect(snapshot.inventory.serverOnlyNotes).toEqual([]);
});

it("reads the Remote Vault's file storage and degrades to null when it fails", async () => {
  patch({ session: { user: { id: "owner" } }, members: [{ userId: "owner", role: "owner" }] });
  const { syncManager } = await import("../../sync/docSession");
  Object.assign(syncManager.registry, { vaultId: "v1", healthInventory: () => ({
    hasServerVault: true, notePaths: [], folderPaths: [], filePaths: [],
  }) });
  vi.mocked(authManager.api.listAccessTree).mockResolvedValue({ notes: [], folders: [], files: [] });
  vi.mocked(authManager.api.vaultStorage).mockResolvedValue({
    usedBytes: 2048, pendingBytes: 0, blobCount: 1, limitBytes: 1024 * 1024,
  });
  await act(async () => root.render(createElement(Probe)));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(authManager.api.vaultStorage).toHaveBeenCalledWith("v1");
  expect(snapshot.serverStorage).toEqual({ usedBytes: 2048, limitBytes: 1024 * 1024 });

  vi.mocked(authManager.api.vaultStorage).mockRejectedValue(new Error("offline"));
  await act(async () => snapshot.refresh());
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(snapshot.serverStorage).toBeNull();
});
