import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A fully discounted Team checkout reads `succeeded` with `subscription_id:
// null` for good, while the subscription it created records `checkout_id`.
// The provider must recover the id, or the reconcile poll never writes the
// subscription and the app waits for payment forever. No database: fetch is
// stubbed.

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
  vi.restoreAllMocks();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PolarBillingProvider.subscriptionIdForCheckout", () => {
  it("finds the customer's subscription created by that checkout", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return json(200, {
          items: [
            { id: "sub_old", status: "active", checkout_id: "co_earlier" },
            { id: "sub_new", status: "active", checkout_id: "co_paid" },
          ],
        });
      }),
    );
    await expect(provider.subscriptionIdForCheckout("cus_1", "co_paid")).resolves.toBe("sub_new");
    expect(urls[0]).toContain("/v1/subscriptions/?customer_id=cus_1");
  });

  it("answers null when no subscription came from that checkout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { items: [{ id: "sub_old", checkout_id: "co_other" }] })),
    );
    await expect(provider.subscriptionIdForCheckout("cus_1", "co_paid")).resolves.toBeNull();
  });

  it("throws on a Polar error so the caller can log it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { detail: "boom" })));
    await expect(provider.subscriptionIdForCheckout("cus_1", "co_paid")).rejects.toThrow(/HTTP 500/);
  });
});

describe("PolarBillingProvider.checkoutSnapshot", () => {
  it("fills in the subscription id of a succeeded checkout that lacks one", async () => {
    const lookup = vi.spyOn(provider, "subscriptionIdForCheckout").mockResolvedValue("sub_new");
    const snap = await provider.checkoutSnapshot("co_paid", {
      id: "co_paid",
      status: "succeeded",
      subscription_id: null,
      customer_id: "cus_1",
      metadata: { billing_account_id: "ba_1", user_id: "u_1" },
    });
    expect(lookup).toHaveBeenCalledWith("cus_1", "co_paid");
    expect(snap?.providerSubscriptionId).toBe("sub_new");
    expect(snap?.accountId).toBe("ba_1");
  });
});

describe("PolarBillingProvider.checkoutSnapshot without a lookup", () => {
  it("keeps Polar's own subscription id and skips the lookup for an open checkout", async () => {
    const lookup = vi.spyOn(provider, "subscriptionIdForCheckout");
    const linked = await provider.checkoutSnapshot("co_a", {
      status: "succeeded",
      subscription_id: "sub_direct",
      customer_id: "cus_1",
    });
    const open = await provider.checkoutSnapshot("co_b", {
      status: "open",
      subscription_id: null,
      customer_id: "cus_1",
    });
    expect(linked.providerSubscriptionId).toBe("sub_direct");
    expect(open.providerSubscriptionId).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});
