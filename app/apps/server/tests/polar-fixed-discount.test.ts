import { beforeAll, describe, expect, it, vi } from "vitest";

// A FIXED discount (an amount off, Polar `type: "fixed"`) through the
// snapshot mapping: `listAmount` must come out as the undiscounted price on
// both the Team-product branch (per-seat x seats) and the legacy-product
// branch (charged + amount off), with no basis points. No database and no
// network: the Polar SDK client is replaced.

let nextSubscription: unknown = null;
vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    subscriptions = { get: async () => nextSubscription };
  },
}));

type Provider = import("../src/billing/polar.js").PolarBillingProvider;
let provider: Provider;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
  process.env.POLAR_PRODUCT_TEAM_MONTHLY_ID = "prod_team_month_fixed";
  process.env.POLAR_PRODUCT_TEAM_YEARLY_ID = "prod_team_year_fixed";
  process.env.TEAM_PRICE_MONTHLY_CENTS = "1000";
  process.env.TEAM_PRICE_YEARLY_CENTS = "11000";
  vi.resetModules();
  const mod = await import("../src/billing/polar.js");
  provider = new mod.PolarBillingProvider();
});

const periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString();

describe("toSnapshot with a fixed discount", () => {
  it("Team product: list = per-seat x seats, the fixed amount off is the difference", async () => {
    // Snake_case, as the webhook JSON carries it.
    nextSubscription = {
      id: "sub_fixed_team",
      customer_id: "cus_1",
      status: "active",
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      recurring_interval: "month",
      amount: 3000,
      currency: "usd",
      seats: 5,
      product_id: "prod_team_month_fixed",
      discount: { id: "disc_fixed", name: "Legacy price", type: "fixed", amount: 2000, duration: "forever" },
    };
    const snap = await provider.getSubscription("sub_fixed_team");
    expect(snap).toMatchObject({
      amount: 3000,
      listAmount: 5000,
      seats: 5,
      discountId: "disc_fixed",
      discountName: "Legacy price",
      discountBasisPoints: null,
      discountDuration: "forever",
    });
  });

  it("legacy product: list = charged + the fixed amount off", async () => {
    // camelCase, as the SDK's read model carries it.
    nextSubscription = {
      id: "sub_fixed_legacy",
      customerId: "cus_2",
      status: "active",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      recurringInterval: "year",
      amount: 9700,
      currency: "usd",
      seats: null,
      productId: "prod_yearly_test",
      discount: { id: "disc_legacy", name: "Founders", type: "fixed", amount: 300, duration: "forever" },
    };
    const snap = await provider.getSubscription("sub_fixed_legacy");
    expect(snap).toMatchObject({
      amount: 9700,
      listAmount: 10000,
      discountId: "disc_legacy",
      discountName: "Founders",
      discountBasisPoints: null,
    });
  });

  it("a $0-charged fixed discount keeps the full list", async () => {
    nextSubscription = {
      id: "sub_fixed_zero",
      status: "active",
      current_period_end: periodEnd,
      recurring_interval: "year",
      amount: 0,
      currency: "usd",
      seats: 3,
      product_id: "prod_team_year_fixed",
      discount: { id: "disc_comp", name: "Comped", type: "fixed", amount: 33000, duration: "forever" },
    };
    const snap = await provider.getSubscription("sub_fixed_zero");
    expect(snap).toMatchObject({ amount: 0, listAmount: 33000, discountBasisPoints: null });
  });
});
