import { describe, expect, it } from "vitest";
import { parseAccountLink } from "../accountLink";
import { ApiError } from "../api";
import { passwordResetFailureMessage } from "../resetFlow";

describe("parseAccountLink", () => {
  it("accepts both foldings of the two links", () => {
    expect(parseAccountLink("baalda://verified")).toBe("verified");
    expect(parseAccountLink("baalda:///verified")).toBe("verified");
    expect(parseAccountLink("baalda://signin")).toBe("signin");
    expect(parseAccountLink("baalda:///signin/")).toBe("signin");
  });

  it("accepts the Staging app's scheme too", () => {
    expect(parseAccountLink("baalda-staging://verified")).toBe("verified");
  });

  it("refuses anything else", () => {
    for (const bad of [
      "baalda://verified/extra",
      "baalda://invite/abc",
      "https://example.com/verified",
      "not a url",
      "baalda://",
    ]) {
      expect(parseAccountLink(bad)).toBeNull();
    }
  });
});

describe("passwordResetFailureMessage", () => {
  const ctx = { email: "a@x.io", serverHost: "notes.example.com" };

  it("names the server when there is no account", () => {
    const msg = passwordResetFailureMessage(new ApiError(404, "no_account", { error: "no_account" }), ctx);
    expect(msg).toContain("a@x.io");
    expect(msg).toContain("notes.example.com");
  });

  it("carries the provider's reason on a send failure", () => {
    const msg = passwordResetFailureMessage(
      new ApiError(502, "send_failed", { error: "send_failed", message: "The mail provider refused the message: 550" }),
      ctx,
    );
    expect(msg).toContain("couldn't be sent");
    expect(msg).toContain("550");
  });

  it("falls back to the error's own message", () => {
    expect(passwordResetFailureMessage(new Error("Load failed"), ctx)).toBe("Load failed");
  });
});
