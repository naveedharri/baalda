import { afterEach, describe, expect, it } from "vitest";
import { clearToasts, dismissToast, getToasts, toast } from "../toast";

// The emitter, without React. What's worth pinning is the handful of rules a
// careless change would quietly reverse — each of which is the difference
// between a useful notification and one that actively misleads.

afterEach(() => clearToasts());

describe("toast", () => {
  it("defaults to success and keeps insertion order", () => {
    toast("first");
    toast("second", "neutral");
    expect(getToasts().map((t) => [t.text, t.tone])).toEqual([
      ["first", "success"],
      ["second", "neutral"],
    ]);
  });

  it("gives errors NO ttl, so a failure can't be missed", () => {
    // The rule this protects: an error that auto-dismissed while the user was
    // looking elsewhere becomes "the button did nothing" in a bug report.
    toast("saved", "success");
    toast("could not save", "error");
    const [ok, bad] = getToasts();
    expect(ok.ttl).toBeGreaterThan(0);
    expect(bad.ttl).toBe(0);
  });

  it("caps the stack, dropping the OLDEST", () => {
    for (let i = 1; i <= 7; i++) toast(`t${i}`);
    // Newest survive: an old confirmation is worth less than a fresh one, and a
    // stack taller than the window is just noise.
    expect(getToasts().map((t) => t.text)).toEqual(["t4", "t5", "t6", "t7"]);
  });

  it("hands out unique ids and dismisses only the named toast", () => {
    const a = toast("a");
    const b = toast("b");
    expect(a).not.toBe(b);
    dismissToast(a);
    expect(getToasts().map((t) => t.text)).toEqual(["b"]);
  });

  it("treats a repeat or unknown dismiss as a no-op", () => {
    // The auto-dismiss timer and a user's click race on every toast, and one of
    // them always loses. Losing must be free, not an exception.
    const id = toast("a");
    dismissToast(id);
    dismissToast(id);
    dismissToast(4242);
    expect(getToasts()).toEqual([]);
  });

  it("replaces the array on every change rather than mutating in place", () => {
    // `useToasts` stores this array in React state, so an in-place mutation
    // would be an identity-equal update and the viewport would never re-render.
    const before = getToasts();
    toast("a");
    expect(getToasts()).not.toBe(before);
  });

  it("clearToasts empties the stack", () => {
    toast("a");
    toast("b", "error");
    clearToasts();
    expect(getToasts()).toEqual([]);
  });
});
