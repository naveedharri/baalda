import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  isLegacyPlan,
  legacyPlanLine,
  membersSeatLine,
  invitePrewarning,
  freePeopleCopy,
  seatBreakdown,
  formatBytes,
  planPriceLine,
  seatChangeSummary,
  seatsUpdatedToast,
  seatUsageLines,
  usageAgainstLimit,
  classifyLimitError,
  FREE_PLAN_EXPLANATION,
  limitFromError,
  planPillLabel,
  PRO_BENEFITS,
  TEAM_BENEFITS,
  FREE_PLAN_LACKS,
  FREE_PLAN_INCLUDES,
  LIMIT_CODES,
  seatLimitFromError,
  seatBounds,
  defaultSeats,
  seatTotalCents,
  seatTotalLine,
  yearlySavingsLabel,
  billingErrorMessage,
  discountLine,
  RESUME_TO_CHANGE_SEATS,
  seatChangeLocked,
  vaultPlanLine,
  planStatusPill,
  formatMoney,
  seatsFullCopy,
  subscriptionStatusLine,
  transferTargets,
  type SubscriptionFacts,
  type SubscriptionLineFormat,
  seatsDialogSubtitle,
  invitedCountAriaLabel,
  invitedTotalLabel,
  invitedVaultAction,
  invitedVaultFallbackToast,
  invitedVaults,
} from "./billing";

describe("plan benefits copy", () => {
  it("explains the Free note allowance and Team benefits", () => {
    expect(PRO_BENEFITS).toContain("Standalone file sync");
    expect(PRO_BENEFITS.join(" ")).not.toMatch(/unlimited notes|AI edits/i);
    expect(FREE_PLAN_EXPLANATION).toMatch(/note sync, embedded attachments/i);
    expect(FREE_PLAN_EXPLANATION).toMatch(/embedded attachments/i);
    expect(FREE_PLAN_EXPLANATION).toMatch(/standalone file sync/i);
  });
});

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

  it("labels a healthy paid plan just Team", () => {
    expect(planPillLabel({ plan: "pro", status: "active" })).toBe("Team");
    expect(planPillLabel({ plan: "team", status: "active" })).toBe("Team");
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

it("recognizes the note sync quota upgrade error", () => {
  expect(classifyLimitError(new ApiError(402, "Upgrade", { code: "note_limit_reached", limit: 20000 }))).toBe("note_limit");
});

describe("Team plan copy", () => {
  it("drops the stray line and keeps the old export as an alias", () => {
    expect(TEAM_BENEFITS.join(" ")).not.toMatch(/TypeSafe/);
    expect(PRO_BENEFITS).toBe(TEAM_BENEFITS);
    expect(FREE_PLAN_LACKS).toContain("Standalone file sync");
    expect(TEAM_BENEFITS).toEqual([
      "Unlimited people, one seat each",
      "Unlimited synced vaults",
      "Standalone file sync",
      "Baalda Assistant",
      "Priority support",
    ]);
    expect(FREE_PLAN_INCLUDES).toEqual([
      "2 people",
      "1 synced vault",
      "Unlimited notes and attachments",
      "MCP for your AI tools",
      "Real-time collaboration",
    ]);
    expect(FREE_PLAN_EXPLANATION).toMatch(/2 people/);
    expect(seatsFullCopy(5)).toBe("All 5 seats are in use.");
    expect(seatsFullCopy(null)).toBe("All seats are in use.");
  });
});

describe("seat helpers", () => {
  it("floors the stepper at max(minSeats, used) with no ceiling", () => {
    expect(seatBounds(1, 3)).toEqual({ min: 3, max: null });
    expect(seatBounds(3, 3)).toEqual({ min: 3, max: null });
    expect(seatBounds(7, 3)).toEqual({ min: 7, max: null });
    expect(defaultSeats(1, 3)).toBe(3);
    expect(defaultSeats(7, 3)).toBe(7);
  });

  it("totals monthly and yearly prices", () => {
    expect(seatTotalCents(5, 1000)).toBe(5000);
    expect(seatTotalCents(5, 11000)).toBe(55000);
    expect(seatTotalLine(5, 1000, "usd", "month")).toBe("5 seats × $10 = $50/mo");
    expect(seatTotalLine(3, 11000, "usd", "year")).toBe("3 seats × $110 = $330/yr");
    expect(formatMoney(1050, "usd")).toBe("$10.50");
  });

  it("computes the yearly saving from the configured prices", () => {
    const team = (prices: { interval: "month" | "year"; perSeat: number }[]) => ({
      team: { minSeats: 3, currency: "usd", prices },
    });
    expect(
      yearlySavingsLabel(team([{ interval: "month", perSeat: 1000 }, { interval: "year", perSeat: 11000 }])),
    ).toBe("Save 8%");
    expect(
      yearlySavingsLabel(team([{ interval: "month", perSeat: 1000 }, { interval: "year", perSeat: 9600 }])),
    ).toBe("Save 20%");
    expect(yearlySavingsLabel(team([{ interval: "month", perSeat: 1000 }]))).toBeNull();
    expect(yearlySavingsLabel({})).toBeNull();
    expect(yearlySavingsLabel(null)).toBeNull();
  });

  it("writes one discount line with the saving only when charged is below list", () => {
    expect(
      discountLine({ interval: "month", price: { list: 1000, charged: 500, discountName: "legacy" } }),
    ).toBe("Legacy price $5/mo · saving $5/mo");
    expect(
      discountLine({ interval: "year", price: { list: 33000, charged: 0, discountName: "legacy-acc_1" } }),
    ).toBe("Legacy price $0/yr · saving $330/yr");
    expect(
      discountLine({ interval: "year", price: { list: 33000, charged: 0, discountName: "LAUNCH100" } }),
    ).toBe("Discount LAUNCH100 · saving $330/yr");
    expect(
      discountLine({ interval: "month", price: { list: 3000, charged: 1000, discountName: null } }),
    ).toBe("Discounted · saving $20/mo");
  });

  it("omits the discount line when nothing is saved", () => {
    expect(
      discountLine({ interval: "month", price: { list: 1000, charged: 1000, discountName: null } }),
    ).toBeNull();
    expect(
      discountLine({ interval: "month", price: { list: 1000, charged: 1200, discountName: "legacy" } }),
    ).toBeNull();
    expect(discountLine({ interval: null, price: null })).toBeNull();
  });

  it("says when a discount ends: once, repeating, forever", () => {
    const price = { list: 209000, charged: 0, discountName: "Team Ben" };
    expect(
      discountLine({ interval: "year", price: { ...price, discountDuration: "once", renewalAmount: 209000 } }),
    ).toBe("Discount Team Ben applied to your first payment · renews at $2,090/yr");
    expect(
      discountLine({
        interval: "month",
        price: { list: 3000, charged: 1500, discountName: "HALF", discountDuration: "repeating", discountDurationMonths: 3, renewalAmount: 1500 },
      }),
    ).toBe("Discount HALF for 3 months · then $15/mo");
    expect(
      discountLine({ interval: "year", price: { ...price, discountDuration: "forever", renewalAmount: 0 } }),
    ).toBe("Discount Team Ben · saving $2,090/yr");
    // An older server sends no duration: today's wording.
    expect(discountLine({ interval: "year", price })).toBe("Discount Team Ben · saving $2,090/yr");
  });
});

describe("Team limit codes", () => {
  const err = (body: unknown, status = 402) => new ApiError(status, "rejected", body);

  it("classifies every 402 code", () => {
    expect(classifyLimitError(err({ error: "seat_limit_reached", seats: 5, used: 5, pending: 1 }))).toBe("seat_limit");
    expect(classifyLimitError(err({ error: "account_read_only" }))).toBe("read_only");
    expect(classifyLimitError(err({ error: "housekeeper_requires_team" }))).toBe("housekeeper");
    expect(classifyLimitError(err({ error: "housekeeper_requires_pro" }))).toBe("housekeeper");
    expect(classifyLimitError(err({ error: "attachment_sync_requires_pro", requiredPlan: "team" }))).toBe("attachment");
    expect(classifyLimitError(err({ error: "storage_limit_reached" }))).toBe("storage_limit");
    expect(classifyLimitError(err({ error: "member_limit_reached", limit: 2, scope: "account" }))).toBe("member_limit");
    expect(classifyLimitError(err({ error: "seat_limit_reached" }, 403))).toBeNull();
    for (const [code, kind] of LIMIT_CODES) expect(classifyLimitError(err({ error: code }))).toBe(kind);
  });

  it("reads seat counts off a seat_limit_reached error", () => {
    expect(seatLimitFromError(err({ error: "seat_limit_reached", seats: 5, used: 5, pending: 1 }))).toEqual({
      seats: 5,
      used: 5,
      pending: 1,
    });
    expect(seatLimitFromError(err({ error: "seat_limit_reached" }))).toEqual({
      seats: null,
      used: null,
      pending: null,
    });
    expect(seatLimitFromError(err({ error: "member_limit_reached" }))).toBeNull();
  });

  it("labels the pill variants", () => {
    expect(planPillLabel({ plan: "team", status: "active", complimentary: true })).toBe("Team (complimentary)");
    expect(planPillLabel({ plan: "team", status: "canceled", lapsed: true })).toBe("Read-only");
    expect(planPillLabel({ plan: "team", status: "active", readOnly: true })).toBe("Read-only");
    expect(planPillLabel({ plan: "team", status: "past_due" })).toBe("Past due");
  });
});

describe("Plan & Billing helpers", () => {
  const fmt = (iso: string) => iso.slice(0, 10);
  const base = {
    current: 5,
    floor: 4,
    used: 4,
    minSeats: 3,
    currency: "usd",
    interval: "month" as const,
    formatDate: fmt,
  };
  const preview = { proratedNow: 1250, newAmount: 6000, currentPeriodEnd: "2026-11-01T00:00:00Z" };

  it("seatChangeSummary: the already-scheduled count shows nothing and cannot confirm", () => {
    const at = { ...base, current: 19, scheduled: 3, floor: 3 };
    const p = { ...preview, currentPeriodEnd: "2027-10-08T00:00:00Z" };
    expect(seatChangeSummary({ ...at, seats: 3, preview: p })).toEqual({ text: null, canConfirm: false });
    expect(seatChangeSummary({ ...at, seats: 4, preview: p })).toEqual({
      text: "Goes down to 4 seats on 2027-10-08.",
      canConfirm: true,
    });
    expect(seatChangeSummary({ ...at, seats: 19, preview: p })).toEqual({ text: null, canConfirm: false });
  });

  it("seatsUpdatedToast: a decrease names its date, an increase applies now", () => {
    const end = "2027-10-08T00:00:00Z";
    expect(seatsUpdatedToast(3, 19, end, fmt)).toBe("Seats drop to 3 on 2027-10-08.");
    expect(seatsUpdatedToast(3, 19, null, fmt)).toBe("Seats drop to 3 at the end of this billing period.");
    expect(seatsUpdatedToast(21, 19, end, fmt)).toBe("Seats updated to 21.");
    expect(seatsUpdatedToast(5, null, end, fmt)).toBe("Seats updated to 5.");
  });

  it("seatChangeSummary: a zero charge today still reads as money, never NaN", () => {
    expect(seatChangeSummary({ ...base, seats: 6, preview: { ...preview, proratedNow: 0, newAmount: 0 } })).toEqual({
      text: "You'll be charged about $0 today (prorated); then $0 per month.",
      canConfirm: true,
    });
  });

  it("seatChangeSummary: next amount missing falls back to a plain sentence", () => {
    const r = seatChangeSummary({ ...base, seats: 6, preview: { ...preview, newAmount: null } });
    expect(r).toEqual({ text: "Your next invoice will show the exact amount.", canConfirm: true });
  });

  it("seatChangeSummary: both amounts missing or absent never render NaN", () => {
    const nulls = { proratedNow: null, newAmount: null, currentPeriodEnd: null };
    expect(seatChangeSummary({ ...base, seats: 6, preview: nulls }).text).toBe(
      "Your next invoice will show the exact amount.",
    );
    // An older server that answers other field names.
    const odd = {} as unknown as typeof nulls;
    expect(seatChangeSummary({ ...base, seats: 6, preview: odd }).text).not.toMatch(/NaN/);
    expect(seatChangeSummary({ ...base, seats: 4, preview: nulls }).text).toBe(
      "Goes down to 4 seats at the end of this billing period.",
    );
  });

  it("seatChangeSummary: charge-now unknown still shows the next amount", () => {
    const r = seatChangeSummary({ ...base, seats: 6, preview: { ...preview, proratedNow: null } });
    expect(r.text).toBe("Then $60 per month. Your next invoice will show the exact amount.");
  });

  it("seatChangeSummary: increase says 'about' and the next amount", () => {
    expect(seatChangeSummary({ ...base, seats: 6, preview })).toEqual({
      text: "You'll be charged about $12.50 today (prorated); then $60 per month.",
      canConfirm: true,
    });
  });

  it("seatChangeSummary: decrease names the effective date", () => {
    expect(seatChangeSummary({ ...base, seats: 4, preview })).toEqual({
      text: "Goes down to 4 seats on 2026-11-01.",
      canConfirm: true,
    });
  });

  it("seatChangeSummary: below the floor is refused with the reason", () => {
    const r = seatChangeSummary({ ...base, seats: 3, preview });
    expect(r.canConfirm).toBe(false);
    expect(r.text).toBe(
      "You can't go below the people already on your account (4) or the 3-seat minimum.",
    );
  });

  it("seatChangeSummary: unchanged or still loading cannot confirm", () => {
    expect(seatChangeSummary({ ...base, seats: 5, preview })).toEqual({ text: null, canConfirm: false });
    expect(seatChangeSummary({ ...base, seats: 6, preview: null })).toEqual({ text: null, canConfirm: false });
  });

  it("formatBytes uses human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });

  it("usageAgainstLimit shows the ceiling only when one applies", () => {
    expect(usageAgainstLimit(2, 2, "person", "people")).toBe("2 of 2 people");
    expect(usageAgainstLimit(1, 1, "synced vault", "synced vaults")).toBe("1 of 1 synced vault");
    expect(usageAgainstLimit(7, null, "person", "people")).toBe("7 people");
  });

  it("planPriceLine prices Team per seat by interval", () => {
    const team = { currency: "usd", prices: [{ interval: "month" as const, perSeat: 1000 }, { interval: "year" as const, perSeat: 11000 }] };
    expect(planPriceLine("free", null, team)).toBe("Free");
    expect(planPriceLine("team", "month", team)).toBe("$10 per seat / month");
    expect(planPriceLine("team", "year", team)).toBe("$110 per seat / year");
  });

  it("seatUsageLines adds reserved and pending-decrease lines", () => {
    expect(
      seatUsageLines(
        { purchased: 5, used: 4, reserved: 1, pendingDecrease: { to: 4, effectiveAt: "2026-11-01T00:00:00Z" } },
        fmt,
      ),
    ).toEqual(["4 of 5 seats used", "1 invited", "Goes down to 4 on 2026-11-01"]);
    expect(seatUsageLines({ purchased: null, used: 2, reserved: 0, pendingDecrease: null }, fmt)).toEqual([
      "2 people",
    ]);
  });
});

describe("seatBreakdown", () => {
  it("counts claimed and reserved against purchased", () => {
    expect(seatBreakdown({ purchased: 10, used: 4, reserved: 2 })).toEqual({
      purchased: 10,
      claimed: 4,
      reserved: 2,
      available: 4,
    });
  });
  it("never reports negative availability", () => {
    expect(seatBreakdown({ purchased: 3, used: 3, reserved: 2 }).available).toBe(0);
    expect(seatBreakdown({ purchased: 3, used: 5, reserved: 0 }).available).toBe(0);
  });
  it("ignores a pending decrease until it takes effect", () => {
    const seats = { purchased: 8, used: 3, reserved: 1, pendingDecrease: { to: 4, effectiveAt: "2026-11-01" } };
    expect(seatBreakdown(seats)).toEqual({ purchased: 8, claimed: 3, reserved: 1, available: 4 });
  });
  it("treats no purchased seats (Free) as 0", () => {
    expect(seatBreakdown({ purchased: null, used: 1, reserved: 0 })).toEqual({
      purchased: 0,
      claimed: 1,
      reserved: 0,
      available: 0,
    });
  });
});

describe("membersSeatLine", () => {
  const team = { plan: "team" as const, seats: { purchased: 5, used: 3, reserved: 1 } };
  it("names the owner's account on Team", () => {
    expect(membersSeatLine(team, "Sara")).toBe("Uses 3 of 5 seats on Sara's account · 1 invited");
    expect(membersSeatLine(team, null)).toBe("Uses 3 of 5 seats on the owner's account · 1 invited");
    expect(membersSeatLine(team, "Sara", true)).toBe("Uses 3 of 5 seats on your account · 1 invited");
  });
  it("uses the Free wording without purchased seats", () => {
    expect(membersSeatLine({ plan: "free", seats: { purchased: null, used: 1, reserved: 0 } }, "Sara")).toBe(
      "Free includes 2 people on this account (1 of 2 used)",
    );
  });
});

describe("membersSeatLine on Team without seats", () => {
  const unlimited = { plan: "team" as const, seats: { purchased: null, used: 7, reserved: 0 } };
  it("reads unlimited people, never the Free copy", () => {
    expect(membersSeatLine(unlimited, "Sara", true)).toBe("Team · unlimited people on your account (7 people)");
    expect(membersSeatLine(unlimited, "Sara")).toBe("Team · unlimited people on Sara's account (7 people)");
    expect(membersSeatLine(unlimited, null)).toBe("Team · unlimited people on the owner's account (7 people)");
    expect(membersSeatLine({ ...unlimited, seats: { purchased: null, used: 1, reserved: 0 } }, null, true)).toBe(
      "Team · unlimited people on your account (1 person)",
    );
  });
});

describe("legacy plan", () => {
  const legacy = {
    plan: "team" as const,
    status: "active",
    interval: "month" as const,
    currentPeriodEnd: "2026-11-03T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    seats: { purchased: null },
    price: { charged: 1000 },
    complimentaryUntil: null,
  };
  const fmt = (iso: string) => iso.slice(0, 10);
  it("trusts the server flag either way", () => {
    expect(isLegacyPlan({ ...legacy, legacyPlan: true, seats: { purchased: 5 } })).toBe(true);
    expect(isLegacyPlan({ ...legacy, legacyPlan: false })).toBe(false);
  });
  it("infers it on an older server: live Team with no seats", () => {
    expect(isLegacyPlan(legacy)).toBe(true);
    expect(isLegacyPlan({ ...legacy, seats: { purchased: 3 } })).toBe(false);
    expect(isLegacyPlan({ ...legacy, plan: "free" })).toBe(false);
    expect(isLegacyPlan({ ...legacy, status: "none" })).toBe(false);
  });
  it("excludes a complimentary Team account", () => {
    expect(isLegacyPlan({ ...legacy, complimentaryUntil: "2027-01-01T00:00:00.000Z" })).toBe(false);
  });
  it("shows the real charged price, monthly and yearly, renewing or canceling", () => {
    expect(legacyPlanLine(legacy, "usd", fmt)).toBe(
      "Legacy plan · unlimited people at your original price · $10/mo · renews 2026-11-03",
    );
    expect(legacyPlanLine({ ...legacy, interval: "year", price: { charged: 9900 } }, "usd", fmt)).toBe(
      "Legacy plan · unlimited people at your original price · $99/yr · renews 2026-11-03",
    );
    expect(legacyPlanLine({ ...legacy, cancelAtPeriodEnd: true }, "usd", fmt)).toBe(
      "Legacy plan · unlimited people at your original price · $10/mo · cancels on 2026-11-03",
    );
    expect(legacyPlanLine({ ...legacy, price: null, currentPeriodEnd: null }, "usd", fmt)).toBe(
      "Legacy plan · unlimited people at your original price",
    );
  });
});

describe("team-model vault limit copy", () => {
  it("names the account's synced-vault allowance and the Team upgrade", async () => {
    const { teamVaultLimitCopy, vaultLimitReason, PEOPLE_LIMIT_REASON } = await import("./billing");
    expect(teamVaultLimitCopy(1)).toBe(
      "Free includes 1 synced vault on your account. Upgrade to Team for unlimited synced vaults.",
    );
    // A grandfathered account's server limit is above the default.
    expect(teamVaultLimitCopy(3)).toBe(
      "Free includes 3 synced vaults on your account. Upgrade to Team for unlimited synced vaults.",
    );
    expect(vaultLimitReason(1)).toBe("Free includes 1 synced vault. Team has no limit.");
    expect(PEOPLE_LIMIT_REASON).toBe("Free includes 2 people. Team has no limit.");
  });
});

describe("classifyBillingConfigResult", () => {
  it("reads a 404 from the billing routes as disabled", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(classifyBillingConfigResult(new ApiError(404, "Not found"))).toBe("disabled");
  });
  it("reads a 200 with enabled:false as disabled", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(classifyBillingConfigResult({ enabled: false })).toBe("disabled");
  });
  it("never reads a network failure as disabled", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(classifyBillingConfigResult(new TypeError("Failed to fetch"))).toBe("error");
  });
  it("never reads a 5xx or an auth failure as disabled", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(classifyBillingConfigResult(new ApiError(500, "HTTP 500"))).toBe("error");
    expect(classifyBillingConfigResult(new ApiError(502, "HTTP 502"))).toBe("error");
    expect(classifyBillingConfigResult(new ApiError(401, "HTTP 401"))).toBe("error");
  });
  it("treats an unparseable answer as an error", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(classifyBillingConfigResult(null)).toBe("error");
    expect(classifyBillingConfigResult("<html>")).toBe("error");
    expect(classifyBillingConfigResult({})).toBe("error");
  });
  it("routes a good config by its model", async () => {
    const { classifyBillingConfigResult } = await import("./billing");
    expect(
      classifyBillingConfigResult({
        enabled: true,
        model: "team",
        team: { currency: "usd" },
      }),
    ).toBe("team");
    expect(classifyBillingConfigResult({ enabled: true, model: "vault" })).toBe("vault");
    expect(classifyBillingConfigResult({ enabled: true })).toBe("vault");
  });
});

describe("legacy (per-vault) plan copy", () => {
  it("keeps the old Pro promise apart from Team's", async () => {
    const { LEGACY_PRO_BENEFITS, TEAM_BENEFITS } = await import("./billing");
    expect(LEGACY_PRO_BENEFITS).toEqual([
      "Unlimited team members",
      "Standalone file sync",
      "Baalda Assistant",
      "Doesn't count toward your free vaults",
    ]);
    expect(LEGACY_PRO_BENEFITS).not.toEqual(TEAM_BENEFITS);
  });
  it("defaults to 3 members per vault and 2 free vaults", async () => {
    const { LEGACY_FREE_PLAN_EXPLANATION } = await import("./billing");
    expect(LEGACY_FREE_PLAN_EXPLANATION).toBe(
      "Free includes 3 members per vault, 2 free vaults, note sync, embedded attachments and MCP. Pro adds unlimited members, standalone file sync and Baalda Assistant.",
    );
  });
  it("reads the numbers from the server's freeLimits", async () => {
    const { legacyFreePlanExplanation } = await import("./billing");
    const line = legacyFreePlanExplanation({ vaultsPerUser: 1, membersPerVault: 5 });
    expect(line).toMatch(/^Free includes 5 members per vault, 1 free vault, /);
    expect(line).not.toMatch(/Team/);
  });
});

describe("planStatusPill", () => {
  const fmt = (iso: string) => `D(${iso})`;
  const team = {
    plan: "team" as const,
    status: "active" as const,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2027-10-08",
    lapsed: false,
  };

  it("says Active for a healthy Team plan and nothing for Free", () => {
    expect(planStatusPill(team, fmt)).toEqual({ label: "Active", tone: "active" });
    expect(planStatusPill({ ...team, plan: "free", status: "none" }, fmt)).toBeNull();
  });

  it("says when a cancelling plan ends, in amber", () => {
    expect(planStatusPill({ ...team, cancelAtPeriodEnd: true }, fmt)).toEqual({
      label: "Cancels on D(2027-10-08)",
      tone: "past_due",
    });
  });

  it("says Past due in amber", () => {
    expect(planStatusPill({ ...team, status: "past_due" }, fmt)).toEqual({ label: "Past due", tone: "past_due" });
  });

  it("says Read-only for a lapsed account, Free included", () => {
    expect(planStatusPill({ ...team, lapsed: true }, fmt)).toEqual({ label: "Read-only", tone: "canceled" });
    expect(planStatusPill({ ...team, plan: "free", status: "none", lapsed: true }, fmt)?.label).toBe("Read-only");
  });
});

describe("vaultPlanLine", () => {
  const fmt = (iso: string) => `D(${iso})`;
  const account = {
    id: "acc_me",
    plan: "team" as const,
    status: "active" as const,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: "2027-10-08",
    lapsed: false,
  };

  it("names the plan like Plan & Billing on the owner's own account, Active pill included", () => {
    expect(
      vaultPlanLine({ account, vaultAccountId: "acc_me", fallbackPlan: "free", isOwner: true, fmtDate: fmt }),
    ).toEqual({ plan: "Team", status: { label: "Active", tone: "active" }, billedOn: null });
    expect(
      vaultPlanLine({ account: { ...account, plan: "free", status: "none" }, vaultAccountId: null, fallbackPlan: "team", isOwner: true, fmtDate: fmt }),
    ).toEqual({ plan: "Free", status: null, billedOn: null });
  });

  it("shows the status pill when there is something to say", () => {
    expect(
      vaultPlanLine({ account: { ...account, cancelAtPeriodEnd: true }, vaultAccountId: null, fallbackPlan: "free", isOwner: true, fmtDate: fmt }).status,
    ).toEqual({ label: "Cancels on D(2027-10-08)", tone: "past_due" });
    expect(
      vaultPlanLine({ account: { ...account, lapsed: true }, vaultAccountId: null, fallbackPlan: "team", isOwner: true, fmtDate: fmt }).status,
    ).toEqual({ label: "Read-only", tone: "canceled" });
  });

  it("names the owner's account for a member", () => {
    expect(
      vaultPlanLine({ account: null, vaultAccountId: "acc_o", fallbackPlan: "team", isOwner: false, ownerName: "Sara", fmtDate: fmt }),
    ).toEqual({ plan: "Team", status: { label: "Active", tone: "active" }, billedOn: "Billed on Sara's account" });
    expect(
      vaultPlanLine({ account: null, vaultAccountId: null, fallbackPlan: "free", isOwner: false, fmtDate: fmt }).billedOn,
    ).toBe("Billed on the owner's account");
  });

  it("uses the vault's resolved plan when an owner's vault is billed on another account", () => {
    expect(
      vaultPlanLine({ account, vaultAccountId: "acc_other", fallbackPlan: "free", isOwner: true, fmtDate: fmt }),
    ).toEqual({ plan: "Free", status: null, billedOn: "Billed on another account" });
  });
});

describe("billingErrorMessage", () => {
  it("maps a canceling subscription to the resume sentence or the server's message", () => {
    expect(billingErrorMessage(new ApiError(409, "subscription_canceling", { error: "subscription_canceling" }))).toBe(
      RESUME_TO_CHANGE_SEATS,
    );
    expect(
      billingErrorMessage(
        new ApiError(409, "x", { code: "subscription_canceling", message: "Your plan ends on 8 Oct. Resume it first." }),
      ),
    ).toBe("Your plan ends on 8 Oct. Resume it first.");
  });

  it("never shows a raw provider string", () => {
    const raw = "Polar subscriptions.update(seats): Forbidden (HTTP 403)";
    const out = billingErrorMessage(new ApiError(502, raw, { error: "provider_error", message: raw }));
    expect(out).not.toMatch(/Polar|HTTP/);
    expect(billingErrorMessage(new ApiError(403, raw, { error: raw }))).not.toMatch(/Polar|HTTP/);
    expect(billingErrorMessage(new ApiError(500, "HTTP 500"))).not.toMatch(/HTTP/);
  });

  it("keeps a plain server message and plain non-API errors", () => {
    expect(billingErrorMessage(new ApiError(400, "x", { message: "Seats must be at least 3." }))).toBe(
      "Seats must be at least 3.",
    );
    expect(billingErrorMessage(new Error("Network is offline"))).toBe("Network is offline");
  });
});

describe("seatChangeLocked", () => {
  it("locks seat changes only while the plan is set to cancel", () => {
    expect(seatChangeLocked({ cancelAtPeriodEnd: true })).toBe(true);
    expect(seatChangeLocked({ cancelAtPeriodEnd: false })).toBe(false);
  });

  it("maps the server's subscription_canceling refusal to its message", () => {
    expect(
      billingErrorMessage(
        new ApiError(409, "x", { error: "subscription_canceling", message: "Resume your plan before changing seats." }),
      ),
    ).toBe("Resume your plan before changing seats.");
    expect(
      billingErrorMessage(
        new ApiError(403, "Polar subscriptions.update(seats): subscription already canceled (HTTP 403)"),
      ),
    ).not.toMatch(/Polar|HTTP/);
  });
});

describe("invitePrewarning", () => {
  const team = (purchased: number, used: number, reserved: number) => ({ plan: "team" as const, seats: { purchased, used, reserved } });
  it("is silent while a seat is free", () => {
    expect(invitePrewarning(team(5, 3, 1), "Sara", true)).toBeNull();
  });
  it("warns the owner with Add seats when every seat is taken", () => {
    const w = invitePrewarning(team(19, 17, 2), "Sara", true);
    expect(w?.action).toBe("add-seats");
    expect(w?.text).toContain("All 19 seats are in use.");
    expect(w?.text).toContain("2 reserved");
  });
  it("tells an admin whom to ask, with no action", () => {
    expect(invitePrewarning(team(3, 3, 0), "Sara", false)).toEqual({ text: "All 3 seats are in use. Ask Sara to add seats.", action: null });
  });
  it("Free at 2 people: owner gets Upgrade, admin is told to ask", () => {
    const free = { plan: "free" as const, seats: { purchased: null, used: 1, reserved: 1 } };
    expect(invitePrewarning(free, "Sara", true)?.action).toBe("upgrade");
    expect(invitePrewarning(free, null, false)?.text).toBe("Free includes 2 people. Ask the vault owner to upgrade to Team.");
    expect(invitePrewarning({ ...free, seats: { purchased: null, used: 1, reserved: 0 } }, "Sara", true)).toBeNull();
  });
});

describe("grandfathered Free limit in the copy", () => {
  const free3 = { plan: "free" as const, seats: { purchased: null, used: 3, reserved: 0 }, limits: { people: 3 } };
  it("reads the account's own limit", () => {
    expect(membersSeatLine(free3, "Sara")).toBe("Free includes 3 people on this account (3 of 3 used)");
    expect(invitePrewarning(free3, "Sara", true)).toEqual({ text: "Free includes 3 people. Upgrade to Team to add more.", action: "upgrade" });
    expect(invitePrewarning({ ...free3, seats: { purchased: null, used: 2, reserved: 0 } }, "Sara", true)).toBeNull();
    expect(freePeopleCopy(3)).toBe("Free includes 3 people. Upgrade to Team to add more.");
  });
  it("keeps 2 when the account carries no limit", () => {
    expect(membersSeatLine({ plan: "free", seats: { purchased: null, used: 1, reserved: 0 } }, null)).toBe(
      "Free includes 2 people on this account (1 of 2 used)",
    );
  });
});

describe("seatsDialogSubtitle", () => {
  it("names seats and people with singular forms", () => {
    expect(seatsDialogSubtitle(19, 1)).toBe("19 seats · 1 person on your account");
    expect(seatsDialogSubtitle(1, 3)).toBe("1 seat · 3 people on your account");
  });
  it("reads as people only before a first purchase", () => {
    expect(seatsDialogSubtitle(null, 2)).toBe("2 people on your account");
  });
});

describe("invited-seat vaults", () => {
  it("drops empty or missing lists and zero counts", () => {
    expect(invitedVaults(undefined)).toEqual([]);
    expect(invitedVaults(null)).toEqual([]);
    expect(invitedVaults([{ orgId: "a", name: "A", count: 0 }, { orgId: "b", name: "B", count: 3 }])).toEqual([
      { orgId: "b", name: "B", count: 3 },
    ]);
  });

  it("orders by count, most first, then by name ignoring case", () => {
    const list = [
      { orgId: "1", name: "sales", count: 1 },
      { orgId: "2", name: "Design", count: 1 },
      { orgId: "3", name: "Ops", count: 4 },
      { orgId: "4", name: "Hello 4", count: 2 },
    ];
    expect(invitedVaults(list).map((v) => v.name)).toEqual(["Ops", "Hello 4", "Design", "sales"]);
    // The server's array is left alone.
    expect(list[0].name).toBe("sales");
  });

  it("labels the total and names the vaults for assistive tech", () => {
    expect(invitedTotalLabel(2)).toBe("2 invited");
    const one = [{ orgId: "a", name: "Hello 4", count: 2 }];
    expect(invitedCountAriaLabel(2, one)).toBe("2 invited in Hello 4");
    const two = [...one, { orgId: "b", name: "Sales", count: 1 }];
    expect(invitedCountAriaLabel(3, two)).toBe("3 invited across 2 vaults");
  });

  it("opens Members and access for the open vault, switches to a bound one, else the Vaults tab", () => {
    const base = { activeOrgId: "a", openPath: "/v/a" };
    expect(invitedVaultAction({ ...base, orgId: "a", boundPath: "/v/a" })).toBe("open-members");
    expect(invitedVaultAction({ ...base, orgId: "a", boundPath: null })).toBe("open-members");
    expect(invitedVaultAction({ ...base, orgId: "b", boundPath: "/v/b" })).toBe("switch-then-members");
    expect(invitedVaultAction({ ...base, orgId: "b", boundPath: null })).toBe("vaults-tab");
    // Active org but another folder on screen: switch to its own folder first.
    expect(invitedVaultAction({ ...base, orgId: "a", boundPath: "/v/other" })).toBe("switch-then-members");
    // Nothing open at all and no folder here.
    expect(invitedVaultAction({ orgId: "a", activeOrgId: "a", openPath: null, boundPath: null })).toBe("vaults-tab");
  });

  it("tells the user to open the vault when it is not on this device", () => {
    expect(invitedVaultFallbackToast("Design")).toBe("Open Design to manage its invitations.");
  });
});
