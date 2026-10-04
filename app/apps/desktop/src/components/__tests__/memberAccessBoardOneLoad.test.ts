// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberAccessBoard } from "../MemberAccessBoard";
import { forgetServerFeatures } from "../../lib/serverFeatures";
import { forgetAccessBoardSupport } from "../../lib/accessBoardLoad";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(),
  resetMemberAccess: vi.fn(), getAccessBoard: vi.fn(), getHealth: vi.fn(), getBaseUrl: vi.fn(() => "http://test.invalid"),
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
