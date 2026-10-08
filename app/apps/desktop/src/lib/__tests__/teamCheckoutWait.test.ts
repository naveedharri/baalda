import { describe, expect, it } from "vitest";
import { checkoutPollDelay, teamCheckoutPaid } from "../billing";

describe("teamCheckoutPaid", () => {
  it("unlocks on the Team plan or a paid status", () => {
    expect(teamCheckoutPaid({ plan: "team", status: "none" })).toBe(true);
    expect(teamCheckoutPaid({ plan: "free", status: "active" })).toBe(true);
    expect(teamCheckoutPaid({ plan: "free", status: "past_due" })).toBe(true);
  });
  it("keeps waiting on Free, canceled or no answer", () => {
    expect(teamCheckoutPaid({ plan: "free", status: "none" })).toBe(false);
    expect(teamCheckoutPaid({ plan: "free", status: "canceled" })).toBe(false);
    expect(teamCheckoutPaid(null)).toBe(false);
  });
});

describe("checkoutPollDelay", () => {
  it("polls every 3 s for a minute, then every 10 s", () => {
    expect(checkoutPollDelay(0)).toBe(3_000);
    expect(checkoutPollDelay(59_999)).toBe(3_000);
    expect(checkoutPollDelay(60_000)).toBe(10_000);
  });
});
