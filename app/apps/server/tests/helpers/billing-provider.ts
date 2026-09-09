import type {
  BillingProvider,
  CheckoutSnapshot,
  NormalizedBillingEvent,
  SubscriptionSnapshot,
} from "../../src/billing/provider.js";

/**
 * A controllable, network-free `BillingProvider` for the billing suites.
 *
 * Shared between `billing.test.ts` and `billing-lifecycle.test.ts` so the two
 * cannot drift: every provider mutation now returns an authoritative snapshot
 * that the routes write straight into our row, so a fake that modelled cancel
 * as "record the id" would let a route pass while persisting nothing.
 *
 * Every call is recorded, and each one can be made to throw on demand — the
 * "provider refuses, so nothing is deleted" and "resume fails, so nothing
 * moves" paths are the whole point of #109/#110 and need a failing provider.
 */

export interface CancelCall {
  id: string;
  mode: "period_end" | "now";
}

export interface MetadataCall {
  id: string;
  orgId: string;
  userId: string;
}

export interface FakeProvider extends BillingProvider {
  /** Scripted result for the next `verifyAndNormalizeWebhook`. */
  nextEvent: NormalizedBillingEvent | null;
  lastCheckout: unknown;
  canceled: CancelCall[];
  resumed: string[];
  fetched: string[];
  metadataWrites: MetadataCall[];
  /** Base state cancel/resume/get return (per-call fields are overlaid). */
  snapshot: SubscriptionSnapshot;
  /** Per-subscription overrides for `getSubscription` (null ⇒ 404 at Polar). */
  getResults: Map<string, SubscriptionSnapshot | null>;
  /** Scripted checkouts for `getCheckout`, by id (absent ⇒ 404 at Polar). */
  checkouts: Map<string, CheckoutSnapshot>;
  /** Every checkout id the success page asked about. */
  checkoutsFetched: string[];
  failCancel: Error | null;
  failResume: Error | null;
  failGet: Error | null;
  failMetadata: Error | null;
  reset(): void;
}

export function makeSnapshot(over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    providerSubscriptionId: "sub_test",
    providerCustomerId: "cus_test",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
    cancelAtPeriodEnd: false,
    interval: "month",
    amount: 1000,
    currency: "usd",
    modifiedAt: new Date(),
    ...over,
  };
}

export function makeFakeProvider(): FakeProvider {
  return {
    nextEvent: null,
    lastCheckout: null,
    canceled: [],
    resumed: [],
    fetched: [],
    metadataWrites: [],
    snapshot: makeSnapshot(),
    getResults: new Map(),
    checkouts: new Map(),
    checkoutsFetched: [],
    failCancel: null,
    failResume: null,
    failGet: null,
    failMetadata: null,

    reset() {
      this.nextEvent = null;
      this.lastCheckout = null;
      this.canceled = [];
      this.resumed = [];
      this.fetched = [];
      this.metadataWrites = [];
      this.snapshot = makeSnapshot();
      this.getResults = new Map();
      this.checkouts = new Map();
      this.checkoutsFetched = [];
      this.failCancel = null;
      this.failResume = null;
      this.failGet = null;
      this.failMetadata = null;
    },

    async createCheckout(args) {
      this.lastCheckout = args;
      return { url: `https://polar.test/checkout/${args.interval}` };
    },

    async getPortalUrl(args) {
      return { url: `https://polar.test/portal/${args.customerId}` };
    },

    async cancelSubscription(id, mode) {
      if (this.failCancel) throw this.failCancel;
      this.canceled.push({ id, mode });
      return {
        ...this.snapshot,
        providerSubscriptionId: id,
        // period_end keeps access and only flags the schedule; now ends it.
        status: mode === "now" ? "canceled" : this.snapshot.status,
        cancelAtPeriodEnd: mode === "period_end",
        modifiedAt: new Date(),
      };
    },

    async resumeSubscription(id) {
      if (this.failResume) throw this.failResume;
      this.resumed.push(id);
      return {
        ...this.snapshot,
        providerSubscriptionId: id,
        status: "active",
        cancelAtPeriodEnd: false,
        modifiedAt: new Date(),
      };
    },

    async getSubscription(id) {
      if (this.failGet) throw this.failGet;
      this.fetched.push(id);
      if (this.getResults.has(id)) return this.getResults.get(id) ?? null;
      return { ...this.snapshot, providerSubscriptionId: id, modifiedAt: new Date() };
    },

    async getCheckout(id) {
      if (this.failGet) throw this.failGet;
      this.checkoutsFetched.push(id);
      return this.checkouts.get(id) ?? null;
    },

    async setSubscriptionOrg(id, orgId, userId) {
      if (this.failMetadata) throw this.failMetadata;
      this.metadataWrites.push({ id, orgId, userId });
    },

    verifyAndNormalizeWebhook() {
      return this.nextEvent;
    },
  };
}
