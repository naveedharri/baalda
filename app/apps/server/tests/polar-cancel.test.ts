import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// #300: Polar answers 403 `AlreadyCanceledSubscription` when a subscription is
// already set to cancel at period end. That must read as a successful cancel,
// not refuse the vault teardown on every retry. No database: fetch is stubbed.

type Provider = import("../src/billing/polar.js").PolarBillingProvider;
let provider: Provider;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
  vi.resetModules();
  const mod = await import("../src/billing/polar.js");
  provider = new mod.PolarBillingProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUB = {
  id: "sub_1",
  customer_id: "cus_1",
  status: "active",
  cancel_at_period_end: true,
  current_period_end: "2026-11-01T00:00:00Z",
  recurring_interval: "month",
  amount: 1000,
  currency: "usd",
  modified_at: "2026-10-01T00:00:00Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PolarBillingProvider.cancelSubscription", () => {
  it("treats 403 AlreadyCanceledSubscription as success and returns the current state", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        calls.push(req.method);
        return json(403, {
          error: "AlreadyCanceledSubscription",
          detail: "This subscription is already canceled or will be at the end of the period.",
        });
      }),
    );
    const getSpy = vi.spyOn(provider, "getSubscription").mockResolvedValue({
      providerSubscriptionId: SUB.id,
      providerCustomerId: SUB.customer_id,
      status: "active",
      currentPeriodEnd: new Date(SUB.current_period_end),
      cancelAtPeriodEnd: true,
      interval: "month",
      amount: 1000,
      currency: "usd",
      modifiedAt: new Date(SUB.modified_at),
    });
    const snap = await provider.cancelSubscription("sub_1", "period_end");
    expect(calls).toEqual(["PATCH"]);
    expect(getSpy).toHaveBeenCalledWith("sub_1");
    getSpy.mockRestore();
    expect(snap.providerSubscriptionId).toBe("sub_1");
    expect(snap.cancelAtPeriodEnd).toBe(true);
  });

  it("names Polar's error code when a refusal is anything else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: "SomethingElse", detail: "nope" })),
    );
    await expect(provider.cancelSubscription("sub_1", "period_end")).rejects.toThrow(
      /SomethingElse|HTTP 403/,
    );
  });
});
