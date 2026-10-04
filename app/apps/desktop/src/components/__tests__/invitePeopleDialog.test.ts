// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePeopleDialog } from "../InvitePeopleDialog";
import { useStore } from "../../store";

const api = vi.hoisted(() => ({ getJoinCode: vi.fn(), inviteMany: vi.fn() }));
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
    api.getJoinCode.mockResolvedValue("2TG7KNEA");
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
    expect(fields[1].querySelector(".invite-field-trigger")?.textContent).toContain("Default for new members");
    expect(document.body.querySelector(".invite-people-code-value")?.textContent).toBe("2TG7KNEA");
    expect(send().textContent).toBe("Send invite");
    expect(send().disabled).toBe(true);
    await type("maya@team.com, jo@team.com ");
    expect(document.body.querySelectorAll(".invite-chip")).toHaveLength(2);
    expect(send().textContent).toBe("Send invites");
    expect(send().disabled).toBe(false);
  });
});
