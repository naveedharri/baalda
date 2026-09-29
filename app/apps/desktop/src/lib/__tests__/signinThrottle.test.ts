import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { humanizeWait, signInRetryAfter, throttleMessage } from "../signinThrottle";

describe("sign-in throttle message", () => {
  it("reads the wait from a 429 body and ignores other errors", () => {
    expect(signInRetryAfter(new ApiError(429, "x", { retryAfterSeconds: 42.2 }))).toBe(43);
    expect(signInRetryAfter(new ApiError(429, "x"))).toBe(60);
    expect(signInRetryAfter(new ApiError(401, "x", { retryAfterSeconds: 10 }))).toBeNull();
    expect(signInRetryAfter(new Error("x"))).toBeNull();
  });

  it("humanizes the wait", () => {
    expect(humanizeWait(1)).toBe("1 second");
    expect(humanizeWait(45)).toBe("45 seconds");
    expect(humanizeWait(60)).toBe("1 minute");
    expect(humanizeWait(61)).toBe("2 minutes");
    expect(humanizeWait(900)).toBe("15 minutes");
  });

  it("matches the issue's wording", () => {
    expect(throttleMessage(60)).toBe("Too many attempts. Try again in 1 minute, or reset your password.");
  });
});
