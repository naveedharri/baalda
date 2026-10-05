// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMembersAccessCaches } from "../../lib/membersAccessCaches";
import { MembersAccessTab } from "../MembersAccessTab";
import { useStore } from "../../store";

const api = vi.hoisted(() => ({
  getMembersOverview: vi.fn(), getTeamAccess: vi.fn(), getAccessDefault: vi.fn(),
  setTeamAccess: vi.fn(), setAccessDefault: vi.fn(), setBulkAccess: vi.fn(),
  inviteMany: vi.fn(), cancelInvitation: vi.fn(), getJoinCode: vi.fn(),
  listAccessTree: vi.fn(), resolveAccessSummary: vi.fn(), resolveAccessSummaries: vi.fn(),
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

const person = (userId: string, name: string, role: "owner" | "admin" | "member" = "member") => ({
  userId, memberId: `m-${userId}`, role, name, email: `${userId}@team.test`, image: null,
  joinedAt: null, lastActiveAt: null, access: { level: "edit" as "edit" | "view" | "none" | "custom" },
});
const overview = (members: ReturnType<typeof person>[], canManage = true) => ({ members, invitations: [], canManage });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Members and access tab", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    resetMembersAccessCaches();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    patchStore({
      session: { activeOrganizationId: "org-1", user: { id: "u1" } },
      organizations: [{ id: "org-1", name: "Product team" }, { id: "org-2", name: "Other team" }],
      vaultPresence: [], serverUrl: "http://test.invalid", locks: [], denies: [], tree: null,
      refreshLocks: vi.fn().mockResolvedValue(undefined),
    });
    api.getMembersOverview.mockResolvedValue(overview([person("u1", "Owner One", "owner")]));
    api.getTeamAccess.mockResolvedValue({ mode: "readonly", posture: "view", grantId: "g", overrides: [] });
    api.getAccessDefault.mockResolvedValue({ mode: "private" });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    resetMembersAccessCaches();
    act(() => root.unmount());
    host.remove();
  });
  const onOpenTab = vi.fn();
  async function render(canManage = true) {
    await act(async () => root.render(createElement(MembersAccessTab, { canManage, onOpenTab })));
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it("drops an overview response that arrives after a newer one", async () => {
    const old = deferred<ReturnType<typeof overview>>();
    api.getMembersOverview
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(overview([person("u1", "Fresh Owner", "owner")]));
    await render();
    await act(async () => patchStore({ session: { activeOrganizationId: "org-2", user: { id: "u1" } } }));
    await flush();
    expect(host.textContent).toContain("Fresh Owner");
    await act(async () => old.resolve(overview([person("u1", "Stale Owner", "owner")])));
    await flush();
    expect(host.textContent).toContain("Fresh Owner");
    expect(host.textContent).not.toContain("Stale Owner");
  });

  it("shows no Everyone or New members value before the server answers", async () => {
    const team = deferred<unknown>();
    const joining = deferred<unknown>();
    api.getTeamAccess.mockReturnValueOnce(team.promise);
    api.getAccessDefault.mockReturnValueOnce(joining.promise);
    await render();
    const rows = () => host.querySelector(".members-access-rows");
    expect(rows()).not.toBeNull();
    expect(rows()!.querySelectorAll(".members-access-trigger")).toHaveLength(0);
    expect(rows()!.textContent).not.toMatch(/Can edit|Can view|No access/);
    await act(async () => {
      team.resolve({ mode: "readonly", posture: "view", grantId: "g", overrides: [] });
      joining.resolve({ mode: "private" });
    });
    await flush();
    const triggers = rows()!.querySelectorAll(".members-access-trigger");
    expect(triggers).toHaveLength(2);
    expect(triggers[0].textContent).toContain("Can view");
    expect(triggers[1].textContent).toContain("No access");
  });

  it("reads a never-shared vault as No access with the authorship note", async () => {
    api.getTeamAccess.mockResolvedValueOnce({ mode: "private", posture: "none", grantId: null, overrides: [] });
    await render();
    await flush();
    const everyone = host.querySelector(".members-access-row");
    expect(everyone?.textContent).toContain("No access");
    expect(everyone?.textContent).toContain("Members keep notes they wrote");
  });

  it("lets an owner in a No access vault give themselves Can edit everything", async () => {
    api.getTeamAccess.mockResolvedValue({ mode: "private", posture: "sealed", grantId: null, overrides: [] });
    api.getMembersOverview.mockResolvedValue(overview([
      { ...person("u1", "Owner One", "owner"), access: { level: "none" } },
      { ...person("u2", "Ana Admin", "admin"), access: { level: "view" } },
    ]));
    api.setBulkAccess.mockResolvedValue({ mode: "open", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
    await render();
    await flush();
    // Owner and admin rows show their computed level, not a role exemption.
    const own = document.body.querySelector<HTMLButtonElement>('[aria-label="Access for Owner One"]');
    expect(own?.textContent).toContain("No access");
    expect(document.body.querySelector('[aria-label="Access for Ana Admin"]')?.textContent).toContain("Can view everything");
    await act(async () => own!.click());
    const edit = [...document.body.querySelectorAll('[role="menuitemradio"]')]
      .find((n) => n.textContent?.startsWith("Can edit everything")) as HTMLElement;
    await act(async () => edit.click());
    await flush();
    // Widening needs no confirm and targets exactly the caller, vault-wide.
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledWith("org-1", {
      resources: [{ resourceType: "vault", resourceId: "org-1" }],
      audience: { type: "users", userIds: ["u1"] },
      mode: "open",
    });
  });

  it("opens a profile in place of the table and comes back", async () => {
    api.listAccessTree.mockResolvedValue({ folders: [], notes: [] });
    api.getMembersOverview.mockResolvedValue(overview([person("u1", "Owner One", "owner"), person("u2", "Sara Khan")]));
    await render();
    await flush();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for Sara Khan"]')!.click());
    const item = (label: string) => [...document.body.querySelectorAll('[role="menuitem"]')]
      .find((n) => n.textContent === label) as HTMLElement;
    await act(async () => item("View profile").click());
    await flush();
    expect(host.querySelector(".members-table")).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector(".member-profile-name")?.textContent).toBe("Sara Khan");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Personal info");
    const back = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Members and access"))!;
    await act(async () => back.click());
    expect(host.querySelector(".members-table")).not.toBeNull();
    // "Manage access…" in the row dropdown lands on the Access tab directly.
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Access for Sara Khan"]')!.click());
    const manage = [...document.body.querySelectorAll('[role="menuitemradio"]')]
      .find((n) => n.textContent?.startsWith("Manage access")) as HTMLElement;
    await act(async () => manage.click());
    await flush();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Access");
  });

  it("shows owners a quiet MCP tip that opens the MCP tab", async () => {
    await render();
    await flush();
    const hint = host.querySelector(".members-access-mcp-hint");
    expect(hint?.textContent).toContain("manage access by chatting with Claude or ChatGPT through MCP");
    const link = [...hint!.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Set it up"))!;
    await act(async () => link.click());
    expect(onOpenTab).toHaveBeenCalledWith("mcp");
  });

  it("opens a person's Personal info page from a click anywhere on their row, but not from its controls", async () => {
    api.listAccessTree.mockResolvedValue({ folders: [], notes: [] });
    api.getMembersOverview.mockResolvedValue({
      members: [person("u1", "Owner One", "owner"), person("u2", "Sara Khan")],
      invitations: [{ id: "i1", email: "maya@team.test", role: "member", status: "pending", createdAt: null, expiresAt: null, access: null }],
      canManage: true,
    });
    await render();
    await flush();
    // The Access dropdown is a control: the table stays.
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Access for Sara Khan"]')!.click());
    expect(host.querySelector(".members-table")).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    // An invited row has no profile.
    const invited = [...host.querySelectorAll("tr")].find((r) => r.textContent?.includes("maya@team.test"))!;
    expect(invited.getAttribute("role")).toBeNull();
    await act(async () => (invited.querySelector(".members-table-name") as HTMLElement).click());
    expect(host.querySelector(".members-table")).not.toBeNull();
    // The name cell opens Personal info.
    const row = host.querySelector<HTMLElement>('[aria-label="Open profile of Sara Khan"]')!;
    await act(async () => (row.querySelector(".members-table-name") as HTMLElement).click());
    await flush();
    expect(host.querySelector(".members-table")).toBeNull();
    expect(host.querySelector(".member-profile-name")?.textContent).toBe("Sara Khan");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Personal info");
  });

  it("counts the viewer as present while their vault channel is connected", async () => {
    api.listAccessTree.mockResolvedValue({ folders: [], notes: [] });
    api.getMembersOverview.mockResolvedValue(overview([
      { ...person("u1", "Owner One", "owner"), lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString() as never },
      person("u2", "Sara Khan"),
    ]));
    patchStore({ vaultSyncStatus: "offline" });
    await render();
    await flush();
    const ownRow = () => host.querySelector<HTMLElement>('[aria-label="Open profile of Owner One"]')!;
    expect(ownRow().textContent).not.toContain("Now");
    await act(async () => patchStore({ vaultSyncStatus: "synced" }));
    expect([...ownRow().querySelectorAll("td")].some((td) => td.textContent === "Now")).toBe(true);
    await act(async () => (ownRow().querySelector(".members-table-name") as HTMLElement).click());
    await flush();
    const dd = (label: string) =>
      [...host.querySelectorAll(".member-profile-about dt")].find((dt) => dt.textContent === label)?.nextElementSibling?.textContent;
    expect(dd("Status")).toBe("Online");
    expect(dd("Last active")).toBe("Now");
    patchStore({ vaultSyncStatus: "offline" });
  });

  it("opens a profile with Enter on a focused row", async () => {
    api.getMembersOverview.mockResolvedValue(overview([person("u1", "Owner One", "owner"), person("u2", "Sara Khan")]));
    await render();
    await flush();
    const row = host.querySelector<HTMLElement>('[aria-label="Open profile of Sara Khan"]')!;
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector(".member-profile-name")?.textContent).toBe("Sara Khan");
  });

  it("makes a person view-only straight away but asks before removing their access", async () => {
    api.getMembersOverview.mockResolvedValue(overview([person("u1", "Owner One", "owner"), person("u2", "Sara Khan")]));
    api.setBulkAccess.mockResolvedValue({ mode: "readonly", resourcesChanged: 1, overridesCleared: 0, membersAffected: 1, disconnectedDocs: 0 });
    await render();
    await flush();
    const pick = async (label: string) => {
      await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Access for Sara Khan"]')!.click());
      const item = [...document.body.querySelectorAll('[role="menuitemradio"]')]
        .find((n) => n.textContent?.startsWith(label)) as HTMLElement;
      await act(async () => item.click());
      await flush();
    };
    await pick("Can view everything");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
    expect(api.setBulkAccess.mock.calls[0][1]).toMatchObject({ mode: "readonly", audience: { type: "users", userIds: ["u2"] } });
    await pick("No access");
    expect(document.body.querySelector('[role="alertdialog"] .confirm-title')?.textContent).toBe("Remove Sara Khan's access to this vault?");
    expect(api.setBulkAccess).toHaveBeenCalledTimes(1);
  });

  it("gives a plain member a read-only roster", async () => {
    api.getMembersOverview.mockResolvedValue({
      members: [person("u0", "Owner", "owner"), { ...person("u1", "Me"), access: undefined }],
      invitations: [], canManage: false,
    });
    await render(false);
    await flush();
    expect(api.getTeamAccess).not.toHaveBeenCalled();
    expect(api.getAccessDefault).not.toHaveBeenCalled();
    expect(host.querySelector(".members-access-rows")).toBeNull();
    const headers = [...host.querySelectorAll("th")].map((th) => th.textContent);
    expect(headers).toEqual(["Name", "Role", "Last active"]);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Invite people")).toBe(false);
    expect(host.querySelector('[aria-label^="Actions for"]')).toBeNull();
    expect(host.textContent).toContain("Me (you)");
    expect(host.querySelector(".members-access-mcp-hint")).toBeNull();
    // Rows still open a read-only profile: Personal info and Activity, no Access tab.
    await act(async () => (host.querySelector('[aria-label="Open profile of Owner"] .members-table-name') as HTMLElement).click());
    expect(host.querySelector(".member-profile-name")?.textContent).toBe("Owner");
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Personal info", "Activity"]);
  });
});
