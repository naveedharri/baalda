// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../ErrorBoundary";
import { AppCrashFallback } from "../AppCrashFallback";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new Error("render failed");
}

describe("AppCrashFallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("replaces a blank window with a message and a working Reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const onError = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ErrorBoundary, {
          label: "Baalda",
          onError,
          fallback: (error: Error) => createElement(AppCrashFallback, { error, reload }),
          children: createElement(Boom),
        }),
      );
    });
    expect(host.textContent).toContain("Baalda hit a problem");
    expect(host.textContent).toContain("render failed");
    expect(onError).toHaveBeenCalledTimes(1);
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!;
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
