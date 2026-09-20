// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessPanel } from "../AccessPanel";
import { useStore } from "../../store";

const api = vi.hoisted(() => ({
  getTeamAccess: vi.fn(), listAccessTree: vi.fn(), getAccessDefault: vi.fn(),
  resolveAccessSummary: vi.fn(), setBulkAccess: vi.fn(),
}));
vi.mock("../../lib/auth/authManager", () => ({
  authManager: { api, getServerUrl: () => "http://test.invalid" },
}));
vi.mock("../../lib/sync/docSession", () => ({
  syncManager: { registry: { vaultId: "v1" } },
}));
vi.mock("../FileTree", () => ({ iconForPath: () => null }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});

const patchStore = (state: Record<string, unknown>) =>
  (useStore as unknown as { setState: (state: Record<string, unknown>) => void }).setState(state);

describe("Access panel during sync and permission changes", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({
      session: { activeOrganizationId: "org-1", user: { id: "u1" } },
      members: [{ userId: "u1", user: { name: "Member" } }],
      locks: [], denies: [], tree: null, syncEnabled: true,
      refreshLocks: vi.fn().mockResolvedValue(undefined),
    });
    api.getTeamAccess.mockResolvedValue({ mode: "open", grantId: null, overrides: [] });
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "folder", path: "Projects" }],
      notes: Array.from({ length: 1100 }, (_, i) => ({ id: `n${i}`, relPath: `Projects/${i}.md` })),
    });
    api.getAccessDefault.mockResolvedValue({ mode: "open" });
    api.resolveAccessSummary.mockResolvedValue({ mode: "open" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  async function render() {
    await act(async () => root.render(createElement(AccessPanel, { canManage: true })));
  }
  async function click(element: Element | null) {
    expect(element).not.toBeNull();
    await act(async () => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }
  const button = (label: string) => [...host.querySelectorAll("button")]
    .find((node) => node.textContent === label) ?? null;

  it("keeps a person's current mode stable through unrelated download batches", async () => {
    await render();
    await click(host.querySelector(".access-vault-row input"));
    await click(button("Specific people"));
    await click(host.querySelector(".access-member-choice input"));
    expect(api.resolveAccessSummary).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) {
      await act(async () => patchStore({ tree: { path: "", isDir: true, children: [], name: `batch-${i}` } }));
    }
    expect(api.resolveAccessSummary).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-mode="open"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("applies select-all as one folder and refreshes access without refetching structure", async () => {
    await render();
    await click(button("Select all items"));
    api.setBulkAccess.mockImplementation(async () => {
      api.getTeamAccess.mockResolvedValue({ mode: "open", overrides: [{ resourceId: "folder", permission: "denied" }] });
      return { mode: "private", resourcesChanged: 1, overridesCleared: 0 };
    });
    await click(host.querySelector('[data-mode="private"]'));
    await click(button("Set Private"));
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "folder", resourceId: "folder" }],
      audience: { type: "org" }, mode: "private",
    });
    expect(api.listAccessTree).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-mode="private"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});
