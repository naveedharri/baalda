// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarHeader } from "../SidebarHeader";

vi.mock("../../store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({
    vault: { path: "/vault", name: "Product" }, session: null,
    organizations: [], syncEnabled: false, switchingVault: null,
    structureNotice: { rootMissing: false },
  }),
}));
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../lib/toast", () => ({ toast: vi.fn() }));
vi.mock("../VaultSwitcher", () => ({
  useSwitcherRows: () => [],
  useVaultShortcuts: () => {},
  VaultTile: () => createElement("span", null, "P"),
  VaultSwitcherPopover: ({ rows: _rows, onClose, ...events }: any) => createElement("div", {
    className: "vault-switcher", ...events,
  }, createElement("input", { "aria-label": "New vault name" }),
  createElement("button", { onClick: onClose }, "Select vault")),
}));

describe("vault switcher hover and click", () => {
  let host: HTMLDivElement;
  let root: Root;
  const tile = () => host.querySelector<HTMLButtonElement>(".vault-switch-tile")!;
  const menu = () => host.querySelector<HTMLDivElement>(".vault-switcher");
  const point = (element: Element, type: string, pointerType = "mouse", relatedTarget: EventTarget = document.body) => {
    const event = new MouseEvent(type, { bubbles: true, relatedTarget });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    act(() => element.dispatchEvent(event));
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(SidebarHeader)));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bridges the tile-to-menu gap and closes after leaving the menu", () => {
    point(tile(), "pointerover");
    expect(menu()).not.toBeNull();
    point(tile(), "pointerout");
    advance(100);
    point(menu()!, "pointerover");
    advance(300);
    expect(menu()).not.toBeNull();
    point(menu()!, "pointerout");
    advance(220);
    expect(menu()).toBeNull();
  });

  it("pins a hover preview on click and closes on a second click", () => {
    point(tile(), "pointerover");
    act(() => tile().click());
    point(tile(), "pointerout");
    advance(300);
    expect(menu()).not.toBeNull();
    act(() => tile().click());
    expect(menu()).toBeNull();
  });

  it("keeps an interacted-with form open, while selection still closes", () => {
    point(tile(), "pointerover");
    point(menu()!.querySelector("input")!, "pointerdown");
    point(menu()!, "pointerout");
    advance(300);
    expect(menu()).not.toBeNull();
    act(() => menu()!.querySelector("button")!.click());
    expect(menu()).toBeNull();
  });

  it("pins keyboard focus and allows Escape and outside dismissal", () => {
    point(tile(), "pointerover");
    act(() => menu()!.querySelector("input")!.focus());
    point(menu()!, "pointerout");
    advance(300);
    expect(menu()).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".vault-switch-btn")!.click());
    point(document.body, "pointerdown");
    expect(menu()).toBeNull();
  });

  it("does not interpret a touch pointer as hover", () => {
    point(tile(), "pointerover", "touch");
    expect(menu()).toBeNull();
    act(() => tile().click());
    expect(menu()).not.toBeNull();
  });
});
