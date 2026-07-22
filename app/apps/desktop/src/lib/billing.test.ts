import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { classifyLimitError, limitFromError } from "./billing";

describe("classifyLimitError", () => {
  it("returns null for non-ApiError values", () => {
    expect(classifyLimitError(new Error("boom"))).toBeNull();
    expect(classifyLimitError("nope")).toBeNull();
    expect(classifyLimitError(null)).toBeNull();
  });

  it("returns null for non-402 ApiErrors even with the token present", () => {
    expect(
      classifyLimitError(new ApiError(403, "member_limit_reached", { error: "member_limit_reached" })),
    ).toBeNull();
    expect(classifyLimitError(new ApiError(500, "boom"))).toBeNull();
  });

  it("classifies a 402 with a clean vault token body", () => {
    const e = new ApiError(402, "vault_limit_reached", {
      error: "vault_limit_reached",
      limit: 3,
    });
    expect(classifyLimitError(e)).toBe("vault_limit");
  });

  it("classifies a 402 with a clean member token body", () => {
    const e = new ApiError(402, "member_limit_reached", {
      error: "member_limit_reached",
      limit: 3,
    });
    expect(classifyLimitError(e)).toBe("member_limit");
  });

  it("classifies when the token is only in the message (Better Auth path)", () => {
    // Body shape uncontrolled, but the message carries the literal token.
    const e = new ApiError(402, "Upgrade required: member_limit_reached", {
      code: "PLAN_LIMIT",
    });
    expect(classifyLimitError(e)).toBe("member_limit");
  });

  it("classifies when the token is only in a stringified body", () => {
    const e = new ApiError(402, "HTTP 402", "vault_limit_reached");
    expect(classifyLimitError(e)).toBe("vault_limit");
  });

  it("returns null for a 402 without any contract token", () => {
    expect(classifyLimitError(new ApiError(402, "payment required", { error: "card_declined" }))).toBeNull();
  });
});

describe("limitFromError", () => {
  it("extracts a numeric limit from the body", () => {
    expect(limitFromError(new ApiError(402, "member_limit_reached", { limit: 3 }))).toBe(3);
  });

  it("returns null when there's no numeric limit", () => {
    expect(limitFromError(new ApiError(402, "member_limit_reached", { error: "x" }))).toBeNull();
    expect(limitFromError(new ApiError(402, "x", "string body"))).toBeNull();
    expect(limitFromError(new Error("boom"))).toBeNull();
  });
});
