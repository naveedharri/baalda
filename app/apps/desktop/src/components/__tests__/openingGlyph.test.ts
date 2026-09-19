// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SPINNER_DELAY } from "../../lib/useAsyncAction";
import { OpeningGlyph } from "../OpeningGlyph";

describe("OpeningGlyph", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  function render(opening: boolean) {
    act(() => {
      root.render(
        createElement(OpeningGlyph, {
          opening,
          children: createElement("svg", { "data-testid": "file-glyph" }),
        }),
      );
    });
  }

  it("keeps the file glyph mounted and only adds progress after the shared delay", () => {
    render(false);
    const glyph = host.querySelector('[data-testid="file-glyph"]');
    expect(glyph).not.toBeNull();

    render(true);
    expect(host.querySelector('[data-testid="file-glyph"]')).toBe(glyph);
    expect(host.querySelector(".tree-opening-spinner")).toBeNull();

    act(() => vi.advanceTimersByTime(SPINNER_DELAY - 1));
    expect(host.querySelector(".tree-opening-spinner")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(host.querySelector(".tree-opening-spinner")).not.toBeNull();
    expect(host.querySelector('[data-testid="file-glyph"]')).toBe(glyph);

    render(false);
    expect(host.querySelector(".tree-opening-spinner")).toBeNull();
    expect(host.querySelector('[data-testid="file-glyph"]')).toBe(glyph);
  });
});
