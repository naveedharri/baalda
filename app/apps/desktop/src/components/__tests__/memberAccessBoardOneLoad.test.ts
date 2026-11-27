// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMembersAccessCaches } from "../../lib/membersAccessCaches";
import { MemberAccessBoard } from "../MemberAccessBoard";
import { forgetServerFeatures } from "../../lib/serverFeatures";
import { forgetAccessBoardSupport } from "../../lib/accessBoardLoad";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(),
  resetMemberAccess: vi.fn(), getAccessBoard: vi.fn(), getHealth: vi.fn(), getBaseUrl: vi.fn(() => "http://test.invalid"),
  groupHeld: vi.fn(async () => []), groupLetDecide: vi.fn(async () => []),
}));
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api, getServerUrl: () => "http://test.invalid" } }));
vi.mock("../FileTree", () => ({ iconForPath: () => null }));
vi.mock("../../lib/sync/docSession", () => ({ syncManager: { registry: { vaultId: "v1" } } }));
vi.mock("../../lib/sync/selfAccessChanges", () => ({ markSelfAccessChange: vi.fn() }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({ locks: [], tree: null })) };
});

const member = {
  userId: "u2", memberId: "m2", role: "member" as const, name: "Sara Khan", email: "sara@team.test",
  image: null, joinedAt: null, lastActiveAt: null, access: { level: "custom" as const },
};

const tree = {
  folders: [{ id: "f1", path: "Specs", color: null }],
  notes: [
    { id: "n1", relPath: "Specs/API.md" },
    { id: "n2", relPath: "Welcome.md" },
    { id: "n3", relPath: "Roadmap.md" },
  ],
  files: [],
};

describe("Access board, one request", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    resetMembersAccessCaches();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    forgetServerFeatures();
    forgetAccessBoardSupport();
    window.localStorage.setItem("context.accessBoard.dragHintShown", "1");
    api.getHealth.mockResolvedValue({ ok: true, features: ["access-board"] });
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "eevn", complete: true });
    api.listAccessTree.mockResolvedValue(tree);
    api.resolveAccessSummaries.mockImplementation(async (_o: string, groups: unknown[]) => groups.map(() => "open"));
    api.setBulkAccess.mockResolvedValue({ mode: "readonly", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    resetMembersAccessCaches();
    act(() => root.unmount());
    host.remove();
  });

  const render = () => act(async () => root.render(createElement(MemberAccessBoard, {
    orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
    everyoneMode: "open", personVaultMode: "custom", onItemWritten: vi.fn(), onChanged: vi.fn(async () => {}),
  } as never)));
  const settle = async () => {
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  };
  const count = (mode: string) =>
    host.querySelector(`.access-board-column[data-mode="${mode}"] .access-board-count`)?.textContent;
  const waitForColumns = async () => {
    for (let i = 0; i < 20 && !host.querySelector(".access-board-column"); i++) {
      await act(async () => { await Promise.resolve(); });
    }
  };

  it("the third column is always No access, whether or not anything is set", async () => {
    const renderPerson = () => act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "private", personVaultMode: "custom", accessSource: "group",
      onItemWritten: vi.fn(), onChanged: vi.fn(async () => {}),
    } as never)));
    const third = () => host.querySelector<HTMLElement>('.access-board-column[data-mode="private"]')!;
    // Nothing gives them anything and nothing is set: still No access.
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "nnnn", complete: true });
    await renderPerson();
    await waitForColumns();
    await settle();
    expect(third().textContent).toContain("No access");
    expect(third().textContent).not.toContain("Not shared");
    // A group gives them something: the rest is No access.
    act(() => root.unmount());
    resetMembersAccessCaches();
    root = createRoot(host);
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "vvnn", complete: true });
    await renderPerson();
    await waitForColumns();
    await settle();
    expect(third().textContent).toContain("No access");
  });

  it("a group's board moves a row below the group's whole-vault Can edit (its deepest row decides)", async () => {
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "eeee", complete: true });
    await act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "open", personVaultMode: "custom", onItemWritten: vi.fn(), onChanged: vi.fn(async () => {}),
      group: { id: "g1", name: "Everyone", grants: [{ resourceType: "vault", permission: "edit", path: null }], includesMe: false },
    } as never)));
    await waitForColumns();
    await settle();
    const arrow = host.querySelector<HTMLButtonElement>('button[aria-label="Move Welcome right"]');
    expect(arrow).not.toBeNull();
    await act(async () => arrow!.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toEqual({
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "group", groupId: "g1" },
      mode: "readonly",
    });
  });

  it("on a group's board a row moved to No access asks first; Can view does not", async () => {
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "eeee", complete: true });
    await act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "open", personVaultMode: "custom", onItemWritten: vi.fn(), onChanged: vi.fn(async () => {}),
      group: { id: "g1", name: "Everyone", grants: [{ resourceType: "vault", permission: "view", path: null }], includesMe: false },
    } as never)));
    await waitForColumns();
    await settle();
    // Welcome: Can edit → Can view → No access.
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Move Welcome right"]')!.click());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Move Welcome right"]')!.click());
    const d = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(d?.textContent).toContain("Remove what Everyone gives on Welcome?");
    expect(d?.textContent).toContain("leaves their computers");
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    await act(async () => [...d!.querySelectorAll("button")].find((b) => b.textContent === "Remove")!.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(2);
    expect(api.setBulkAccess.mock.calls[1][1]).toMatchObject({ audience: { type: "group", groupId: "g1" }, mode: "private" });
  });

  it("No access → Add all on a group that opens the whole vault says what leaves people's computers (no Set everything to)", async () => {
    api.getAccessBoard.mockResolvedValue({ ...tree, modes: "eeee", complete: true });
    const renderGroup = (vaultPermission: "edit" | null) => act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "open", personVaultMode: "open", onItemWritten: vi.fn(), onChanged: vi.fn(async () => {}),
      group: { id: "g1", name: "Everyone", includesMe: false,
        grants: vaultPermission ? [{ resourceType: "vault", permission: vaultPermission, path: null }] : [{ resourceType: "folder", permission: "edit", path: "Specs" }] },
    } as never)));
    const noAccess = async () => {
      expect(host.querySelector('button[aria-label="Set everything to"]')).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="No access actions"]')!.click());
      const none = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith("Add all"))!;
      await act(async () => none.click());
      return document.querySelector<HTMLElement>('[role="alertdialog"]');
    };
    await renderGroup("edit");
    await waitForColumns();
    await settle();
    const d1 = await noAccess();
    expect(d1?.textContent).toContain("Everyone opens the whole vault");
    expect(d1?.textContent).toContain("what Everyone gave everywhere leaves their computers, notes they wrote included");
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    // A group that opens only some folders keeps the plain copy.
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => /keep|cancel/i.test(b.textContent ?? ""))?.click());
    await renderGroup(null);
    await settle();
    const d2 = await noAccess();
    expect(d2?.textContent).toContain("Only what Everyone gave everywhere goes");
    expect(d2?.textContent).not.toContain("opens the whole vault");
  });

  it("a group removal confirm says when the person clicking loses it too", async () => {
    const { groupRemoveCopy } = await import("../MemberAccessBoard");
    expect(groupRemoveCopy("Everyone", "on HR", true, true).outcome).toContain("Its members, you included, keep only their own access");
    expect(groupRemoveCopy("Design", "on HR", false, true).outcome).toContain("Members of Design, you included, keep");
    expect(groupRemoveCopy("Design", "on HR").outcome).toBe("Members of Design keep their own access and what other groups give. Only what Design gave on HR goes.");
  });

  it("fills the tree and every count from one access-board call, with no summary reads", async () => {
    await render();
    await waitForColumns();
    // The first frame with columns already has final counts.
    expect(count("open")).toBe("2");
    expect(count("readonly")).toBe("1");
    expect(count("private")).toBe("1");
    await settle();
    expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
    expect(api.listAccessTree).not.toHaveBeenCalled();
    expect(api.resolveAccessSummaries).not.toHaveBeenCalled();
    expect(api.resolveAccessSummary).not.toHaveBeenCalled();
  });

  it("without the feature, loads the tree and reads summaries as before", async () => {
    api.getHealth.mockResolvedValue({ ok: true, features: [] });
    await render();
    await settle();
    expect(api.getAccessBoard).not.toHaveBeenCalled();
    expect(api.listAccessTree).toHaveBeenCalledTimes(1);
    expect(api.resolveAccessSummaries).toHaveBeenCalled();
  });

  it("a 404 from access-board falls back to the tree and summaries", async () => {
    api.getAccessBoard.mockResolvedValue(null);
    await render();
    await settle();
    expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
    expect(api.listAccessTree).toHaveBeenCalledTimes(1);
    expect(api.resolveAccessSummaries).toHaveBeenCalled();
  });

  it("a write touching more than 200 rows reloads the map once instead of reading summaries", async () => {
    const notes = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, relPath: `Specs/N${i}.md` }));
    const big = { folders: [{ id: "f1", path: "Specs", color: null }], notes, files: [] };
    api.getAccessBoard.mockResolvedValue({ ...big, modes: "e".repeat(251), complete: true });
    await render();
    await settle();
    expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
    api.getAccessBoard.mockResolvedValue({ ...big, modes: "v".repeat(251), complete: true });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Can view actions"]')!.click());
    const addAll = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((li) => li.textContent?.startsWith("Add all"))!;
    await act(async () => addAll.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.getAccessBoard).toHaveBeenCalledTimes(2);
    expect(api.resolveAccessSummaries).not.toHaveBeenCalled();
    expect(count("readonly")).toBe("251");
  });

  it("a small move keeps re-reading only the affected rows", async () => {
    await render();
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Move Welcome left"]')!.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
    expect(api.resolveAccessSummaries).toHaveBeenCalled();
  });
});
