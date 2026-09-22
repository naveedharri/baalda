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
    expect(api.resolveAccessSummary).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 4; i++) {
      await act(async () => patchStore({ tree: { path: "", isDir: true, children: [], name: `batch-${i}` } }));
    }
    expect(api.resolveAccessSummary).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[data-mode="open"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  async function viewPerson(name: string) {
    await click(host.querySelector('[aria-label="View access for"]'));
    await click([...document.querySelectorAll('[role="menuitemradio"]')]
      .find((node) => node.textContent?.includes(name)) ?? null);
  }

  it("shows a person's resolved row access before any items are selected", async () => {
    api.listAccessTree.mockResolvedValue({ folders: [], notes: [{ id: "n1", relPath: "Note.md" }] });
    api.resolveAccessSummary.mockImplementation(async (_org, resources) => ({
      mode: resources[0].resourceType === "vault" ? "mixed" : "private",
    }));
    await render();
    await viewPerson("Member");
    expect(host.querySelector(".access-vault-row .access-badge")?.textContent).toBe("Mixed");
    expect(host.querySelector(".access-item .access-badge")?.textContent).toBe("Private");
    expect(host.querySelector(".access-bulk-card")).toBeNull();
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    await click(host.querySelector(".access-item input"));
    expect(host.querySelector(".access-member-choice input")?.getAttribute("checked")).not.toBeNull();
    await viewPerson("Everyone");
    expect(host.querySelector(".access-item .access-badge")?.textContent).toBe("Shared");
  });

  it("discards stale person responses and never substitutes team access on failure", async () => {
    patchStore({ members: [
      { userId: "u1", user: { name: "Alice" } },
      { userId: "u2", user: { name: "Bob" } },
    ] });
    api.listAccessTree.mockResolvedValue({ folders: [], notes: [{ id: "n1", relPath: "Note.md" }] });
    const oldResponses: Array<(value: { mode: string }) => void> = [];
    api.resolveAccessSummary.mockImplementation((_org, _resources, users) => users[0] === "u1"
      ? new Promise((resolve) => oldResponses.push(resolve))
      : Promise.reject(new Error("offline")));
    await render();
    await viewPerson("Alice");
    expect(host.querySelector(".access-item [aria-label='Loading access']")).not.toBeNull();
    await viewPerson("Bob");
    await act(async () => oldResponses.forEach((resolve) => resolve({ mode: "open" })));
    expect(host.querySelector(".access-item .access-badge")?.textContent).toBe("Unavailable");
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
