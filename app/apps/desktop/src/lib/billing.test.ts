import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  classifyLimitError,
  limitFromError,
  planPillLabel,
  subscriptionStatusLine,
  transferTargets,
  type SubscriptionFacts,
  type SubscriptionLineFormat,
} from "./billing";

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

// Deterministic stand-ins for the real formatters, so these assertions don't
// depend on the test machine's locale.
const FMT: SubscriptionLineFormat = {
  date: (iso) => `D(${iso})`,
  price: (amount, currency, interval) => `${currency}${amount / 100}${interval ?? "?"}`,
};

const facts = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: "active",
  currentPeriodEnd: "2026-10-03T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  interval: "month",
  amount: 1000,
  currency: "usd",
  ...over,
});

describe("subscriptionStatusLine", () => {
  it("says nothing about a vault with no subscription", () => {
    expect(subscriptionStatusLine(facts({ status: "none" }), FMT)).toBeNull();
  });

  it("writes the renewal date and the price for a live subscription", () => {
    expect(subscriptionStatusLine(facts(), FMT)).toBe(
      "Renews D(2026-10-03T00:00:00.000Z) · usd10month",
    );
  });

  it("writes an end date, never a renewal, once it is cancelling", () => {
    const line = subscriptionStatusLine(facts({ cancelAtPeriodEnd: true }), FMT);
    expect(line).toBe("Ends D(2026-10-03T00:00:00.000Z)");
    expect(line).not.toContain("Renews");
  });

  it("falls back to prose when a cancelling subscription has no end date", () => {
    expect(
      subscriptionStatusLine(facts({ cancelAtPeriodEnd: true, currentPeriodEnd: null }), FMT),
    ).toBe("Ends at the end of the current period");
  });

  it("lets past_due outrank the date and the price", () => {
    expect(subscriptionStatusLine(facts({ status: "past_due" }), FMT)).toBe("Past due");
    // Even mid-cancellation: the money is the thing to say.
    expect(
      subscriptionStatusLine(facts({ status: "past_due", cancelAtPeriodEnd: true }), FMT),
    ).toBe("Past due");
  });

  it("reports a canceled subscription in the past tense", () => {
    expect(subscriptionStatusLine(facts({ status: "canceled" }), FMT)).toBe(
      "Ended D(2026-10-03T00:00:00.000Z)",
    );
    expect(
      subscriptionStatusLine(facts({ status: "canceled", currentPeriodEnd: null }), FMT),
    ).toBe("Canceled");
  });

  it("omits the price when the provider gave us none", () => {
    expect(subscriptionStatusLine(facts({ amount: null, currency: null }), FMT)).toBe(
      "Renews D(2026-10-03T00:00:00.000Z)",
    );
  });

  it("prices a subscription with no renewal date on its own", () => {
    expect(subscriptionStatusLine(facts({ currentPeriodEnd: null }), FMT)).toBe("usd10month");
  });

  it("returns null for a live subscription we know nothing else about", () => {
    expect(
      subscriptionStatusLine(
        facts({ currentPeriodEnd: null, amount: null, currency: null }),
        FMT,
      ),
    ).toBeNull();
  });

  it("treats a zero amount as a real price, not a missing one", () => {
    expect(subscriptionStatusLine(facts({ amount: 0, currentPeriodEnd: null }), FMT)).toBe(
      "usd0month",
    );
  });
});

describe("planPillLabel", () => {
  it("labels every free vault Free, whatever its dead subscription says", () => {
    expect(planPillLabel({ plan: "free", status: "none" })).toBe("Free");
    expect(planPillLabel({ plan: "free", status: "canceled" })).toBe("Free");
  });

  it("labels a healthy Pro just Pro", () => {
    expect(planPillLabel({ plan: "pro", status: "active" })).toBe("Pro");
  });

  it("surfaces the states worth interrupting for", () => {
    expect(planPillLabel({ plan: "pro", status: "past_due" })).toBe("Past due");
    expect(planPillLabel({ plan: "pro", status: "canceled" })).toBe("Canceled");
  });
});

describe("transferTargets", () => {
  const v = (
    orgId: string,
    role: "owner" | "admin" | "member",
    plan: "free" | "pro",
    status: SubscriptionFacts["status"] = plan === "pro" ? "active" : "none",
  ) => ({ orgId, role, plan, status });

  const all = [
    v("src", "owner", "pro"),
    v("mine-free", "owner", "free"),
    v("mine-pro", "owner", "pro"),
    v("admin-free", "admin", "free"),
    v("member-free", "member", "free"),
    v("mine-canceled", "owner", "free", "canceled"),
  ];

  it("offers owned free vaults, including one whose old subscription is canceled", () => {
    expect(transferTargets(all, "src").map((t) => t.orgId)).toEqual([
      "mine-free",
      "mine-canceled",
    ]);
  });

  it("never offers the source itself", () => {
    expect(transferTargets(all, "mine-free").map((t) => t.orgId)).toEqual(["mine-canceled"]);
  });

  it("refuses vaults the caller only administers or belongs to", () => {
    const ids = transferTargets(all, "src").map((t) => t.orgId);
    expect(ids).not.toContain("admin-free");
    expect(ids).not.toContain("member-free");
  });

  it("refuses a vault that is already paying", () => {
    const ids = transferTargets(all, "src").map((t) => t.orgId);
    expect(ids).not.toContain("mine-pro");
    expect(
      transferTargets([v("t", "owner", "free", "past_due")], "src").map((t) => t.orgId),
    ).toEqual([]);
  });

  it("returns an empty list when there is nowhere to move it", () => {
    expect(transferTargets([v("src", "owner", "pro")], "src")).toEqual([]);
    expect(transferTargets([], "src")).toEqual([]);
  });
});
