// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsControls } from "../WindowsControls";

const win = vi.hoisted(() => ({
  isMaximized: vi.fn(), onResized: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

describe("WindowsControls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let stop: ReturnType<typeof vi.fn<() => void>>;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
    stop = vi.fn();
    win.isMaximized.mockResolvedValue(false);
    win.onResized.mockResolvedValue(stop);
    win.minimize.mockResolvedValue(undefined);
    win.toggleMaximize.mockResolvedValue(undefined);
    win.close.mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const render = async () => { await act(async () => root.render(createElement(WindowsControls))); };

  it("invokes caption commands and updates Restore after a native maximize", async () => {
    await render();
    expect(host.querySelectorAll("button")).toHaveLength(3);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Maximize"]')!.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Close window"]')!.click();
    });
    expect(win.minimize).toHaveBeenCalledOnce();
    expect(win.toggleMaximize).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();
    win.isMaximized.mockResolvedValue(true);
    await act(async () => win.onResized.mock.calls[0][0]());
    expect(host.querySelector('[aria-label="Restore"]')).not.toBeNull();
    act(() => root.unmount());
    expect(stop).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it("cleans up a resize subscription that resolves after unmount", async () => {
    let subscribe!: (value: () => void) => void;
    win.onResized.mockReturnValue(new Promise<() => void>((resolve) => { subscribe = resolve; }));
    await render();
    act(() => root.unmount());
    await act(async () => subscribe(stop));
    expect(stop).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it("does not render or subscribe on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh; Intel Mac OS X");
    await render();
    expect(host.childElementCount).toBe(0);
    expect(win.onResized).not.toHaveBeenCalled();
    expect(win.isMaximized).not.toHaveBeenCalled();
  });
});
