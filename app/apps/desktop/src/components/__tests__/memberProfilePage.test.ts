// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberProfilePage } from "../MemberProfilePage";
import { useStore } from "../../store";
import { relativeTime } from "../../lib/health/format";

const api = vi.hoisted(() => ({
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(), setBulkAccess: vi.fn(), getMemberActivity: vi.fn(),
  getAccessBoard: vi.fn(), getHealth: vi.fn(), getBaseUrl: vi.fn(() => "http://test.invalid"),
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

const patchStore = (state: Record<string, unknown>) =>
  (useStore as unknown as { setState: (state: Record<string, unknown>) => void }).setState(state);

const member = {
  userId: "u2", memberId: "m2", role: "member" as const, name: "Sara Khan", email: "sara@team.test",
  image: null, joinedAt: null, lastActiveAt: null, access: { level: "custom" as const },
};

describe("Member profile page, Access tab", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onItemWritten: ReturnType<typeof vi.fn<() => void>>;
  let onChanged: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({ locks: [], denies: [], tree: null });
    // These cover the tree; the Access tab opens on the board by default.
    localStorage.setItem("context.memberAccess.view", "list");
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }],
      notes: [{ id: "n1", relPath: "Specs/API.md" }],
    });
    api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: unknown[][]) => groups.map(() => "private"));
    api.setBulkAccess.mockResolvedValue({ mode: "readonly", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
    onClose = vi.fn<() => void>();
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
  async function render(strict = false) {
    const page = (props: Record<string, unknown>) => createElement(MemberProfilePage, props as never);
    const wrap = (el: ReturnType<typeof page>) => (strict ? createElement(StrictMode, null, el) : el);
    await act(async () => root.render(wrap(page({
      orgId: "org-1", vaultName: "Product team", member, initialTab: "access", canAct: true, canSetAccess: true, present: false,
      teamAccess: { mode: "open", posture: "edit", grantId: "g", overrides: [] },
      onClose, onChanged, onItemWritten, onRoleChange: vi.fn(), onRemove: vi.fn(),
    }))));
  }
  async function settle() {
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  }
  const folderBox = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Specs: can open"]');

  it("shows each row's icon, name, level pill and annotation", async () => {
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }, { id: "f2", path: "Archive" }],
      notes: [{ id: "n1", relPath: "Welcome.md" }],
    });
    api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: Array<Array<{ resourceId: string }>>) =>
      groups.map((g) => (g[0].resourceId === "f2" ? "private" : g[0].resourceId === "n1" ? "readonly" : "open")));
    await render();
    await settle();
    const rows = [...host.querySelectorAll(".member-access-row")];
    expect(rows.map((r) => r.querySelector(".member-access-name")?.textContent)).toEqual(["Archive", "Specs", "Welcome"]);
    expect(rows.every((r) => r.querySelector(".member-access-icon svg"))).toBe(true);
    const byName = (n: string) => rows.find((r) => r.querySelector(".member-access-name")?.textContent === n)!;
    // Team mode is Can edit: an open row is inherited, a view row is the person's own.
    expect(byName("Specs").textContent).toContain("Same as everyone");
    expect(byName("Specs").querySelector(".member-access-pill")?.textContent).toContain("Can edit");
    expect(byName("Welcome").querySelector(".member-access-pill")?.textContent).toContain("Can view");
    expect(byName("Welcome").textContent).not.toContain("Same as everyone");
    expect(byName("Archive").querySelector(".member-access-pill")).toBeNull();
  });

  it("with access-board, List and Board share one request and read no summaries", async () => {
    const { forgetServerFeatures } = await import("../../lib/serverFeatures");
    const { forgetAccessBoardSupport } = await import("../../lib/accessBoardLoad");
    forgetServerFeatures();
    forgetAccessBoardSupport();
    api.getHealth.mockResolvedValue({ ok: true, features: ["access-board"] });
    api.getAccessBoard.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs", color: null }], notes: [{ id: "n1", relPath: "Welcome.md" }], files: [], modes: "ev",
    });
    try {
      await render();
      await settle();
      const rows = [...host.querySelectorAll(".member-access-row")];
      const byName = (n: string) => rows.find((r) => r.querySelector(".member-access-name")?.textContent === n)!;
      expect(byName("Specs").querySelector(".member-access-pill")?.textContent).toContain("Can edit");
      expect(byName("Welcome").querySelector(".member-access-pill")?.textContent).toContain("Can view");
      const boardBtn = host.querySelector<HTMLButtonElement>('[role="radiogroup"] [aria-label="Board view"]')!;
      await act(async () => boardBtn.click());
      await settle();
      expect(host.querySelector('.access-board-column[data-mode="open"] .access-board-count')?.textContent).toBe("1");
      expect(host.querySelector('.access-board-column[data-mode="readonly"] .access-board-count')?.textContent).toBe("1");
      expect(api.getAccessBoard).toHaveBeenCalledTimes(1);
      expect(api.listAccessTree).not.toHaveBeenCalled();
      expect(api.resolveAccessSummaries).not.toHaveBeenCalled();
    } finally {
      forgetServerFeatures();
      api.getHealth.mockReset();
    }
  });

  it("is a page with a way back, not a dialog", async () => {
    await render();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const back = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Members and access"));
    expect(back).toBeDefined();
    await act(async () => back!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("updates the ticked row in place: no tree re-fetch, only that subtree re-read", async () => {
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }, { id: "f2", path: "Archive" }],
      notes: [{ id: "n1", relPath: "Welcome.md" }],
    });
    await render();
    await settle();
    expect(api.listAccessTree).toHaveBeenCalledTimes(1);
    const reads = api.resolveAccessSummaries.mock.calls.length;
    const spinnersBefore = host.querySelectorAll(".member-access-row .spinner, .member-access-row [class*=spinner]").length;
    await act(async () => folderBox()!.click());
    // Optimistic: checked before the re-read lands, and no row went back to loading.
    expect(folderBox()?.checked).toBe(true);
    expect(host.querySelectorAll(".member-access-row .spinner, .member-access-row [class*=spinner]").length).toBe(spinnersBefore);
    await settle();
    expect(api.listAccessTree).toHaveBeenCalledTimes(1);
    const later = api.resolveAccessSummaries.mock.calls.slice(reads);
    const reRead = later.flatMap((call) => (call[1] as Array<Array<{ resourceId: string }>>).map((g) => g[0].resourceId));
    expect(reRead).toEqual(["f1"]);
  });

  const spinning = () => host.querySelectorAll(".member-access-row [aria-busy], .member-access-row .spinner, .member-access-row [class*=spinner]").length;

  it("resolves every row under StrictMode, and re-reads the whole tree after a vault-wide change", async () => {
    api.listAccessTree.mockResolvedValue({
      folders: [{ id: "f1", path: "Specs" }, { id: "f2", path: "Archive" }],
      notes: [{ id: "n1", relPath: "Welcome.md" }],
    });
    let serverMode = "open";
    api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: unknown[][]) => groups.map(() => serverMode));
    await render(true);
    await settle();
    expect(spinning()).toBe(0);
    expect(host.querySelectorAll(".member-access-row .member-access-pill")).toHaveLength(3);
    const reads = api.resolveAccessSummaries.mock.calls.length;

    // Across the vault: Custom → Can view everything. View-only never asks.
    serverMode = "readonly";
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Access across the vault"]')!.click());
    const viewAll = [...document.body.querySelectorAll('[role="menuitemradio"]')]
      .find((n) => n.textContent?.startsWith("Can view everything")) as HTMLElement;
    await act(async () => viewAll.click());
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await settle();

    expect(onChanged).toHaveBeenCalledTimes(1);
    const reRead = api.resolveAccessSummaries.mock.calls.slice(reads)
      .flatMap((call) => (call[1] as Array<Array<{ resourceId: string }>>).map((g) => g[0].resourceId));
    expect(new Set(reRead)).toEqual(new Set(["f1", "f2", "n1"]));
    expect(spinning()).toBe(0);
    const pills = [...host.querySelectorAll(".member-access-row .member-access-pill")].map((p) => p.textContent ?? "");
    expect(pills).toHaveLength(3);
    expect(pills.every((p) => p.includes("Can view"))).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('.member-access-row input[type="checkbox"]')].every((b) => b.checked)).toBe(true);
  });

  it("never spins forever: an unanswered row shows a dash after five seconds", async () => {
    vi.useFakeTimers();
    try {
      api.resolveAccessSummaries.mockImplementation(() => new Promise(() => {}));
      await render();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(spinning()).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(spinning()).toBe(0);
      const dash = host.querySelector('.member-access-row [title="Couldn\'t load"]');
      expect(dash?.textContent).toBe("—");
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits exactly one resource for exactly one person", async () => {
    await render();
    await settle();
    expect(folderBox()?.checked).toBe(false);
    await act(async () => folderBox()!.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "folder", resourceId: "f1" }],
      audience: { type: "users", userIds: ["u2"] },
      // Their own level is Custom, so the tick takes Everyone's: Can edit.
      // Never a silent default to Can view.
      mode: "open",
    });
    // A per-item write reloads nothing: the debounced side effects only.
    expect(onItemWritten).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("asks before removing access and writes nothing until confirmed", async () => {
    api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: unknown[][]) => groups.map(() => "open"));
    await render();
    await settle();
    expect(folderBox()?.checked).toBe(true);
    await act(async () => folderBox()!.click());
    await settle();
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector(".confirm-title")?.textContent).toBe("Remove access to “Specs”?");
    expect(dialog?.textContent).toContain("removed from their devices on the next sync");
    expect(dialog?.textContent).not.toMatch(/narrow/i);
    expect(api.setBulkAccess).not.toHaveBeenCalled();
    const apply = [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Remove access")!;
    await act(async () => apply.click());
    await settle();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({
      resources: [{ resourceType: "folder", resourceId: "f1" }],
      audience: { type: "users", userIds: ["u2"] },
      mode: "private",
    });
  });
});

describe("Member profile page, Personal info and Activity tabs", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({ locks: [], denies: [], tree: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const person = {
    ...member,
    name: "Lee Park",
    email: "lee@team.test",
    joinedAt: "2026-09-12T10:00:00Z",
    lastActiveAt: "2026-10-01T10:00:00Z",
    invitedBy: { userId: "u1", name: "Kamil Ali", email: "kamil@team.test" },
  };
  async function render(props: Record<string, unknown> = {}) {
    await act(async () => root.render(createElement(MemberProfilePage, {
      orgId: "org-1", vaultName: "Product team", member: person, initialTab: "info", canAct: false, canSetAccess: true,
      present: false, teamAccess: null,
      onClose: vi.fn(), onChanged: vi.fn(), onItemWritten: vi.fn(), onRoleChange: vi.fn(), onRemove: vi.fn(),
      ...props,
    } as never)));
  }
  const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };
  const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  const clickTab = (label: string) =>
    act(async () => ([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === label)!).click());

  it("lists name, email, role, joined with the inviter, last active and status", async () => {
    await render();
    expect(tabs()).toEqual(["Personal info", "Access", "Activity"]);
    const pairs = [...host.querySelectorAll(".member-profile-about dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    const long = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const joined = `${long("2026-09-12T10:00:00Z")} (${relativeTime(Date.parse("2026-09-12T10:00:00Z"), Date.now())})`;
    expect(pairs.map((p) => p[0])).toEqual(["Name", "Email", "Role", "Joined", "Last active", "Status"]);
    expect(Object.fromEntries(pairs)).toMatchObject({
      Name: "Lee Park",
      Email: "lee@team.test",
      Role: "Member",
      Joined: `${joined}, invited by Kamil Ali`,
      Status: "Away",
    });
    expect(Object.fromEntries(pairs)["Last active"]).toMatch(new RegExp(`^${long("2026-10-01T10:00:00Z")} \\(.+ ago\\)$`));
    expect(api.getMemberActivity).not.toHaveBeenCalled();
  });

  it("reads Now and Online while the person is present, and no inviter when unknown", async () => {
    await render({ present: true, member: { ...person, invitedBy: null } });
    const dd = (label: string) =>
      [...host.querySelectorAll(".member-profile-about dt")].find((dt) => dt.textContent === label)?.nextElementSibling?.textContent;
    expect(dd("Last active")).toBe("Now");
    expect(dd("Status")).toBe("Online");
    expect(dd("Joined")).not.toContain("invited by");
  });

  it("shows plain members Personal info and Activity only", async () => {
    await render({ showAccessTab: false });
    expect(tabs()).toEqual(["Personal info", "Activity"]);
  });

  /** Each timeline entry's sentence without its " · 2 hours ago" tail. */
  const entries = () => [...host.querySelectorAll(".member-activity-text")].map((p) => {
    const clone = p.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".member-activity-time").forEach((t) => t.remove());
    return clone.textContent;
  });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("tells each kind of event from the member's side, newest first, down to the join", async () => {
    api.getMemberActivity.mockResolvedValue([
      { kind: "edited", at: hoursAgo(0), docId: "d1", path: "Plans/Q3 plan.md" },
      { kind: "created", at: "2026-09-30T10:00:00Z", docId: "d2", path: "Meeting notes/2026/Q3/Week 40/Kickoff notes.md" },
      { kind: "accessGranted", at: "2026-09-20T10:00:00Z", by: { userId: "u1", name: "Kamil Ali", email: null }, permission: "edit", resourceType: "folder", resourceId: "f1", path: "Work/Pricing experiments" },
      { kind: "accessGranted", at: "2026-09-19T10:00:00Z", by: null, permission: "readonly", resourceType: "vault", resourceId: "org-1", path: null },
      { kind: "accessGranted", at: "2026-09-18T10:00:00Z", by: null, permission: "denied", resourceType: "file", resourceId: "n9", path: "Secret.md" },
      { kind: "joined", at: "2026-09-12T10:00:00Z", invitedBy: { userId: "u1", name: "Kamil Ali", email: null } },
    ]);
    const onOpenNote = vi.fn();
    await render({ onOpenNote });
    await clickTab("Activity");
    await flush();
    expect(api.getMemberActivity).toHaveBeenCalledWith("org-1", "u2", 50);
    expect(entries()).toEqual([
      "Edited Q3 plan",
      "Created Kickoff notes in Meeting notes › 2026 › Q3 › Week 40",
      "Got Can edit on Pricing experiments from Kamil Ali",
      "Got Can view across the vault",
      "Lost access to Secret",
      "Joined Product team, invited by Kamil Ali",
    ]);
    expect(host.querySelector(".member-activity-now")?.textContent).toBe("Now");
    expect(host.querySelector(".member-activity-day-pill")?.textContent).toBe("Today");
    const all = host.querySelectorAll(".member-activity-entry");
    expect(all[all.length - 1].classList.contains("is-origin")).toBe(true);
    expect(host.querySelectorAll(".member-activity-node").length).toBe(6);
    expect(host.querySelector(".member-activity-time")?.textContent).toMatch(/ · (just now|1 min ago)/);
    expect(host.querySelector(".member-activity-summary")?.textContent).toMatch(/^Active for \d+ days · 1 edit · 1 note created$/);
    await act(async () => host.querySelector<HTMLButtonElement>(".member-activity-note")!.click());
    expect(onOpenNote).toHaveBeenCalledWith("Plans/Q3 plan.md");
  });

  it("collapses a day's run of more than three edits, speaks as You, and expands on Show all", async () => {
    patchStore({ session: { user: { id: "u2" } } });
    api.getMemberActivity.mockResolvedValue([
      ...["Welcome", "AGENTS", "Keyboard shortcuts", "Ideas", "Roadmap"].map((n, i) =>
        ({ kind: "edited", at: hoursAgo(i * 0.01), docId: `e${i}`, path: `${n}.md` })),
      { kind: "accessGranted", at: hoursAgo(0.1), by: { userId: "u1", name: "Kamil Ali", email: null }, permission: "view", resourceType: "vault", resourceId: "org-1", path: null },
      { kind: "edited", at: hoursAgo(0.2), docId: "x1", path: "One.md" },
      { kind: "edited", at: hoursAgo(0.3), docId: "x2", path: "Two.md" },
      ...[1, 2, 3, 4].map((i) => ({ kind: "created", at: "2026-09-25T10:00:00Z", docId: `c${i}`, path: `Getting Started/Page ${i}.md` })),
    ]);
    const onOpenNote = vi.fn();
    await render({ initialTab: "activity", onOpenNote });
    await flush();
    expect(entries()).toEqual([
      "You edited 5 notes — Welcome, AGENTS, Keyboard shortcuts and 2 more",
      "You got Can view across the vault from Kamil Ali",
      "You edited One",
      "You edited Two",
      "You created 4 notes in Getting Started",
      "You joined Product team, invited by Kamil Ali",
    ]);
    const disclose = host.querySelector<HTMLButtonElement>(".member-activity-disclose")!;
    expect(disclose.textContent).toBe("Show all");
    await act(async () => disclose.click());
    const run = host.querySelector(".member-activity-run")!;
    expect(run.querySelectorAll("li").length).toBe(5);
    await act(async () => run.querySelectorAll<HTMLButtonElement>(".member-activity-note")[3].click());
    expect(onOpenNote).toHaveBeenCalledWith("Ideas.md");
    patchStore({ session: undefined });
  });

  it("notes the cap in the summary when the list is full", async () => {
    api.getMemberActivity.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ kind: "edited", at: hoursAgo(i), docId: `d${i}`, path: `N${i}.md` })),
    );
    await render({ initialTab: "activity" });
    await flush();
    expect(host.querySelector(".member-activity-summary")?.textContent).toMatch(/· 50 edits in the last 50 events$/);
  });

  it("shows only the join when there is nothing else, and says so when it can't load", async () => {
    api.getMemberActivity.mockResolvedValue([]);
    await render({ initialTab: "activity" });
    await flush();
    expect(entries()).toEqual(["Joined Product team, invited by Kamil Ali"]);
    expect(host.querySelector(".member-activity-entry")?.classList.contains("is-origin")).toBe(true);
    await render({ initialTab: "activity", member: { ...person, userId: "u7", joinedAt: null } });
    await flush();
    expect(host.querySelector(".member-activity-empty")?.textContent).toBe("No activity yet.");
    api.getMemberActivity.mockRejectedValue(new Error("boom"));
    await render({ initialTab: "activity", member: { ...person, userId: "u9" } });
    await flush();
    expect(host.querySelector(".member-activity-empty")?.textContent).toBe("Couldn't load activity.");
  });

  describe("Access view toggle", () => {
    let store: Record<string, string>;
    beforeEach(() => {
      store = {};
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
      });
      api.listAccessTree.mockResolvedValue({ folders: [], notes: [] });
      api.resolveAccessSummaries.mockImplementation(async (_org: string, groups: unknown[][]) => groups.map(() => "private"));
    });
    afterEach(() => vi.unstubAllGlobals());
    const view = (label: string) => host.querySelector<HTMLButtonElement>(`[role="radiogroup"] [aria-label="${label}"]`)!;
    const acrossRow = () => [...host.querySelectorAll(".members-access-row-title")].some((n) => n.textContent === "Across the vault");

    it("defaults to the board, switches to the list and back, and remembers the choice", async () => {
      await render({ initialTab: "access" });
      await flush();
      expect(view("Board view").getAttribute("aria-checked")).toBe("true");
      expect(host.querySelector(".access-board")).not.toBeNull();
      // One header row in both views: same vault-wide control, same toggle spot,
      // and the board's own "Set everything to" stays hidden.
      expect(acrossRow()).toBe(true);
      expect(view("Board view").closest(".members-access-row")?.querySelector('[aria-label="Access across the vault"]')).not.toBeNull();
      expect(host.querySelector('[aria-label="Set everything to"]')).toBeNull();

      await act(async () => view("List view").click());
      await flush();
      expect(host.querySelector(".access-board")).toBeNull();
      expect(acrossRow()).toBe(true);
      expect(view("List view").closest(".members-access-row")?.querySelector('[aria-label="Access across the vault"]')).not.toBeNull();
      expect(view("List view").getAttribute("aria-checked")).toBe("true");
      expect(store["context.memberAccess.view"]).toBe("list");

      await act(async () => view("Board view").click());
      await flush();
      expect(host.querySelector(".access-board")).not.toBeNull();
      expect(store["context.memberAccess.view"]).toBe("board");
    });

    it("opens on the list when this device last chose it", async () => {
      store["context.memberAccess.view"] = "list";
      await render({ initialTab: "access" });
      await flush();
      expect(host.querySelector(".access-board")).toBeNull();
      expect(view("List view").getAttribute("aria-checked")).toBe("true");
    });

    it("falls back to the board when storage throws", async () => {
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
      await render({ initialTab: "access" });
      await flush();
      expect(view("Board view").getAttribute("aria-checked")).toBe("true");
      await act(async () => view("List view").click());
      expect(host.querySelector(".access-board")).toBeNull();
    });
  });
});
