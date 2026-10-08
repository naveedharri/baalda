import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// 2026-10-08: a Team (seat-based) subscription makes its Polar customer a TEAM
// customer, and `customerSessions.create` answers 422 "member_id is required
// for team customers". The portal retries as the customer's owner member.
// No database: fetch is stubbed.

type Mod = typeof import("../src/billing/polar.js");
let mod: Mod;

beforeAll(async () => {
  process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token";
  vi.resetModules();
  mod = await import("../src/billing/polar.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MEMBER_REQUIRED = {
  error: "PolarRequestValidationError",
  detail: [
    {
      type: "value_error",
      loc: ["body", "member_id"],
      msg: "member_id is required for team customers.",
      input: null,
    },
  ],
};

const SESSION = {
  id: "cs_1",
  token: "polar_cst_x",
  expires_at: "2026-10-08T12:00:00Z",
  return_url: null,
  customer_portal_url: "https://polar.test/portal/team",
  customer_id: "5e1847b0-2c73-44d1-9a0a-4b5d753fbccb",
  customer: {
    id: "5e1847b0-2c73-44d1-9a0a-4b5d753fbccb",
    created_at: "2026-10-08T10:00:00Z",
    modified_at: null,
    metadata: {},
    email_verified: true,
    type: "team",
    name: null,
    billing_address: null,
    tax_id: null,
    organization_id: "org_1",
    deleted_at: null,
    avatar_url: "https://polar.test/avatar.png",
  },
  created_at: "2026-10-08T11:00:00Z",
  modified_at: null,
};

describe("PolarBillingProvider.getPortalUrl", () => {
  it("retries a team customer's session as its owner member", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/v1/members/") {
          expect(url.searchParams.get("customer_id")).toBe(SESSION.customer_id);
          return json(200, {
            items: [
              { id: "mem_billing", role: "billing_manager" },
              { id: "mem_owner", role: "owner" },
            ],
          });
        }
        const body = JSON.parse(await req.text()) as Record<string, unknown>;
        bodies.push(body);
        return body.member_id ? json(201, SESSION) : json(422, MEMBER_REQUIRED);
      }),
    );
    const provider = new mod.PolarBillingProvider();
    const { url } = await provider.getPortalUrl({ customerId: SESSION.customer_id });
    expect(url).toBe("https://polar.test/portal/team");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ customer_id: SESSION.customer_id });
    expect(bodies[1]).toMatchObject({ customer_id: SESSION.customer_id, member_id: "mem_owner" });
  });

  it("opens an individual customer's portal in one call", async () => {
    const fetchSpy = vi.fn(async () => json(201, SESSION));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new mod.PolarBillingProvider();
    const { url } = await provider.getPortalUrl({ customerId: SESSION.customer_id });
    expect(url).toBe("https://polar.test/portal/team");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never sends an empty customer id to Polar", async () => {
    const fetchSpy = vi.fn(async () => json(201, SESSION));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new mod.PolarBillingProvider();
    await expect(provider.getPortalUrl({ customerId: "  " })).rejects.toThrow(/No billing customer/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Polar response helpers", () => {
  it("recognises the member_id 422 and nothing else", () => {
    expect(mod.isMemberRequiredRejection({ statusCode: 422, body: JSON.stringify(MEMBER_REQUIRED) })).toBe(true);
    expect(mod.isMemberRequiredRejection({ statusCode: 422, detail: MEMBER_REQUIRED.detail })).toBe(true);
    expect(mod.isMemberRequiredRejection({ statusCode: 400, detail: MEMBER_REQUIRED.detail })).toBe(false);
    expect(
      mod.isCustomerEmailRejection({ statusCode: 422, detail: MEMBER_REQUIRED.detail }),
    ).toBe(false);
  });

  it("reads a missing or empty customer id as null", () => {
    expect(mod.nonEmpty("")).toBeNull();
    expect(mod.nonEmpty(undefined)).toBeNull();
    expect(mod.nonEmpty(null)).toBeNull();
    expect(mod.nonEmpty("cus_1")).toBe("cus_1");
  });
});
