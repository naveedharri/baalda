// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMembersAccessCaches } from "../../lib/membersAccessCaches";
import { MemberProfilePage } from "../MemberProfilePage";
import { useStore } from "../../store";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(), getMemberActivity: vi.fn(),
}));
vi.mock("../../lib/auth/authManager", () => ({
  authManager: { api, getServerUrl: () => "http://test.invalid" },
}));
vi.mock("../../lib/sync/docSession", () => ({
  syncManager: { registry: { vaultId: "v1" }, retryHeldRegistrations: vi.fn() },
}));
vi.mock("../FileTree", () => ({ iconForPath: () => null }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});

const member = {
  userId: "u2", memberId: "m2", role: "member" as const, name: "Sara Khan", email: "sara@team.test",
  image: null, joinedAt: null, lastActiveAt: null, access: { level: "custom" as const },
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Member profile skeletons", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    resetMembersAccessCaches();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    (useStore as unknown as { setState: (s: Record<string, unknown>) => void }).setState({ locks: [], denies: [], tree: null });
    api.resolveAccessSummaries.mockImplementation(async (_o: string, groups: unknown[][]) => groups.map(() => "open"));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    resetMembersAccessCaches();
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });
  async function render(initialTab: "info" | "access" | "activity") {
    await act(async () => root.render(createElement(MemberProfilePage, {
      orgId: "org-1", vaultName: "Product team", member, initialTab, canAct: true, canSetAccess: true, present: false,
      teamAccess: { mode: "open", posture: "edit", grantId: "g", overrides: [] },
      onClose: vi.fn(), onChanged: vi.fn(async () => {}), onItemWritten: vi.fn(), onRoleChange: vi.fn(), onRemove: vi.fn(),
    } as never)));
  }
  const skeletons = () => host.querySelectorAll(".skel-line").length;
  const spinners = () => host.querySelectorAll(".spinner, [class*=spinner]").length;

  it("Personal info never shows a skeleton: the member is already loaded", async () => {
    await render("info");
    expect(skeletons()).toBe(0);
    expect(host.textContent).toContain("sara@team.test");
  });

  it("Activity shows skeleton rows until the events arrive, then none", async () => {
    const d = deferred<unknown[]>();
    api.getMemberActivity.mockReturnValue(d.promise);
    await render("activity");
    expect(host.querySelectorAll(".member-skel-activity .member-activity-entry")).toHaveLength(7);
    expect(spinners()).toBe(0);
    await act(async () => d.resolve([]));
    expect(skeletons()).toBe(0);
    expect(host.textContent).toContain("No activity yet.");
  });

  it("Board view shows three skeleton columns until the tree arrives", async () => {
    localStorage.setItem("context.memberAccess.view", "board");
    const d = deferred<unknown>();
    api.listAccessTree.mockReturnValue(d.promise);
    await render("access");
    const cols = [...host.querySelectorAll(".member-skel-board .access-board-column")];
    expect(cols.map((c) => c.querySelector(".access-board-column-title")?.textContent)).toEqual(["Can edit", "Can view", "No access"]);
    for (const c of cols) expect(c.querySelectorAll(".member-skel-board-row").length).toBeGreaterThanOrEqual(4);
    expect(spinners()).toBe(0);
    await act(async () => d.resolve({ folders: [{ id: "f1", path: "Specs" }], notes: [] }));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(host.querySelector(".member-skel-board")).toBeNull();
    expect(host.querySelector(".member-skel-pending")).toBeNull();
  });

  it("List view shows skeleton tree rows until the tree arrives", async () => {
    localStorage.setItem("context.memberAccess.view", "list");
    const d = deferred<unknown>();
    api.listAccessTree.mockReturnValue(d.promise);
    await render("access");
    expect(host.querySelectorAll(".member-skel-tree .member-access-row")).toHaveLength(6);
    expect(spinners()).toBe(0);
    await act(async () => d.resolve({ folders: [{ id: "f1", path: "Specs" }], notes: [] }));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(host.querySelector(".member-skel-tree")).toBeNull();
    expect(skeletons()).toBe(0);
  });

  it("a failed tree load shows the error, not a skeleton", async () => {
    localStorage.setItem("context.memberAccess.view", "list");
    api.listAccessTree.mockRejectedValue(new Error("down"));
    await render("access");
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(host.querySelector(".member-skel-tree")).toBeNull();
    expect(host.textContent).toContain("Couldn't load this vault's folders.");
  });
});
