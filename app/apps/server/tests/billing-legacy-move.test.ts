import { describe, expect, it, vi } from "vitest";
import {
  executeAccount,
  isRefusal,
  planAccount,
  runAccount,
  seatPriceOf,
  toRawSubView,
  type AccountPlan,
  type ExecuteDeps,
  type LegacySub,
  type PlanInput,
  type RawSubView,
  type RunDeps,
} from "../scripts/billing/legacy-move-core.js";

const TEAM = { month: "team-month", year: "team-year" } as const;

function sub(over: Partial<LegacySub> & { id: string }): LegacySub {
  return {
    interval: "month",
    customerId: "cus",
    amount: 1000,
    currency: "usd",
    accountId: "acct",
    discountId: null,
    currentPeriodEnd: "2026-10-20T00:00:00Z",
    cancelAtPeriodEnd: false,
    ...over,
  };
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    accountId: "acct",
    subs: [sub({ id: "s1" })],
    people: 1,
    pending: 0,
    minSeats: 3,
    perSeatCents: { month: 1000, year: 11000 },
    teamProducts: { ...TEAM },
    mode: "fixed",
    sumMode: "sum",
    ...over,
  };
}

function plan(over: Partial<PlanInput>): AccountPlan {
  const p = planAccount(input(over));
  if (isRefusal(p)) throw new Error(p.refusal);
  return p;
}

/** A fake Polar: changeProduct/updateSeats/createDiscount mutate the raw view getRaw returns. */
function fakePolar(initial: RawSubView, opts: { discountOverride?: RawSubView["discount"] } = {}) {
  let raw: RawSubView = { ...initial };
  const created: Array<{ id: string; name: string; type: string; amount: number | null; basisPoints: number | null }> = [];
  const lines: string[] = [];
  const deps: ExecuteDeps = {
    createDiscount: vi.fn(async (a) => {
      const d = {
        id: `d${created.length + 1}`,
        name: a.name,
        type: a.type,
        amount: a.amountCents ?? null,
        basisPoints: a.basisPoints ?? null,
      };
      created.push(d);
      return { id: d.id };
    }),
    changeProduct: vi.fn(async (_id, productId, _p, discountId) => {
      raw = { ...raw, pendingProductId: productId };
      if (discountId) raw.discount = opts.discountOverride ?? created.find((d) => d.id === discountId)!;
    }),
    updateSeats: vi.fn(async (_id, seats) => {
      raw = { ...raw, pendingSeats: seats };
    }),
    getRaw: vi.fn(async () => ({ ...raw })),
    cancelSubscription: vi.fn(async () => undefined),
    log: (l) => lines.push(l),
  };
  return { deps, lines };
}

const legacyRaw = (): RawSubView => ({
  productId: "legacy-month-product",
  pendingProductId: null,
  seats: null,
  pendingSeats: null,
  cancelAtPeriodEnd: false,
  discount: null,
});

describe("planAccount", () => {
  it("(a) 3 seats x $10, target $10 => fixed $20 off, expected = target", () => {
    const p = plan({});
    expect(p.seats).toBe(3);
    expect(p.list).toBe(3000);
    expect(p.discount).toEqual({ type: "fixed", amount: 2000 });
    expect(p.expected).toBe(1000);
    expect(p.expected).toBe(p.target);
  });

  it("(b) 23 seats, target $20 (two $10 subs summed) => $210 off", () => {
    const p = plan({
      people: 23,
      subs: [
        sub({ id: "early", currentPeriodEnd: "2026-10-18T00:00:00Z" }),
        sub({ id: "late", currentPeriodEnd: "2026-10-23T00:00:00Z" }),
      ],
    });
    expect(p.seats).toBe(23);
    expect(p.target).toBe(2000);
    expect(p.discount).toEqual({ type: "fixed", amount: 21000 });
    expect(p.expected).toBe(2000);
  });

  it("(c) a $0 sub gets a discount equal to the full list", () => {
    const p = plan({ people: 10, subs: [sub({ id: "comp", interval: "year", amount: 0 })] });
    expect(p.list).toBe(110000);
    expect(p.discount).toEqual({ type: "fixed", amount: 110000 });
    expect(p.expected).toBe(0);
  });

  it("(d) refuses a mixed monthly+yearly account; --only plans that sub's group", () => {
    const subs = [
      sub({ id: "m1", interval: "month", amount: 1000 }),
      sub({ id: "y1", interval: "year", amount: 0 }),
    ];
    const r = planAccount(input({ subs, people: 7 }));
    expect(isRefusal(r) && r.refusal).toBe("SKIP account acct: monthly m1 and yearly y1; move one with --only");
    const p = plan({ subs, people: 7, only: "m1" });
    expect(p.interval).toBe("month");
    expect(p.keep.id).toBe("m1");
    expect(p.others).toEqual([]);
    expect(p.target).toBe(1000);
    expect(p.discount).toEqual({ type: "fixed", amount: 6000 });
  });

  it("--only keeps every group-mate of that interval in the sum", () => {
    const subs = [sub({ id: "a", currentPeriodEnd: "2026-10-18T00:00:00Z" }), sub({ id: "b" })];
    const p = plan({ subs, only: "a" });
    expect(p.target).toBe(2000);
    expect(p.others.map((o) => o.id)).toEqual(["a"]);
  });

  it("(e) seats = max(min, people + pending)", () => {
    expect(plan({ people: 20, pending: 3 }).seats).toBe(23);
    expect(plan({ people: 1, pending: 0 }).seats).toBe(3);
  });

  it("skips an account whose only sub already ends at period end", () => {
    const r = planAccount(input({ subs: [sub({ id: "x", cancelAtPeriodEnd: true })] }));
    expect(isRefusal(r)).toBe(true);
  });

  it("--percentage plans basis points; --larger takes the larger sub", () => {
    const p = plan({ mode: "percentage" });
    expect(p.discount).toEqual({ type: "percentage", bp: 6667 });
    const l = plan({ sumMode: "larger", subs: [sub({ id: "a", amount: 1000 }), sub({ id: "b", amount: 500 })] });
    expect(l.target).toBe(1000);
  });
});

describe("executeAccount", () => {
  it("(f) keep = latest period end; cancel only after verify OK", async () => {
    const p = plan({
      people: 23,
      subs: [
        sub({ id: "early", amount: 1000, currentPeriodEnd: "2026-10-18T00:00:00Z" }),
        sub({ id: "late", amount: 1000, currentPeriodEnd: "2026-10-23T00:00:00Z" }),
      ],
    });
    expect(p.keep.id).toBe("late");
    const { deps, lines } = fakePolar(legacyRaw());
    const status = await executeAccount(p, deps, { proration: "next_period" });
    expect(status).toBe("moved");
    expect(deps.changeProduct).toHaveBeenCalledWith("late", "team-month", "next_period", "d1");
    expect(deps.updateSeats).toHaveBeenCalledWith("late", 23, "next_period");
    expect(deps.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(deps.cancelSubscription).toHaveBeenCalledWith("early", "period_end");
    // verify precedes the cancel
    const verifyAt = lines.findIndex((l) => l.includes("verify OK"));
    const cancelAt = lines.findIndex((l) => l.includes("cancelled early"));
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(verifyAt);
    expect(lines[verifyAt]).toContain("target=2000 expected=2000");
  });

  it("(f) a verify mismatch cancels nothing", async () => {
    const p = plan({
      subs: [sub({ id: "early", currentPeriodEnd: "2026-10-18T00:00:00Z" }), sub({ id: "late" })],
    });
    const { deps } = fakePolar(legacyRaw());
    (deps.updateSeats as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined); // seats never land
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("refused");
    expect(deps.cancelSubscription).not.toHaveBeenCalled();
  });

  it("(g) a re-run with a scheduled keeper creates no discount and changes no product", async () => {
    const p = plan({
      subs: [
        sub({ id: "early", currentPeriodEnd: "2026-10-18T00:00:00Z", cancelAtPeriodEnd: true }),
        sub({ id: "late" }),
      ],
    });
    const { deps, lines } = fakePolar({
      ...legacyRaw(),
      pendingProductId: "team-month",
      pendingSeats: 3,
      discount: { id: "d0", name: "legacy-acct", type: "fixed", amount: 2000, basisPoints: null },
    });
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("scheduled");
    expect(deps.createDiscount).not.toHaveBeenCalled();
    expect(deps.changeProduct).not.toHaveBeenCalled();
    expect(deps.updateSeats).not.toHaveBeenCalled();
    expect(deps.cancelSubscription).not.toHaveBeenCalled(); // "early" already cancelling
    expect(lines.join("\n")).toContain("target not recomputed");
  });

  it("(g) a re-run only PATCHes seats when they differ", async () => {
    const p = plan({ people: 4 });
    const { deps } = fakePolar({
      ...legacyRaw(),
      productId: "team-month",
      seats: 3,
      discount: { id: "d0", name: "legacy-acct", type: "fixed", amount: 2000, basisPoints: null },
    });
    expect(await executeAccount(p, deps, { proration: "invoice" })).toBe("scheduled");
    expect(deps.updateSeats).toHaveBeenCalledWith("s1", 4, "invoice");
    expect(deps.changeProduct).not.toHaveBeenCalled();
  });

  it("(h) refuses when the re-read discount is a percentage", async () => {
    const p = plan({});
    const { deps, lines } = fakePolar(legacyRaw(), {
      discountOverride: { id: "d1", name: "legacy-acct", type: "percentage", amount: null, basisPoints: 6667 },
    });
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("refused");
    expect(lines.join("\n")).toContain("discount type percentage, planned fixed");
  });

  it("(h) refuses when the re-read fixed amount differs", async () => {
    const p = plan({ subs: [sub({ id: "k" }), sub({ id: "o", currentPeriodEnd: "2026-10-01T00:00:00Z" })] });
    const { deps, lines } = fakePolar(legacyRaw(), {
      discountOverride: { id: "d1", name: "legacy-acct", type: "fixed", amount: 1999, basisPoints: null },
    });
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("refused");
    expect(lines.join("\n")).toContain("discount amount 1999 != planned 1000");
    expect(deps.cancelSubscription).not.toHaveBeenCalled();
  });

  it("dry run reads but writes nothing", async () => {
    const { deps } = fakePolar(legacyRaw());
    expect(await executeAccount(plan({}), deps, { proration: "next_period", dryRun: true })).toBe("planned");
    expect(deps.createDiscount).not.toHaveBeenCalled();
    expect(deps.changeProduct).not.toHaveBeenCalled();
    expect(deps.updateSeats).not.toHaveBeenCalled();
    expect(deps.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe("price above Team list", () => {
  it("refuses a charge above list without --allow-lower", () => {
    const r = planAccount(input({ subs: [sub({ id: "big", amount: 5000 })] }));
    expect(isRefusal(r) && r.refusal).toBe(
      "SKIP account acct: today's charge $50.00 exceeds Team list $30.00 for 3 seats; pass --allow-lower to move it with no discount",
    );
    expect(isRefusal(r) && r.kind).toBe("refused");
  });

  it("--allow-lower moves with no discount and verifies the list charge", async () => {
    const p = plan({ subs: [sub({ id: "big", amount: 5000 })], allowLower: true });
    expect(p.lower).toBe(true);
    expect(p.discount).toBeNull();
    expect(p.expected).toBe(3000);
    const { deps } = fakePolar(legacyRaw());
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("moved");
    expect(deps.createDiscount).not.toHaveBeenCalled();
    expect(deps.changeProduct).toHaveBeenCalledWith("big", "team-month", "next_period", undefined);
  });
});

describe("pending Team product with no visible legacy discount", () => {
  it("changes nothing, creates no discount, cancels nothing and counts as scheduled", async () => {
    const p = plan({ subs: [sub({ id: "k" }), sub({ id: "o", currentPeriodEnd: "2026-10-01T00:00:00Z" })] });
    const { deps, lines } = fakePolar({
      ...legacyRaw(),
      pendingProductId: "team-month",
      pendingSeats: 3,
      discount: { id: "old", name: "Launch 50", type: "percentage", amount: null, basisPoints: 5000 },
    });
    expect(await executeAccount(p, deps, { proration: "next_period" })).toBe("scheduled");
    expect(deps.createDiscount).not.toHaveBeenCalled();
    expect(deps.changeProduct).not.toHaveBeenCalled();
    expect(deps.updateSeats).not.toHaveBeenCalled();
    expect(deps.cancelSubscription).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("product change pending; discount not visible yet, re-run after renewal to verify");
  });
});

describe("runAccount: an account that already holds a Team subscription", () => {
  function runDeps(over: Partial<RunDeps>) {
    const { deps, lines } = fakePolar(legacyRaw());
    const all: RunDeps = {
      ...deps,
      listCustomerSubs: vi.fn(async () => []),
      dbTeamRows: vi.fn(async () => []),
      ...over,
    };
    return { deps: all, lines };
  }
  const leftover = () => [sub({ id: "leftover", currentPeriodEnd: "2026-10-18T00:00:00Z" })];

  it("refuses when Polar lists an active Team sub for the customer, and calls nothing", async () => {
    const { deps, lines } = runDeps({
      listCustomerSubs: vi.fn(async () => [
        { id: "leftover", productId: "legacy-month-product", pendingProductId: null },
        { id: "moved", productId: "team-month", pendingProductId: null },
      ]),
    });
    expect(await runAccount(input({ subs: leftover() }), deps, { proration: "invoice" })).toBe("refused");
    expect(deps.listCustomerSubs).toHaveBeenCalledWith(["cus"], "acct");
    expect(lines.join("\n")).toContain("REFUSED account acct: already holds Team subscription moved; finish by hand");
    expect(deps.getRaw).not.toHaveBeenCalled();
    expect(deps.createDiscount).not.toHaveBeenCalled();
    expect(deps.changeProduct).not.toHaveBeenCalled();
    expect(deps.updateSeats).not.toHaveBeenCalled();
    expect(deps.cancelSubscription).not.toHaveBeenCalled();
  });

  it("refuses when our DB has a Team row for the account", async () => {
    const { deps } = runDeps({ dbTeamRows: vi.fn(async () => ["moved"]) });
    expect(await runAccount(input({ subs: leftover() }), deps, { proration: "invoice" })).toBe("refused");
    expect(deps.getRaw).not.toHaveBeenCalled();
    expect(deps.changeProduct).not.toHaveBeenCalled();
  });

  it("a legacy sub whose own pending product is Team is left to the scheduled guard", async () => {
    const { deps } = runDeps({
      listCustomerSubs: vi.fn(async () => [{ id: "s1", productId: "legacy-month-product", pendingProductId: "team-month" }]),
      dbTeamRows: vi.fn(async () => ["s1"]),
    });
    expect(await runAccount(input({}), deps, { proration: "next_period", dryRun: true })).toBe("planned");
  });

  it("a leaving account is skipped-leaving, not refused", async () => {
    const { deps } = runDeps({});
    const subs = [sub({ id: "x", cancelAtPeriodEnd: true })];
    expect(await runAccount(input({ subs }), deps, { proration: "next_period" })).toBe("skipped-leaving");
  });
});

describe("Polar mapping helpers", () => {
  it("reads the pending update and discount from a raw subscription", () => {
    const v = toRawSubView({
      productId: "legacy",
      seats: null,
      cancelAtPeriodEnd: false,
      pendingUpdate: { productId: "team-month", seats: 3 },
      discount: { id: "d", name: "legacy-a", type: "fixed", amount: 2000 },
    });
    expect(v).toEqual({
      productId: "legacy",
      pendingProductId: "team-month",
      seats: null,
      pendingSeats: 3,
      cancelAtPeriodEnd: false,
      discount: { id: "d", name: "legacy-a", type: "fixed", amount: 2000, basisPoints: null },
    });
  });

  it("reads the per-seat price and refuses differing tiers", () => {
    const price = (tiers: number[]) => ({
      prices: [{ amountType: "seat_based", seatTiers: { tiers: tiers.map((pricePerSeat) => ({ minSeats: 1, pricePerSeat })) } }],
    });
    expect(seatPriceOf(price([1000]))).toEqual({ cents: 1000 });
    expect("error" in seatPriceOf(price([1000, 900]))).toBe(true);
    expect("error" in seatPriceOf({ prices: [] })).toBe(true);
  });
});
