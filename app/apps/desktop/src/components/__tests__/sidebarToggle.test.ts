// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarToggle } from "../SidebarToggle";

describe("SidebarToggle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("reflects both visibility states without firing during render", () => {
    const onToggle = vi.fn();
    const onSearch = vi.fn();
    act(() => root.render(createElement(SidebarToggle, {
      hidden: false, onToggle, searchOpen: false, onSearch,
    })));
    const button = host.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
    expect(button.getAttribute("aria-label")).toBe("Hide sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("vault-sidebar");
    expect(onToggle).not.toHaveBeenCalled();

    act(() => root.render(createElement(SidebarToggle, {
      hidden: true, onToggle, searchOpen: true, onSearch,
    })));
    expect(button.getAttribute("aria-label")).toBe("Show sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(onToggle).not.toHaveBeenCalled();
    const search = host.querySelector<HTMLButtonElement>(".titlebar-search")!;
    expect(search.title).toBe("Search notes (⌘F)");
    expect(search.getAttribute("aria-pressed")).toBe("true");
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("toggles only when clicked", () => {
    const onToggle = vi.fn();
    const onSearch = vi.fn();
    act(() => root.render(createElement(SidebarToggle, {
      hidden: false, onToggle, searchOpen: false, onSearch,
    })));
    act(() => host.querySelector<HTMLButtonElement>(".sidebar-toggle")!.click());
    expect(onToggle).toHaveBeenCalledOnce();
    act(() => host.querySelector<HTMLButtonElement>(".titlebar-search")!.click());
    expect(onSearch).toHaveBeenCalledOnce();
  });
});
