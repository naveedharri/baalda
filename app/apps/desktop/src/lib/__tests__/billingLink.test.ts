import { describe, expect, it } from "vitest";
import { parseBillingLink } from "../billingLink";

describe("parseBillingLink", () => {
  it("accepts both foldings, with and without a vault", () => {
    expect(parseBillingLink("baalda://billing/upgraded")).toEqual({ orgId: null });
    expect(parseBillingLink("baalda:///billing/upgraded/")).toEqual({ orgId: null });
    expect(parseBillingLink("baalda://billing/upgraded?org=WmpuI6BO")).toEqual({
      orgId: "WmpuI6BO",
    });
    expect(parseBillingLink("baalda:///billing/upgraded?org=abc%2Fdef")).toEqual({
      orgId: "abc/def",
    });
  });

  it("accepts the Staging app's scheme too", () => {
    expect(parseBillingLink("baalda-staging://billing/upgraded?org=x")).toEqual({ orgId: "x" });
  });

  it("treats an empty org as absent", () => {
    expect(parseBillingLink("baalda://billing/upgraded?org=")).toEqual({ orgId: null });
    expect(parseBillingLink("baalda://billing/upgraded?org=%20")).toEqual({ orgId: null });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "baalda://billing",
      "baalda://billing/canceled",
      "baalda://billing/upgraded/extra",
      "baalda://upgraded",
      "baalda://verified",
      "https://example.com/billing/upgraded",
      "not a url",
      "baalda://",
    ]) {
      expect(parseBillingLink(bad)).toBeNull();
    }
  });
});
