// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMembersAccessCaches } from "../../lib/membersAccessCaches";
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
    resetMembersAccessCaches();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({ locks: [], denies: [], tree: null });
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
    resetMembersAccessCaches();
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

  it("the board is the only view: one request, no per-row reads", async () => {
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
      expect(host.querySelector(".member-access-tree")).toBeNull();
      expect(host.querySelector('[aria-label="Board view"]')).toBeNull();
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
    const back = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("People and access"));
    expect(back).toBeDefined();
    await act(async () => back!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});

describe("Member profile page, Personal info and Activity tabs", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    resetMembersAccessCaches();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({ locks: [], denies: [], tree: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    resetMembersAccessCaches();
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

  it("shows a plain member only Personal info on someone else's profile, with no tab strip (#301)", async () => {
    await render({ showAccessTab: false });
    expect(tabs()).toEqual([]);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector(".member-profile-about")).not.toBeNull();
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
      "You edited 5 notes: Welcome, AGENTS, Keyboard shortcuts and 2 more",
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

});
