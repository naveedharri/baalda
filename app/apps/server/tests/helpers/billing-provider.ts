import type {
  BillingProvider,
  CheckoutSnapshot,
  CreateDiscountArgs,
  ProrationBehavior,
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

export interface SeatsCall {
  id: string;
  seats: number;
  proration: ProrationBehavior;
}

export interface ProductCall {
  id: string;
  productId: string;
  proration: ProrationBehavior;
  discountId?: string;
}

export interface AccountMetadataCall {
  id: string;
  accountId: string;
  userId?: string;
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
  seatUpdates: SeatsCall[];
  productChanges: ProductCall[];
  discountsApplied: { id: string; discountId: string }[];
  discountsCreated: CreateDiscountArgs[];
  accountMetadataWrites: AccountMetadataCall[];
  failSeats: Error | null;
  failProduct: Error | null;
  failDiscount: Error | null;
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
    seats: null,
    listAmount: 1000,
    discountId: null,
    discountName: null,
    pendingSeats: null,
    accountId: null,
    productId: null,
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
    seatUpdates: [],
    productChanges: [],
    discountsApplied: [],
    discountsCreated: [],
    accountMetadataWrites: [],
    failSeats: null,
    failProduct: null,
    failDiscount: null,

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
      this.seatUpdates = [];
      this.productChanges = [];
      this.discountsApplied = [];
      this.discountsCreated = [];
      this.accountMetadataWrites = [];
      this.failSeats = null;
      this.failProduct = null;
      this.failDiscount = null;
    },

    async createCheckout(args) {
      this.lastCheckout = args;
      return { url: `https://polar.test/checkout/${args.interval}`, id: `chk_${args.interval}` };
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

    async setSubscriptionAccount(id, accountId, userId) {
      if (this.failMetadata) throw this.failMetadata;
      this.accountMetadataWrites.push({ id, accountId, userId });
    },

    async updateSeats(id, seats, proration) {
      if (this.failSeats) throw this.failSeats;
      this.seatUpdates.push({ id, seats, proration });
      const deferred = proration === "next_period";
      const perSeat = this.snapshot.interval === "year" ? 11000 : 1000;
      return {
        ...this.snapshot,
        providerSubscriptionId: id,
        seats: deferred ? this.snapshot.seats : seats,
        pendingSeats: deferred ? seats : null,
        listAmount: deferred ? this.snapshot.listAmount : perSeat * seats,
        modifiedAt: new Date(),
      };
    },

    async changeProduct(id, productId, proration, discountId) {
      if (this.failProduct) throw this.failProduct;
      this.productChanges.push({ id, productId, proration, discountId });
      return {
        ...this.snapshot,
        providerSubscriptionId: id,
        productId,
        discountId: discountId ?? this.snapshot.discountId,
        modifiedAt: new Date(),
      };
    },

    async applyDiscount(id, discountId) {
      if (this.failDiscount) throw this.failDiscount;
      this.discountsApplied.push({ id, discountId });
      return { ...this.snapshot, providerSubscriptionId: id, discountId, modifiedAt: new Date() };
    },

    async createDiscount(args) {
      if (this.failDiscount) throw this.failDiscount;
      this.discountsCreated.push(args);
      return { id: `disc_${this.discountsCreated.length}`, name: args.name };
    },

    async previewSeatChange(id, seats) {
      if (this.failGet) throw this.failGet;
      const perSeat = this.snapshot.interval === "year" ? 11000 : 1000;
      return {
        currentSeats: this.snapshot.seats,
        newSeats: seats,
        newAmount: perSeat * seats,
        perSeat,
        currency: this.snapshot.currency,
        interval: this.snapshot.interval,
        proratedNow: 0,
        currentPeriodEnd: this.snapshot.currentPeriodEnd,
        estimated: true,
      };
    },

    verifyAndNormalizeWebhook() {
      return this.nextEvent;
    },
  };
}
