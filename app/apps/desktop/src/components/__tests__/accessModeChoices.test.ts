// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessModeChoices, type CurrentAccessMode } from "../AccessPanel";

describe("AccessModeChoices", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    onSelect.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(currentMode: CurrentAccessMode) {
    act(() => root.render(createElement(AccessModeChoices, {
      currentMode,
      busy: false,
      disabled: false,
      onSelect,
    })));
  }

  const button = (mode: string) => host.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)!;

  it("renders Read-only as the selected current state without applying it", () => {
    render("readonly");

    expect(button("readonly").classList.contains("active")).toBe(true);
    expect(button("readonly").getAttribute("aria-pressed")).toBe("true");
    expect(button("open").getAttribute("aria-pressed")).toBe("false");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("updates the presentation without treating selection as a write", () => {
    render(null);
    render("private");

    expect(button("private").classList.contains("active")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    act(() => button("open").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("open");
  });

  it("shows a mixed indicator and leaves every action unpressed", () => {
    act(() => root.render(createElement(AccessModeChoices, {
      currentMode: "mixed",
      busy: false,
      disabled: false,
      statusMessage: "Selected people or items currently have mixed access.",
      onSelect,
    })));

    expect(host.querySelector('[role="status"]')?.textContent).toContain("mixed access");
    for (const mode of ["open", "readonly", "private"]) {
      expect(button(mode).classList.contains("active")).toBe(false);
      expect(button(mode).getAttribute("aria-pressed")).toBe("false");
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("explains an empty people audience while keeping every action disabled", () => {
    act(() => root.render(createElement(AccessModeChoices, {
      currentMode: null,
      busy: false,
      disabled: true,
      statusMessage: "Select a person to view their access.",
      onSelect,
    })));

    expect(host.querySelector('[role="status"]')?.textContent).toBe("Select a person to view their access.");
    for (const mode of ["open", "readonly", "private"]) expect(button(mode).disabled).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
