// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
// A drag must not re-render the board's rows: the ghost moves by hand and the
// column highlight is the only state that changes, so memoised rows bail out.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberAccessBoard, boardRowRenders } from "../MemberAccessBoard";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(),
  resetMemberAccess: vi.fn(),
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

describe("Member access board renders", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.setItem("context.accessBoard.dragHintShown", "1");
    const notes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, relPath: `Note ${i}.md` }));
    api.listAccessTree.mockResolvedValue({ folders: [], notes });
    api.resolveAccessSummaries.mockImplementation(async (_o: string, groups: Array<Array<{ resourceId: string }>>) =>
      groups.map((g) => (Number(g[0].resourceId.slice(1)) % 2 === 0 ? "open" : "readonly")));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("re-renders no rows while the pointer crosses columns mid-drag", async () => {
    await act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "open", personVaultMode: "custom", onItemWritten: vi.fn(), onChanged: vi.fn(),
    } as never)));
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    const column = (mode: string) => host.querySelector<HTMLElement>(`.access-board-column[data-mode="${mode}"]`)!;
    expect(column("open").querySelectorAll(".access-board-row")).toHaveLength(30);
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    let under: Element = column("open");
    const original = document.elementFromPoint;
    document.elementFromPoint = () => under;
    try {
      const source = column("open").querySelector<HTMLElement>(".access-board-row")!;
      await act(async () => { pointer("pointerdown", source, 10, 10); });
      await act(async () => { pointer("pointermove", window, 60, 10); });
      expect(document.querySelector(".access-board-ghost")).not.toBeNull();
      const start = boardRowRenders.count;
      // Over another column, then a third, then many moves within one column.
      under = column("readonly");
      await act(async () => { pointer("pointermove", window, 400, 10); });
      expect(column("readonly").classList.contains("is-over")).toBe(true);
      under = column("private");
      await act(async () => { pointer("pointermove", window, 700, 10); });
      for (let x = 701; x < 720; x++) await act(async () => { pointer("pointermove", window, x, 10); });
      expect(boardRowRenders.count - start).toBe(0);
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    } finally {
      document.elementFromPoint = original;
    }
  });
});
