import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Polar answers 422 on `customer_email` for special-use domains (a dev account
// like test@context.local). The field is optional, so the checkout omits it.
// No database: fetch is stubbed.

type Mod = typeof import("./polar.js");
let mod: Mod;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
  process.env.POLAR_PRODUCT_TEAM_MONTHLY_ID = "prod_team_monthly_test";
  vi.resetModules();
  mod = await import("./polar.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkoutEmailFor", () => {
  it("keeps a valid address, trimmed", () => {
    expect(mod.checkoutEmailFor("  sara@example.com.au ")).toBe("sara@example.com.au");
    expect(mod.checkoutEmailFor("a.b+c@mail.baalda.com")).toBe("a.b+c@mail.baalda.com");
  });

  it("drops reserved and special-use domains", () => {
    expect(mod.checkoutEmailFor("test@context.local")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@foo.test")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@foo.TEST")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@foo.example")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@box.internal")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@localhost")).toBeUndefined();
    expect(mod.checkoutEmailFor("dev@my.localhost")).toBeUndefined();
  });

  it("drops a domain without a dot, missing or malformed addresses", () => {
    expect(mod.checkoutEmailFor("dev@intranet")).toBeUndefined();
    expect(mod.checkoutEmailFor("")).toBeUndefined();
    expect(mod.checkoutEmailFor("   ")).toBeUndefined();
    expect(mod.checkoutEmailFor(null)).toBeUndefined();
    expect(mod.checkoutEmailFor(undefined)).toBeUndefined();
    expect(mod.checkoutEmailFor("no-at-sign.com")).toBeUndefined();
    expect(mod.checkoutEmailFor("@example.org")).toBeUndefined();
    expect(mod.checkoutEmailFor("user@")).toBeUndefined();
  });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHECKOUT_ARGS = {
  accountId: "acct_1",
  userId: "user_1",
  email: "sara@baalda.com",
  seats: 1,
  minSeats: 1,
  interval: "month" as const,
  successUrl: "https://baalda.com/ok",
};

const EMAIL_422 = {
  detail: [
    {
      type: "value_error",
      loc: ["body", "customer_email"],
      msg: "value is not a valid email address",
      input: "sara@baalda.com",
    },
  ],
};

async function captureBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

describe("PolarBillingProvider.createCheckout customer email", () => {
  it("omits a reserved-domain email from the request", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await captureBody(input, init));
        return json(422, { detail: [] });
      }),
    );
    await expect(
      new mod.PolarBillingProvider().createCheckout({ ...CHECKOUT_ARGS, email: "test@context.local" }),
    ).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("customer_email");
    expect(bodies[0].products).toEqual(["prod_team_monthly_test"]);
  });

  it("retries once without customer_email when Polar refuses it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(await captureBody(input, init));
      return bodies.length === 1 ? json(422, EMAIL_422) : json(422, { detail: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new mod.PolarBillingProvider().createCheckout(CHECKOUT_ARGS)).rejects.toThrow();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].customer_email).toBe("sara@baalda.com");
    expect(bodies[1]).not.toHaveProperty("customer_email");
  });

  it("does not retry a 422 about another field", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json(422, { detail: [{ type: "missing", loc: ["body", "products"], msg: "x" }] });
      }),
    );
    await expect(new mod.PolarBillingProvider().createCheckout(CHECKOUT_ARGS)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
