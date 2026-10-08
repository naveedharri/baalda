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

  it("carries a fixed discount over as the same amount", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(
      snap({ amount: 30000, discountId: "d_2", discountName: "legacy-acc_1" }),
    );
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBe(85000);
    expect(Number.isFinite(p.proratedNow)).toBe(true);
  });

  it("answers null, never NaN, when the interval is unknown", async () => {
    vi.spyOn(provider, "getSubscription").mockResolvedValue(snap({ interval: null }));
    const p = await provider.previewSeatChange("sub_1", 8);
    expect(p.newAmount).toBeNull();
    expect(p.proratedNow).toBeNull();
  });
});
