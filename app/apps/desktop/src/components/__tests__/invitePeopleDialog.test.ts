// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePeopleDialog, inviteAccessOptions } from "../InvitePeopleDialog";
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
    expect(fields[1].querySelector(".invite-field-trigger")?.textContent).toContain("Vault default");
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

  it("lets the join code add people to access groups, keeping the level", async () => {
    const onNewMembersAccess = vi.fn();
    const groups = [{ id: "g1", name: "Sales" }, { id: "g2", name: "Design" }];
    await act(async () =>
      root.render(
        createElement(InvitePeopleDialog, {
          orgId: "org-1", newMembersAccess: "private", onNewMembersAccess, groups: groups as never,
          onClose: vi.fn(), onInvited: vi.fn(),
        }),
      ),
    );
    const codeTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Join code")!;
    await act(async () => codeTab.click());
    const trigger = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="People who join get"]')!;
    await act(async () => trigger().click());
    const sales = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((li) => li.textContent?.startsWith("Sales"))!;
    await act(async () => sales.click());
    expect(api.setJoinCodeGroups).toHaveBeenCalledWith("org-1", ["g1"]);
    expect(onNewMembersAccess).not.toHaveBeenCalled();
    expect(trigger().textContent).toContain("No access + Sales");
  });

  const pick = async (menu: string, label: string) => {
    const trigger = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!;
    await act(async () => trigger.click());
    const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((li) => li.textContent?.startsWith(label))!;
    await act(async () => item.click());
  };
  const hint = () => document.body.querySelector(".invite-foot-hint");
  const onlyShared = { orgId: "org-1", newMembersAccess: "private" as const, defaultAccess: "private" as const, onClose: vi.fn(), onInvited: vi.fn() };

  it("warns that a member on the vault default sees nothing yet; an admin starts on Can edit everything", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, onlyShared)));
    expect(hint()?.textContent).toBe("They won't see any notes until you share something with them or add them to a group.");
    expect(hint()?.classList.contains("is-warning")).toBe(true);

    await pick("Role", "Admin");
    expect(document.body.querySelector('button[aria-label="Access"]')?.textContent).toContain("Can edit");
    expect(hint()?.textContent).toBe("They get an email with a link.");
    // Back to Member: back on the vault default, warning included.
    await pick("Role", "Member");
    expect(hint()?.classList.contains("is-warning")).toBe(true);
  });

  it("starts an admin on Can edit everything when New members is already Can edit", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...onlyShared, newMembersAccess: "open" as const, defaultAccess: "open" as const })));
    await pick("Role", "Admin");
    const trigger = document.body.querySelector('button[aria-label="Access"]')!;
    expect(trigger.textContent).toContain("Can edit");
    expect(trigger.textContent).not.toContain("open");
    // Every level is explicit for an admin, with the vault default beside them.
    expect(inviteAccessOptions("open", "admin").map((o) => o.value)).toEqual(["open", "readonly", "private", "default"]);
    expect(inviteAccessOptions("open", "member").map((o) => o.value)).toEqual(["default", "readonly", "private"]);
  });

  it("keeps an Access level picked by hand when the role changes", async () => {
    await act(async () => root.render(createElement(InvitePeopleDialog, onlyShared)));
    await pick("Access", "Can view");
    await pick("Role", "Admin");
    expect(document.body.querySelector('button[aria-label="Access"]')?.textContent).toContain("Can view");
  });

  it("says No access is lifted only by changing their access, and stays quiet when Default access opens notes", async () => {
    // New members on Can edit, so No access here is a level of their own.
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...onlyShared, newMembersAccess: "open" as const })));
    await pick("Access", "No access");
    expect(hint()?.textContent).toBe("They won't see any notes until you change their access.");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(InvitePeopleDialog, { ...onlyShared, defaultAccess: "open" as const })));
    expect(hint()?.textContent).toBe("They get an email with a link.");
  });
});
