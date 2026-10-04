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
const selfMark = vi.hoisted(() => vi.fn());
vi.mock("../../lib/sync/selfAccessChanges", () => ({ markSelfAccessChange: selfMark }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../lib/toast", () => ({ toast }));

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
    api.setBulkAccess.mockResolvedValue({ mode: "open", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
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
    expect(dialog()).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "file", resourceId: "n2" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "open",
    });
    expect(onItemWritten).toHaveBeenCalledTimes(1);
    // Optimistic move.
    expect(names("open")).toContain("Welcome");
    expect(row("open", "Welcome").classList.contains("is-landing")).toBe(true);
    expect(toast).toHaveBeenCalledWith("Sara can now edit Welcome.");
    expect(host.querySelector(".access-board-undo")).toBeNull();
  });

  it("lowering one row writes at once, without a confirm, and toasts", async () => {
    await render();
    await act(async () => button("Move Welcome right").click());
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
    });
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
      expect(column("private").querySelector(".access-board-drop-line")).not.toBeNull();
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
});
