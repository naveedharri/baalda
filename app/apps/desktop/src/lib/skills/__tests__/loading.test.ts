import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadTimeoutError, loadErrorText, withTimeout } from "../loading";

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("passes a value through when it arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  it("rejects with LoadTimeoutError when the request hangs", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 1000);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toBeInstanceOf(LoadTimeoutError);
  });

  it("passes the original error through", async () => {
    await expect(withTimeout(Promise.reject(new Error("nope")), 50)).rejects.toThrow("nope");
  });
});

describe("loadErrorText", () => {
  it("never answers empty", () => {
    expect(loadErrorText(new Error(""))).toBe("Something went wrong.");
    expect(loadErrorText("x")).toBe("x");
    expect(loadErrorText(new LoadTimeoutError())).toMatch(/too long/);
  });
});
