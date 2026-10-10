import { beforeAll, describe, expect, it, vi } from "vitest";

// The seat preview is derived from the subscription snapshot (Polar has no
// quote endpoint). It must answer real numbers, keep a percentage discount
// proportional (100% off stays $0) and carry a fixed one over unchanged.
// No database: getSubscription is stubbed.

type Provider = import("../src/billing/polar.js").PolarBillingProvider;
type Snapshot = import("../src/billing/provider.js").SubscriptionSnapshot;
let provider: Provider;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
  vi.resetModules();
  const mod = await import("../src/billing/polar.js");
  provider = new mod.PolarBillingProvider();
});

const year = new Date(Date.now() + 365 * 86400_000);
function snap(over: Partial<Snapshot>): Snapshot {
  return {
    providerSubscriptionId: "sub_1",
    providerCustomerId: "cus_1",
    status: "active",
    currentPeriodEnd: year,
    cancelAtPeriodEnd: false,
    interval: "year",
    amount: 33000,
    currency: "usd",
    modifiedAt: new Date(),
    seats: 3,
    listAmount: 33000,
    discountId: null,
    discountName: null,
    pendingSeats: null,
    accountId: "acc_1",
    productId: "prod_team_year",
    ...over,
  } as Snapshot;
}

describe("PolarBillingProvider.previewSeatChange", () => {
  it("prices 3 to 8 yearly seats at list with no discount", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(snap({}));
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBe(88000);
    expect(p.proratedNow).toBeGreaterThan(54000);
    expect(p.proratedNow).toBeLessThanOrEqual(55000);
  });

  it("keeps a 100% percentage discount at $0 now and next period", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 0, discountId: "d_1", discountName: "TEST100", discountBasisPoints: 10000 }),
    );
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBe(0);
    expect(p.proratedNow).toBe(0);
  });

  it("uses the stored percentage when the live read omits it for the same discount", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 0, discountId: "d_1", discountName: "TEST100" }),
    );
    const free = await provider.previewSeatChange("sub_1", 8, {
      discountId: "d_1",
      discountBasisPoints: 10000,
    });
    expect(free.newAmount).toBe(0);
    expect(free.proratedNow).toBe(0);

    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 26400, discountId: "d_20", discountName: "TWENTY" }),
    );
    const twenty = await provider.previewSeatChange("sub_1", 8, {
      discountId: "d_20",
      discountBasisPoints: 2000,
    });
    expect(twenty.newAmount).toBe(8 * 11000 * 0.8);

    // A stored percentage for a DIFFERENT discount is ignored (fixed math).
    const other = await provider.previewSeatChange("sub_1", 8, {
      discountId: "d_old",
      discountBasisPoints: 10000,
    });
    expect(other.newAmount).toBe(88000 - (33000 - 26400));
  });

  it("carries a fixed discount over as the same amount", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 30000, discountId: "d_2", discountName: "legacy-acc_1" }),
    );
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBe(85000);
    expect(Number.isFinite(p.proratedNow)).toBe(true);
  });

  it("charges added seats at full price now under a fixed discount, $0-charged included", async () => {
    // $330/yr list, $30 off ⇒ charged $300. Adding 2 seats prorates 2 x $110.
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 30000, discountId: "d_fixed", discountName: "Legacy price" }),
    );
    const p = await provider.previewSeatChange("sub_1", 5);
    expect(p.newAmount).toBe(55000 - 3000);
    expect(p.proratedNow).toBeGreaterThan(21900);
    expect(p.proratedNow).toBeLessThanOrEqual(22000);

    // Fully comped by a fixed amount: next period = added seats only, and the
    // proration is still at full price (the fixed amount does not grow).
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 0, discountId: "d_comp", discountName: "Comped" }),
    );
    const zero = await provider.previewSeatChange("sub_1", 5);
    expect(zero.newAmount).toBe(22000);
    expect(zero.proratedNow).toBeGreaterThan(21900);
    expect(zero.proratedNow).toBeLessThanOrEqual(22000);
  });

  it("prices the next period at list for a once discount, discounted for a forever one", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({
        amount: 0,
        discountId: "d_once",
        discountName: "Team Ben",
        discountBasisPoints: 10000,
        discountDuration: "once",
      }),
    );
    const once = await provider.previewSeatChange("sub_1", 8);
    expect(once.newAmount).toBe(88000);
    // The one discounted payment is spent: the proration is at list too.
    expect(once.proratedNow).toBeGreaterThan(54000);

    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({
        amount: 0,
        discountId: "d_forever",
        discountName: "Legacy price",
        discountBasisPoints: 10000,
        discountDuration: "forever",
      }),
    );
    const forever = await provider.previewSeatChange("sub_1", 8);
    expect(forever.newAmount).toBe(0);
    expect(forever.proratedNow).toBe(0);
  });

  it("uses the stored duration for the same discount and ends a repeating one on time", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 0, discountId: "d_once", discountName: "Team Ben", discountBasisPoints: 10000 }),
    );
    const once = await provider.previewSeatChange("sub_1", 8, {
      discountId: "d_once",
      discountBasisPoints: 10000,
      discountDuration: "once",
    });
    expect(once.newAmount).toBe(88000);

    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({
        amount: 0,
        discountId: "d_rep",
        discountName: "Three months",
        discountBasisPoints: 10000,
        discountDuration: "repeating",
        discountDurationMonths: 3,
      }),
    );
    // Started a month ago, three months: ends before the yearly renewal.
    const ended = await provider.previewSeatChange("sub_1", 8, {
      discountId: "d_rep",
      discountBasisPoints: 10000,
      startedAt: new Date(Date.now() - 30 * 86400_000),
    });
    expect(ended.newAmount).toBe(88000);
    expect(ended.proratedNow).toBe(0);
  });

  it("answers null, never NaN, when the interval is unknown", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(snap({ interval: null }));
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBeNull();
    expect(p.proratedNow).toBeNull();
  });
});
