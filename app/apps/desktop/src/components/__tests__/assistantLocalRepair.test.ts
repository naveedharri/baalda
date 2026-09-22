// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AssistantLocalRepair } from "../AssistantLocalRepair";
import type { VaultHealthSnapshot } from "../../lib/health/types";
const env = vi.hoisted(() => ({ state: { vault: { path: "/vault", epoch: 1 }, serverUrl: "local", session: { user: { id: "user" } }, docIdByPath: { "Big.md": "doc" }, titles: [] }, status: vi.fn(), checks: vi.fn(), pick: vi.fn(), copy: vi.fn() }));
vi.mock("../../store", () => ({ useStore: { getState: () => env.state } }));
vi.mock("../../lib/sync/docSession", () => ({ syncManager: { registry: { vaultId: "vault" } } }));
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api: { housekeeperStatus: env.status } } }));
vi.mock("../../lib/ipc", () => ({ vaultChecks: env.checks, pickFolder: env.pick, exportPath: env.copy }));
const finding = { id: "oversized-notes", count: 1, items: [{ path: "Big.md", docId: "doc", bytes: 11000000 }] };
let root: Root; let host: HTMLDivElement;
let snapshot: VaultHealthSnapshot;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); env.state.vault = { path: "/vault", epoch: 1 };
  env.status.mockResolvedValue({ available: true }); env.checks.mockResolvedValue({ results: [finding] }); env.pick.mockResolvedValue("/backup");
  snapshot = { checks: { results: [finding] }, report: { issues: [] }, actions: {}, refresh: vi.fn() } as unknown as VaultHealthSnapshot;
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
async function render() { await act(async () => root.render(createElement(AssistantLocalRepair, { id: finding.id, snapshot, onClose: vi.fn() }))); }
async function apply() { await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.includes("Save copies"))!.click()); }
it("previews exact files and only copies after approval with the original epoch", async () => {
  await render(); expect(host.textContent).toContain("Big.md"); expect(env.copy).not.toHaveBeenCalled();
  await apply();
  expect(env.checks).toHaveBeenCalledWith({ doc: "Big.md" }, 1);
  expect(env.copy).toHaveBeenCalledWith("Big.md", "/backup/Big.md", 1);
  expect(host.textContent).toContain("Saved 1 of 1");
});
it("refuses a changed finding before opening a destination picker", async () => {
  await render(); env.checks.mockResolvedValue({ results: [{ ...finding, count: 0, items: [] }] });
  await apply(); expect(env.pick).not.toHaveBeenCalled(); expect(host.textContent).toContain("finding changed");
});
it("never exports another vault if the user switches while the picker is open", async () => {
  await render(); env.pick.mockImplementation(async () => { env.state.vault = { path: "/other", epoch: 2 }; return "/backup"; });
  await apply(); expect(env.copy).not.toHaveBeenCalled();
});
it("rechecks Pro before executing a prepared action", async () => {
  await render(); env.status.mockResolvedValue({ available: false }); await apply();
  expect(env.copy).not.toHaveBeenCalled(); expect(env.pick).not.toHaveBeenCalled();
});
