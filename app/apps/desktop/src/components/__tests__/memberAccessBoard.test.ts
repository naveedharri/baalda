// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberAccessBoard } from "../MemberAccessBoard";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(),
  resetMemberAccess: vi.fn(),
}));
vi.mock("../../lib/auth/authManager", () => ({
  authManager: { api, getServerUrl: () => "http://test.invalid" },
}));
vi.mock("../FileTree", () => ({ iconForPath: () => null }));
vi.mock("../../lib/sync/docSession", () => ({ syncManager: { registry: { vaultId: "v1" } } }));
const selfMark = vi.hoisted(() => vi.fn());
vi.mock("../../lib/sync/selfAccessChanges", () => ({ markSelfAccessChange: selfMark }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../lib/toast", () => ({ toast }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({ locks: [], tree: null })) };
});
import { useStore } from "../../store";
const patchStore = (state: Record<string, unknown>) =>
  (useStore as unknown as { setState: (state: Record<string, unknown>) => void }).setState(state);

const member = {
  userId: "u2", memberId: "m2", role: "member" as const, name: "Sara Khan", email: "sara@team.test",
  image: null, joinedAt: null, lastActiveAt: null, access: { level: "custom" as const },
};

/** Summary per resource id, as the server would answer for this person. */
let modes: Record<string, string> = {};

describe("Member access board", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onItemWritten: ReturnType<typeof vi.fn<() => void>>;
  let onChanged: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({ locks: [], tree: null });
    // The first-visit drag hint has its own test; keep it out of the others.
    window.localStorage.setItem("context.accessBoard.dragHintShown", "1");
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }],
      notes: [
        { id: "n1", relPath: "Specs/API.md" },
        { id: "n2", relPath: "Welcome.md" },
        { id: "n3", relPath: "Roadmap.md" },
      ],
    });
    modes = { f1: "open", n1: "open", n2: "readonly", n3: "private" };
    api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: Array<Array<{ resourceId: string }>>) =>
      groups.map((g) => modes[g[0].resourceId] ?? "private"));
    // The fake server applies a write, so the post-move re-read agrees.
    api.setBulkAccess.mockImplementation(async (_org: string, input: { resources: Array<{ resourceType: string; resourceId: string }>; mode: string }) => {
      for (const r of input.resources) {
        if (r.resourceType === "vault") for (const id of Object.keys(modes)) modes[id] = input.mode;
        else modes[r.resourceId] = input.mode;
      }
      return { mode: input.mode, resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 };
    });
    onItemWritten = vi.fn<() => void>();
    onChanged = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(extra: Record<string, unknown> = {}) {
    await act(async () => root.render(createElement(MemberAccessBoard, {
      orgId: "org-1", vaultId: "v1", member, isSelf: false, canSetAccess: true,
      everyoneMode: "open", personVaultMode: "custom", onItemWritten, onChanged, ...extra,
    } as never)));
    await settle();
  }
  async function settle() {
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  }
  const column = (mode: string) => host.querySelector<HTMLElement>(`.access-board-column[data-mode="${mode}"]`)!;
  const names = (mode: string, grey?: boolean) =>
    [...column(mode).querySelectorAll(`.access-board-row${grey === undefined ? "" : grey ? ".is-path" : ":not(.is-path)"}`)]
      .map((r) => r.querySelector(".access-board-name")?.textContent);
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const dialogButton = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!;

  const pointer = (type: string, target: EventTarget, x: number, y: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  const row = (mode: string, name: string) =>
    [...column(mode).querySelectorAll<HTMLElement>(".access-board-row")]
      .find((r) => r.querySelector(".access-board-name")?.textContent === name)!;

  it("sorts each row into the column of its level, with counts", async () => {
    await render();
    expect(names("open")).toEqual(["Specs", "API"]);
    expect(names("readonly")).toEqual(["Welcome"]);
    expect(names("private")).toEqual(["Roadmap"]);
    expect(column("open").querySelector(".access-board-count")?.textContent).toBe("2");
    expect(column("readonly").querySelector(".access-board-count")?.textContent).toBe("1");
  });

  it("an arrow is one bulk write for one resource and one user, then toasts", async () => {
    await render();
    await act(async () => button("Move Welcome left").click());
    await settle();
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "open",
    }, { timeoutMs: 30_000 });
    expect(onItemWritten).toHaveBeenCalledTimes(1);
    // Optimistic move.
    expect(names("open")).toContain("Welcome");
    expect(row("open", "Welcome").classList.contains("is-landing")).toBe(true);
    expect(toast).toHaveBeenCalledWith("Sara can now edit Welcome.");
    expect(host.querySelector(".access-board-undo")).toBeNull();
  });

  it("says so, in error style, when the server's re-read disagrees with the move", async () => {
    await render();
    // The write is accepted but the server still resolves Welcome as view only.
    api.setBulkAccess.mockResolvedValue({ mode: "open", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
    await act(async () => button("Move Welcome left").click());
    expect(api.setBulkAccess.mock.calls[0][1]).toEqual({
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "open",
    });
    // Optimistic first...
    expect(names("open")).toContain("Welcome");
    await settle();
    // ...then the truth.
    expect(names("readonly")).toContain("Welcome");
    expect(names("open")).not.toContain("Welcome");
    expect(toast).toHaveBeenCalledWith("Couldn't apply — Welcome is still Can view", "error");
    expect(toast).not.toHaveBeenCalledWith("Sara can now edit Welcome.");
  });

  /** The column as drawn, grey path rows marked with ~. */
  const drawn = (mode: string) =>
    [...column(mode).querySelectorAll<HTMLElement>(".access-board-list > li.access-board-row")]
      .map((li) => `${li.classList.contains("is-path") ? "~" : ""}${li.querySelector(".access-board-name")?.textContent}`);

  it("floats a moved row to the top of its level, newest first, with the landing pulse", async () => {
    await render();
    await act(async () => button("Move Welcome left").click());
    await settle();
    expect(drawn("open")).toEqual(["Welcome", "Specs", "API"]);
    expect(row("open", "Welcome").dataset.pulse).toBe("true");
    await act(async () => button("Move Roadmap left").click());
    await settle();
    await act(async () => button("Move Roadmap left").click());
    await settle();
    expect(drawn("open")).toEqual(["Roadmap", "Welcome", "Specs", "API"]);
    expect(row("open", "Roadmap").dataset.pulse).toBe("true");
    expect(row("open", "Welcome").dataset.pulse).toBeUndefined();
    expect(column("open").textContent).not.toContain("Recently moved");
    expect(column("open").querySelectorAll('[data-row-key="note:n2"]')).toHaveLength(1);
  });

  it("a moved nested row rises with its grey path, keeping the tree", async () => {
    await render();
    await act(async () => button("Move API right").click());
    await settle();
    expect(drawn("readonly")).toEqual(["~Specs", "API", "Welcome"]);
    expect(drawn("open")).toEqual(["Specs"]);
  });

  it("inside a folder, the moved child comes first", async () => {
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }],
      notes: [
        { id: "n1", relPath: "Specs/API.md" },
        { id: "n4", relPath: "Specs/Zeta.md" },
        { id: "n2", relPath: "Welcome.md" },
      ],
    });
    modes = { f1: "mixed", n1: "readonly", n4: "open", n2: "readonly" };
    await render();
    expect(drawn("readonly")).toEqual(["~Specs", "API", "Welcome"]);
    await act(async () => button("Move Zeta right").click());
    await settle();
    expect(drawn("readonly")).toEqual(["Specs", "Zeta", "API", "Welcome"]);
  });

  it("a row locked for everyone shows a lock, cannot go to Can edit, and says why", async () => {
    patchStore({
      locks: [{ id: "l1", resourceType: "file", resourceId: "n2", principalType: "org", principalId: "org-1", permission: "locked" }],
    });
    await render();
    const welcome = row("readonly", "Welcome");
    expect(welcome.querySelector(".access-board-lock")?.getAttribute("title"))
      .toBe("Locked for everyone — unlock it from the sidebar to allow editing");
    expect(button("Move Welcome left").disabled).toBe(true);
    expect(button("Move Welcome right").disabled).toBe(false);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => column("open");
    try {
      await act(async () => { pointer("pointerdown", welcome, 10, 10); });
      await act(async () => { pointer("pointermove", window, 50, 40); });
      await act(async () => { pointer("pointerup", window, 50, 40); });
    } finally {
      document.elementFromPoint = original;
    }
    await settle();
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Welcome is locked for everyone. Unlock it from the sidebar first.", "neutral");
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
    expect(names("readonly")).toContain("Welcome");
  });

  it("only a move to No access confirms: Set everything to → Can view and Add all apply at once", async () => {
    await render({ personVaultMode: "open" });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Set everything to"]')!.click());
    const view = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith("Can view"))!;
    await act(async () => view.click());
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({ resources: [{ resourceType: "vault", resourceId: "org-1" }], mode: "readonly" });
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Can view actions"]')!.click());
    const addAll = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith("Add all"))!;
    await act(async () => addAll.click());
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(2);
    await settle();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Set everything to"]')!.click());
    const none = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith("No access"))!;
    await act(async () => none.click());
    expect(dialog()).not.toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(2);
  });

  it("lowering one row writes at once, without a confirm, and toasts", async () => {
    await render();
    await act(async () => button("Move Welcome right").click());
    await settle();
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "private",
    });
    expect(names("private")).toContain("Welcome");
    expect(toast).toHaveBeenCalledWith("Sara can no longer open Welcome.");
  });

  it("grey ancestor rows show the path but are not interactive", async () => {
    modes = { f1: "open", n1: "readonly", n2: "readonly", n3: "private" };
    await render();
    expect(names("readonly", true)).toEqual(["Specs"]);
    expect(names("readonly", false)).toEqual(["API", "Welcome"]);
    const greyRow = column("readonly").querySelector<HTMLElement>(".access-board-row.is-path")!;
    expect(greyRow.querySelectorAll("button")).toHaveLength(0);
    expect(greyRow.getAttribute("data-movable")).toBeNull();
    // The folder itself still lives, interactive, in Can edit.
    expect(names("open", false)).toEqual(["Specs"]);
  });

  it("Set everything to → Can view writes the vault resource", async () => {
    await render({ personVaultMode: "private" });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Set everything to"]')!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((li) => li.textContent?.startsWith("Can view"))!;
    await act(async () => option.click());
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "vault", resourceId: "org-1" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "readonly",
    }, { timeoutMs: 30_000 });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("disables arrows and dragging without permission", async () => {
    await render({ canSetAccess: false });
    expect(button("Move Welcome left").disabled).toBe(true);
    expect(column("readonly").querySelector(".access-board-row")?.getAttribute("data-movable")).toBe("false");
  });

  it("drags a row with the pointer onto another column (even an empty one) and writes once", async () => {
    modes = { f1: "open", n1: "open", n2: "readonly", n3: "readonly" };
    await render();
    expect(column("private").querySelector(".access-board-empty")?.textContent).toBe("Nothing here");
    const target = column("private").querySelector(".access-board-empty")!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      await act(async () => { pointer("pointerdown", row("readonly", "Welcome"), 10, 10); });
      // Below the threshold: still a click, no ghost.
      await act(async () => { pointer("pointermove", window, 11, 11); });
      expect(document.querySelector(".access-board-ghost")).toBeNull();
      await act(async () => { pointer("pointermove", window, 400, 40); });
      expect(document.querySelector(".access-board-ghost")?.textContent).toContain("Welcome");
      expect(column("private").classList.contains("is-over")).toBe(true);
      expect(column("private").querySelector(".access-board-list > li:first-child")?.classList.contains("access-board-drop-line")).toBe(true);
      await act(async () => { pointer("pointerup", window, 400, 40); });
    } finally {
      document.elementFromPoint = original;
    }
    expect(document.querySelector(".access-board-ghost")).toBeNull();
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "private",
    });
    expect(row("private", "Welcome").classList.contains("is-landing")).toBe(true);
  });

  it("targets a column by its horizontal band, even below its card", async () => {
    modes = { f1: "open", n1: "open", n2: "readonly", n3: "readonly" };
    await render();
    const rect = (left: number, right: number, top: number, bottom: number) =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    host.querySelector<HTMLElement>(".access-board")!.getBoundingClientRect = () => rect(0, 900, 100, 400);
    column("open").getBoundingClientRect = () => rect(0, 290, 100, 400);
    column("readonly").getBoundingClientRect = () => rect(300, 590, 100, 200);
    column("private").getBoundingClientRect = () => rect(600, 890, 100, 150);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.body; // nothing under the pointer but empty space
    try {
      await act(async () => { pointer("pointerdown", row("readonly", "Welcome"), 320, 140); });
      // Far below the short No access card, inside its band.
      await act(async () => { pointer("pointermove", window, 700, 700); });
      expect(column("private").classList.contains("is-over")).toBe(true);
      expect(host.querySelector(".access-board")!.classList.contains("is-dragging")).toBe(true);
      await act(async () => { pointer("pointerup", window, 700, 700); });
    } finally {
      document.elementFromPoint = original;
    }
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1].mode).toBe("private");
  });

  it("nudges one real movable row once per device, and never again", async () => {
    window.localStorage.removeItem("context.accessBoard.dragHintShown");
    await render();
    expect(host.querySelector("[data-hint]")).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    const hinted = host.querySelector<HTMLElement>(".access-board-row[data-hint]");
    expect(hinted).not.toBeNull();
    expect(hinted!.classList.contains("is-path")).toBe(false);
    expect(hinted!.querySelector(".access-board-name")?.textContent).toBe("Specs");
    expect(hinted!.dataset.hint).toBe("right");
    expect(column("readonly").classList.contains("is-hint-target")).toBe(true);
    expect(window.localStorage.getItem("context.accessBoard.dragHintShown")).toBe("1");
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    // Any press cancels it at once.
    await act(async () => { pointer("pointerdown", document.body, 1, 1); });
    expect(host.querySelector("[data-hint]")).toBeNull();

    act(() => root.unmount());
    root = createRoot(host);
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    expect(host.querySelector("[data-hint]")).toBeNull();
  });

  it("a drag released outside any column, or cancelled with Escape, writes nothing", async () => {
    await render();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.body;
    try {
      await act(async () => { pointer("pointerdown", row("readonly", "Welcome"), 10, 10); });
      await act(async () => { pointer("pointermove", window, 400, 40); });
      await act(async () => { pointer("pointerup", window, 400, 40); });
      await act(async () => { pointer("pointerdown", row("readonly", "Welcome"), 10, 10); });
      await act(async () => { pointer("pointermove", window, 400, 40); });
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      expect(document.querySelector(".access-board-ghost")).toBeNull();
    } finally {
      document.elementFromPoint = original;
    }
    expect(api.setBulkAccess).not.toHaveBeenCalled();
  });

  it("Reset to vault default confirms, then makes one request and reloads", async () => {
    api.resetMemberAccess.mockResolvedValue({ removed: 2, disconnectedDocs: 0 });
    await render({ personVaultMode: "readonly", everyoneMode: "open" });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Set everything to"]')!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((li) => li.textContent?.startsWith("Reset to vault default"))!;
    await act(async () => option.click());
    expect(dialog()?.textContent).toContain("Reset Sara's access to the vault default?");
    expect(api.resetMemberAccess).not.toHaveBeenCalled();
    await act(async () => dialogButton("Reset").click());
    expect(api.resetMemberAccess).toHaveBeenCalledTimes(1);
    expect(api.resetMemberAccess).toHaveBeenCalledWith("org-1", "u2");
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  describe("when the bulk write fails", () => {
    const openMenu = async (label: string, item: string) => {
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
      const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((li) => li.textContent?.startsWith(item))!;
      await act(async () => option.click());
    };

    it("puts a moved row back and toasts the connection error", async () => {
      await render();
      api.setBulkAccess.mockRejectedValue(new TypeError("Load failed"));
      await act(async () => button("Move Welcome left").click());
      await settle();
      expect(names("readonly")).toEqual(["Welcome"]);
      expect(names("open")).not.toContain("Welcome");
      expect(toast).toHaveBeenCalledWith("Couldn't update access, check your connection", "error");
      expect(toast).not.toHaveBeenCalledWith("Sara can now edit Welcome.");
      expect(onItemWritten).not.toHaveBeenCalled();
      expect(host.querySelector(".auth-error")).toBeNull();
      // The board stays usable.
      expect(button("Move Welcome left").disabled).toBe(false);
    });

    it("Add all on Can view puts every row, root notes included, back in its column", async () => {
      modes = { f1: "private", n1: "private", n2: "private", n3: "private" };
      await render({ personVaultMode: "private" });
      expect(names("private")).toEqual(["Specs", "API", "Roadmap", "Welcome"]);
      api.setBulkAccess.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
      await openMenu("Can view actions", "Add all");
      await settle();
      expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
      expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({ resources: [{ resourceType: "vault", resourceId: "org-1" }], mode: "readonly" });
      expect(api.setBulkAccess.mock.calls[0][2]).toEqual({ timeoutMs: 30_000 });
      expect(names("private")).toEqual(["Specs", "API", "Roadmap", "Welcome"]);
      expect(names("readonly")).toEqual([]);
      expect(toast).toHaveBeenCalledWith("Couldn't update access, check your connection", "error");
      expect(onChanged).not.toHaveBeenCalled();
    });

    it("shows what the server holds when the write committed but its answer was lost", async () => {
      await render();
      api.setBulkAccess.mockImplementation(async (_org: string, input: { resources: Array<{ resourceId: string }>; mode: string }) => {
        for (const r of input.resources) modes[r.resourceId] = input.mode;
        throw new TypeError("Load failed");
      });
      const reads = api.resolveAccessSummaries.mock.calls.length;
      await act(async () => button("Move Roadmap left").click());
      await settle();
      expect(api.resolveAccessSummaries.mock.calls.length).toBeGreaterThan(reads);
      expect(names("readonly")).toContain("Roadmap");
      expect(names("private")).not.toContain("Roadmap");
      expect(toast).toHaveBeenCalledWith("Couldn't update access, check your connection", "error");
    });

    it("a refusal the server explained is shown as is", async () => {
      await render();
      api.setBulkAccess.mockRejectedValue(Object.assign(new Error("Only the vault owner or an admin can manage access"), { name: "ApiError", status: 403 }));
      await act(async () => button("Move Welcome left").click());
      await settle();
      expect(toast).toHaveBeenCalledWith("Only the vault owner or an admin can manage access", "error");
      expect(names("readonly")).toEqual(["Welcome"]);
    });

    it("re-reads rows that failed to load once the connection comes back", async () => {
      api.resolveAccessSummaries.mockRejectedValue(new TypeError("Load failed"));
      await render();
      await settle();
      expect(host.querySelector(".access-board-failed")).not.toBeNull();
      api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: Array<Array<{ resourceId: string }>>) =>
        groups.map((g) => modes[g[0].resourceId] ?? "private"));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await settle();
      expect(host.querySelector(".access-board-failed")).toBeNull();
      expect(names("readonly")).toEqual(["Welcome"]);
      expect(names("private")).toEqual(["Roadmap"]);
    });
  });
});
