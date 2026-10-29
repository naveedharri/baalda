import { describe, expect, it } from "vitest";
import { ApiError, rateLimitedMessage } from "../api";

describe("rateLimitedMessage (account-key churn brake)", () => {
  it("returns the server's plain message for 429 rate_limited", () => {
    const msg = "Your security key was replaced 3 times in the last day. Try again in about 20 hours.";
    expect(rateLimitedMessage(new ApiError(429, "x", { error: msg, code: "rate_limited", retryAfter: 72000 }))).toBe(msg);
  });

  it("falls back to a plain sentence when the body has no message", () => {
    expect(rateLimitedMessage(new ApiError(429, "x", { code: "rate_limited" }))).toMatch(/Try again later/);
  });

  it("is null for anything else (other 429s, other errors)", () => {
    expect(rateLimitedMessage(new ApiError(429, "x", { code: "too_many_pending" }))).toBeNull();
    expect(rateLimitedMessage(new ApiError(409, "x", { code: "rate_limited" }))).toBeNull();
    expect(rateLimitedMessage(new Error("network"))).toBeNull();
  });
});
