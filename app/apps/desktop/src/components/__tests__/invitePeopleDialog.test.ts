// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePeopleDialog, inviteAccessOptions, legacyNewMembersSetting } from "../InvitePeopleDialog";
import { useStore } from "../../store";

const api = vi.hoisted(() => ({ getJoinCodeInfo: vi.fn(), setJoinCodeGroups: vi.fn(), inviteMany: vi.fn() }));
vi.mock("../../lib/auth/authManager", () => ({ authManager: { api, getServerUrl: () => "http://test.invalid" } }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({})) };
});
vi.mock("../UpgradeDialog", () => ({ UpgradeDialog: () => null }));

describe("Invite people dialog", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    (useStore as unknown as { setState: (s: Record<string, unknown>) => void }).setState({
      serverUrl: "http://test.invalid", refreshVault: vi.fn().mockResolvedValue(undefined),
    });
    api.getJoinCodeInfo.mockResolvedValue({ code: "2TG7KNEA", groupIds: [] });
    api.setJoinCodeGroups.mockImplementation(async (_org: string, ids: string[]) => ids);
    api.inviteMany.mockResolvedValue([]);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const send = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Send"))!;
  const type = async (value: string) => {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Email addresses"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("lays out Role and Access as labelled boxes and pluralises Send", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { orgId: "org-1", onClose: vi.fn(), onInvited: vi.fn() })));
    const fields = [...document.body.querySelectorAll(".invite-field")];
    expect(fields.map((f) => f.querySelector(".invite-field-label")?.textContent)).toEqual(["Role", "Access"]);
    expect(fields[1].querySelector(".invite-field-trigger")?.textContent).toContain("Only what's shared");
    expect(send().textContent).toBe("Send invite");
    expect(send().disabled).toBe(true);
    await type("maya@team.com, jo@team.com ");
    expect(document.body.querySelectorAll(".invite-chip")).toHaveLength(2);
    expect(send().textContent).toBe("Send 2 invites");
    expect(send().disabled).toBe(false);
  });

  it("shows the join code on its own tab", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { orgId: "org-1", onClose: vi.fn(), onInvited: vi.fn() })));
    const codeTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Join code")!;
    await act(async () => codeTab.click());
    expect(document.body.querySelector(".invite-code-tiles")?.getAttribute("aria-label")).toBe("Join code 2TG7KNEA");
    expect(document.body.querySelector('input[aria-label="Email addresses"]')).toBeNull();
    // No footer on this tab: no warning line, no Done button.
    expect(document.body.querySelector(".invite-foot")).toBeNull();
  });

  it("lets the join code add people to access groups, and shows groups that take everyone", async () => {
    const groups = [{ id: "g1", name: "Sales" }, { id: "g2", name: "Design" }, { id: "g3", name: "Everyone", autoJoin: true }];
    await act(async () =>
      root.render(createElement(InvitePeopleDialog, { orgId: "org-1", canSetCodeGroups: true, groups: groups as never, onClose: vi.fn(), onInvited: vi.fn() })),
    );
    const codeTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Join code")!;
    await act(async () => codeTab.click());
    const trigger = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="People who join are added to"]')!;
    expect(trigger().textContent).toMatch(/^Everyone▾?$/);
    await act(async () => trigger().click());
    const item = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((li) => li.textContent?.startsWith(name))!;
    await act(async () => item("Sales").click());
    expect(api.setJoinCodeGroups).toHaveBeenCalledWith("org-1", ["g1"]);
    expect(trigger().textContent).toMatch(/^Everyone \+ 1▾?$/);
    // A group that takes every new member is not toggled from here.
    await act(async () => trigger().click());
    await act(async () => item("Everyone").click());
    expect(api.setJoinCodeGroups).toHaveBeenCalledTimes(1);
  });

  it("says No group when the code adds nobody to a group", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { orgId: "org-1", onClose: vi.fn(), onInvited: vi.fn() })));
    const codeTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Join code")!;
    await act(async () => codeTab.click());
    expect(document.body.querySelector(".invite-code-row")?.textContent).toContain("They get only what is shared with them");
    expect(document.body.querySelector(".invite-code-row .muted")?.textContent).toBe("No group");
  });

  const pick = async (menu: string, label: string) => {
    const trigger = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!;
    await act(async () => trigger.click());
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith(label))!;
    await act(async () => item.click());
  };
  const hint = () => document.body.querySelector(".invite-foot-hint");
  const base = { orgId: "org-1", onClose: vi.fn(), onInvited: vi.fn() };

  it("warns that a member on Only what's shared sees nothing yet; an admin can edit everything", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, base)));
    expect(hint()?.textContent).toBe("They won't see any notes until you share something with them or add them to a group.");
    expect(hint()?.classList.contains("is-warning")).toBe(true);

    await pick("Role", "Admin");
    expect(document.body.querySelector('button[aria-label="Access"]')?.textContent).toContain("Can edit everything");
    expect(hint()?.textContent).toBe("They get an email with a link.");
    await pick("Role", "Member");
    expect(hint()?.classList.contains("is-warning")).toBe(true);
    expect(inviteAccessOptions("admin").map((o) => o.value)).toEqual(["open"]);
    expect(inviteAccessOptions("member").map((o) => o.value)).toEqual(["default", "open", "readonly"]);
  });

  it("never warns that someone sees nothing while the vault's default is still unknown", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...base, defaultKnown: false })));
    expect(hint()?.textContent).toBe("They get an email with a link.");
    expect(hint()?.classList.contains("is-warning")).toBe(false);
  });

  it("in a vault still on an older New members setting, says what joiners actually get", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...base, newMembersAccess: "open" })));
    expect(document.body.querySelector('button[aria-label="Access"]')?.textContent).toContain("Vault default");
    expect(hint()?.textContent).toBe("They get an email with a link.");
    expect(hint()?.classList.contains("is-warning")).toBe(false);
    const codeTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Join code")!;
    await act(async () => codeTab.click());
    expect(document.body.querySelector(".invite-code-row")?.textContent).toContain("New members start on Can edit everything");
    expect(inviteAccessOptions("member", "readonly")[0]).toMatchObject({ value: "default", label: "Vault default", hint: "New members start on Can view everything", tag: "Default" });
    // Only what's shared (the converted model) keeps today's wording and warning.
    expect(inviteAccessOptions("member", "private")[0]).toMatchObject({ value: "default", label: "Only what's shared" });
    expect(inviteAccessOptions("admin", "open").map((o) => o.value)).toEqual(["open"]);
    // Only a vault still on an older Default access passes its setting on;
    // a converted (sealed) or never-shared vault gives joiners their groups.
    expect(legacyNewMembersSetting("edit", "open")).toBe("open");
    expect(legacyNewMembersSetting("view", "readonly")).toBe("readonly");
    expect(legacyNewMembersSetting("sealed", "open")).toBeNull();
    expect(legacyNewMembersSetting("none", "readonly")).toBeNull();
    expect(legacyNewMembersSetting("edit", "private")).toBeNull();
    expect(legacyNewMembersSetting(undefined, "open")).toBeNull();
  });

  it("keeps an Access level picked by hand when the role goes back to Member", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, base)));
    await pick("Access", "Can view everything");
    await pick("Role", "Admin");
    await pick("Role", "Member");
    expect(document.body.querySelector('button[aria-label="Access"]')?.textContent).toContain("Can view everything");
    expect(hint()?.textContent).toBe("They get an email with a link.");
  });

  it("stays quiet when a group takes every new member", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...base, groups: [{ id: "g3", name: "Everyone", autoJoin: true }] as never })));
    expect(hint()?.textContent).toBe("They get an email with a link.");
  });

});
