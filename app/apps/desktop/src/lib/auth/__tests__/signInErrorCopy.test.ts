import { describe, expect, it } from "vitest";
import { GOOGLE_NO_PASSWORD_HINT, signInErrorCopy } from "../signInErrorCopy";

describe("signInErrorCopy", () => {
  it("shows only the main sentence on the first failure", () => {
    expect(signInErrorCopy("Invalid email or password", { googleEnabled: true, attempts: 1 })).toEqual({
      message: "Invalid email or password.",
      hint: null,
    });
  });

  it("adds the Google hint from the second failure for the same email", () => {
    expect(signInErrorCopy("Invalid email or password", { googleEnabled: true, attempts: 2 }).hint).toBe(
      GOOGLE_NO_PASSWORD_HINT,
    );
  });

  it("never shows the Google hint when Google sign-in is not offered", () => {
    expect(signInErrorCopy("Invalid email or password", { googleEnabled: false, attempts: 5 }).hint).toBeNull();
  });

  it("passes other errors through unchanged", () => {
    expect(signInErrorCopy("Network error", { googleEnabled: true, attempts: 3 })).toEqual({
      message: "Network error",
      hint: null,
    });
  });
});
