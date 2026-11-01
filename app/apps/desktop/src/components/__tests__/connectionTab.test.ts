// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const recents = vi.hoisted(() => ({
  readRecentServers: vi.fn(() => ["https://a.example.com", "https://b.example.com"]),
  switchServer: vi.fn(),
}));
vi.mock("../../lib/auth/recentServers", () => recents);

import { ConnectionTab } from "../AccountSettings";
import { useStore } from "../../store";

it("picks a recent server from its chip and keeps the active one marked", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A trailing slash still matches its normalized recent entry.
  useStore.setState({ serverUrl: "https://a.example.com/" } as never);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ConnectionTab)));
    expect(host.querySelector("select")).toBeNull();
    const chips = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Recent connections"] button')];
    expect(chips.map((c) => c.textContent)).toEqual(["a.example.com", "b.example.com"]);
    expect(chips[0].classList.contains("is-active")).toBe(true);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    // Opening the tab reads the history; it never records (reorders) it.
    expect(recents.switchServer).not.toHaveBeenCalled();

    await act(async () => chips[1].click());
    const input = host.querySelector('input[aria-label="Server address"]') as HTMLInputElement;
    expect(input.value).toBe("https://b.example.com");
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    expect(chips[1].classList.contains("is-active")).toBe(false);
    expect(host.textContent).not.toContain("Reconnected.");
    expect(recents.switchServer).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
