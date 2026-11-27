// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupDialog } from "../GroupsPanel";

const api = vi.hoisted(() => ({
  createGroup: vi.fn(), listGroups: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  groupHeld: vi.fn(), groupLetDecide: vi.fn(), addGroupMembers: vi.fn(),
}));
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api, getServerUrl: () => "http://test.invalid" } }));
// No vault folder on this computer: step 2 shows a line instead of the board.
vi.mock("../../lib/sync/docSession", () => ({ syncManager: { registry: { vaultId: null }, retryHeldRegistrations: vi.fn() } }));
vi.mock("../FileTree", () => ({ iconForPath: () => null }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});

const person = (userId: string, name: string) => ({
  userId, memberId: `m-${userId}`, role: "member" as const, name, email: `${userId}@team.test`, image: null, joinedAt: null, lastActiveAt: null,
});
const draft = { id: "g1", name: "Sales", color: null, autoJoin: false, memberIds: [], invited: [], grants: [] };

describe("New access group: two steps, created only at the end", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    api.createGroup.mockResolvedValue({ id: "g1" });
    api.listGroups.mockResolvedValue({ groups: [draft], canManage: true });
    api.addGroupMembers.mockResolvedValue({ added: 2 });
    api.deleteGroup.mockResolvedValue(undefined);
    api.groupLetDecide.mockResolvedValue([]);
    api.updateGroup.mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

  const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
  const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  const open = async (onSaved = vi.fn(), onClose = vi.fn()) => {
    await act(async () => root.render(createElement(GroupDialog, {
      orgId: "org-1", groups: [], candidates: [person("sam", "Sam"), person("abe", "Abe")], onClose, onSaved,
    })));
    const input = document.body.querySelector<HTMLInputElement>(".group-name-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Sales");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const box of document.body.querySelectorAll<HTMLInputElement>('.group-picker-list input[type="checkbox"]')) {
      await act(async () => box.click());
    }
    return { onSaved, onClose };
  };

  it("Next makes the group with nobody in it; step 2 keeps the same large dialog", async () => {
    await open();
    expect(document.body.querySelector(".group-picker-list.is-grid")).not.toBeNull();
    expect(document.body.querySelector(".modal.group-dialog.is-wizard")).not.toBeNull();
    await act(async () => button("Next").click());
    await settle();
    expect(api.createGroup).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Sales", memberIds: [], autoJoin: false }));
    expect(document.body.querySelector(".wizard-step.is-current")?.textContent).toBe("2Access");
    expect(document.body.querySelector(".modal.group-dialog.is-wizard")).not.toBeNull();
    expect(api.addGroupMembers).not.toHaveBeenCalled();
  });

  it("Create asks about people whose own setting differs; Keep their own adds them and changes nothing else", async () => {
    api.groupHeld.mockResolvedValue([
      { userId: "sam", resourceType: "vault", resourceId: "org-1", current: "edit", groupGives: "none", ownAt: "here", ownPlace: { resourceType: "vault", resourceId: "org-1" } },
    ]);
    const { onSaved } = await open();
    await act(async () => button("Next").click());
    await settle();
    await act(async () => button("Create with 2 people").click());
    await settle();
    expect(api.groupHeld).toHaveBeenCalledWith("org-1", "g1", { addUserIds: ["sam", "abe"] });
    // Step 3 in the same dialog, not a dialog on top.
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    const dialog = document.body.querySelector(".modal.group-dialog.is-wizard")!;
    expect(dialog.querySelector(".wizard-step.is-current")?.textContent).toBe("3Their own settings");
    expect(dialog.textContent).toContain("Keep theirs, or use the group's?");
    // One row per person, Keep their own by default; opening it lists the places.
    expect(dialog.textContent).toContain("Keeps their own on 1 place");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Use Sales\'s for Sam"]')!.checked).toBe(false);
    expect(dialog.textContent).toContain("Whole vault");
    await act(async () => button("Create with 2 people").click());
    await settle();
    expect(api.addGroupMembers).toHaveBeenCalledWith("org-1", "g1", ["sam", "abe"]);
    expect(api.groupLetDecide).not.toHaveBeenCalled();
    expect(api.deleteGroup).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith("g1");
  });

  it("Use the group's for someone applies only to them", async () => {
    api.groupHeld.mockResolvedValue([
      { userId: "sam", resourceType: "vault", resourceId: "org-1", current: "edit", groupGives: "none", ownAt: "here", ownPlace: { resourceType: "vault", resourceId: "org-1" } },
    ]);
    await open();
    await act(async () => button("Next").click());
    await settle();
    await act(async () => button("Create with 2 people").click());
    await settle();
    const sw = document.body.querySelector<HTMLElement>('[aria-label="Use Sales\'s for Sam"]')!;
    await act(async () => sw.click());
    expect(document.body.textContent).toContain("Gets Sales's on 1 place");
    expect(document.body.textContent).toContain("Their own whole-vault level is removed");
    await act(async () => button("Create with 2 people").click());
    await settle();
    expect(api.groupLetDecide).toHaveBeenCalledWith("org-1", "g1", [{ userId: "sam", resourceType: "vault", resourceId: "org-1" }]);
  });

  it("Select all ticks every card; the count follows", async () => {
    await act(async () => root.render(createElement(GroupDialog, {
      orgId: "org-1", groups: [], candidates: [person("sam", "Sam"), person("abe", "Abe")], onClose: vi.fn(), onSaved: vi.fn(),
    })));
    const all = document.body.querySelector<HTMLInputElement>(".group-picker-all input")!;
    expect(document.body.textContent).toContain("0 of 2 selected");
    await act(async () => all.click());
    expect(document.body.textContent).toContain("2 of 2 selected");
    expect([...document.body.querySelectorAll<HTMLInputElement>(".group-picker-list input")].every((b) => b.checked)).toBe(true);
  });

  it("no name and nobody picked is fine: it becomes the next free Group N, with nobody in it", async () => {
    const onSaved = vi.fn();
    await act(async () => root.render(createElement(GroupDialog, {
      orgId: "org-1", groups: [{ ...draft, id: "x", name: "Group 1" }] as never, candidates: [person("sam", "Sam")], onClose: vi.fn(), onSaved,
    })));
    expect(document.body.querySelector<HTMLInputElement>(".group-name-input")!.placeholder).toBe("Group 2");
    await act(async () => button("Next").click());
    await settle();
    expect(api.createGroup).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Group 2", memberIds: [] }));
    await act(async () => button("Create access group").click());
    await settle();
    expect(api.groupHeld).not.toHaveBeenCalled();
    expect(api.addGroupMembers).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith("g1");
  });

  it("Cancel on step 2 deletes the group: nothing was created for anyone", async () => {
    const { onClose, onSaved } = await open();
    await act(async () => button("Next").click());
    await settle();
    await act(async () => button("Cancel").click());
    await settle();
    expect(api.deleteGroup).toHaveBeenCalledWith("org-1", "g1");
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.addGroupMembers).not.toHaveBeenCalled();
  });
});
