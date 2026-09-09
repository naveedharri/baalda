/**
 * The provider-agnostic billing seam.
 *
 * Everything above this file (routes, entitlements, webhook processing) speaks
 * only in terms of `BillingProvider` and `NormalizedBillingEvent`. The concrete
 * payment provider (Polar — see polar.ts) is the ONLY place its types appear;
 * no provider-specific type may leak past this interface. Swapping providers
 * (Stripe, Lemon Squeezy, …) means writing one new adapter, nothing else.
 */

/** Which interval the caller wants to pay on. */
export type BillingInterval = "month" | "year";

/**
 * Thrown by {@link BillingProvider.verifyAndNormalizeWebhook} when signature
 * verification fails. Provider-neutral so the webhook route can answer 403
 * without importing any provider package.
 */
export class WebhookSignatureError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

/**
 * A payment-provider webhook, normalized to the four transitions our
 * entitlement store cares about. Everything is already provider-neutral:
 *
 *  - `subscription_active`    — a subscription became active (new or resumed);
 *                               grant the org the paid plan.
 *  - `subscription_updated`   — a still-live subscription changed (period roll,
 *                               cancel-at-period-end toggled, plan swap, …).
 *  - `subscription_canceled`  — scheduled to end at period end but still active
 *                               until then (access continues; `cancelAtPeriodEnd`).
 *  - `subscription_revoked`   — access ends now (final cancellation / non-payment);
 *                               the org drops back to free.
 */
export interface NormalizedBillingEvent {
  /** Stable provider event id — used for idempotent replay protection. */
  eventId: string;
  /**
   * When the underlying subscription state changed at the provider (its
   * `modifiedAt`, falling back to the webhook timestamp). Used ONLY to order
   * events: providers don't guarantee delivery order and retries of an earlier
   * event can land after a later one, so the entitlement write is skipped when
   * this is older than the state we already hold. Never the server's receive
   * time — that would sort out-of-order deliveries the wrong way round.
   */
  occurredAt: Date;
  type:
    | "subscription_active"
    | "subscription_updated"
    | "subscription_canceled"
    | "subscription_revoked";
  /** The vault (organization) this subscription belongs to (from checkout metadata). */
  organizationId: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  /** Our internal plan id (currently always "pro"). */
  plan: string;
  /**
   * The user who started this checkout (from the same metadata), when the
   * provider still carries it. Needed because a webhook can arrive for a vault
   * we have already deleted: the `member` rows are gone, so this is the only
   * remaining answer to "whose subscription is this" (#109).
   */
  userId: string | null;
  /** Normalized status to persist: "active" | "past_due" | "canceled". */
  status: string;
  /** End of the current paid period, if known. */
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Billing period the subscription renews on, when the provider reports one. */
  interval: BillingInterval | null;
  /** Price in minor units (cents), as the provider charges it. */
  amount: number | null;
  /** ISO-4217-ish currency code, lowercased by the provider (e.g. "usd"). */
  currency: string | null;
}

/**
 * The provider's authoritative view of one subscription, returned by every
 * mutation so the caller can write it straight into our row.
 *
 * The rule this exists to enforce: Polar and our Postgres must never disagree.
 * A mutation that only said "ok" would leave us waiting on a webhook that may
 * be delayed, mis-signed, or dropped — which is how a canceled subscription
 * kept showing as Pro. Every call therefore hands back the full state, and it
 * goes through the SAME upsert (and the same `event_ts` ordering guard) the
 * webhook uses, so a snapshot and a webhook racing each other still converge.
 */
export interface SubscriptionSnapshot {
  providerSubscriptionId: string;
  providerCustomerId: string;
  /** Normalized the same way as the webhook: "active" | "past_due" | "canceled". */
  status: "active" | "past_due" | "canceled";
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  interval: BillingInterval | null;
  /** Price in minor units (cents). */
  amount: number | null;
  currency: string | null;
  /** Provider `modifiedAt` — used as `event_ts` for the ordering guard. */
  modifiedAt: Date;
}

/**
 * The provider's view of one hosted checkout session, read back by id after
 * the customer lands on the success page.
 *
 * This is the webhook-independent path to "did they pay?". The success redirect
 * is the one moment we KNOW the customer is looking at us, so instead of hoping
 * a webhook arrives (an endpoint that was never registered for this deployment,
 * a mis-signed secret, an outage — every one of them has happened) the success
 * route asks the provider for the checkout by id and writes what it says. The
 * id comes off the redirect URL, but nothing in it is trusted: everything below
 * is what the provider answered over its authenticated API.
 */
export interface CheckoutSnapshot {
  /** Provider status: only `"succeeded"` means the money is in. */
  status: "open" | "expired" | "confirmed" | "succeeded" | "failed";
  /** The vault this checkout was started for (`metadata.organization_id`). */
  orgId: string | null;
  /** The user who started it (`metadata.user_id`). */
  userId: string | null;
  /** Set once the checkout has produced a subscription. */
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
}

export interface CreateCheckoutArgs {
  orgId: string;
  userId: string;
  email: string;
  interval: BillingInterval;
  /**
   * Absolute URL the provider redirects to after successful payment. May carry
   * the provider's checkout-id placeholder (Polar: `{CHECKOUT_ID}`), which the
   * provider substitutes on redirect so the success page can confirm the
   * payment by id (see {@link BillingProvider.getCheckout}).
   */
  successUrl: string;
}

export interface BillingProvider {
  /** Create a hosted checkout session and return its URL. */
  createCheckout(args: CreateCheckoutArgs): Promise<{ url: string }>;
  /** Create a customer-portal session (manage / cancel) and return its URL. */
  getPortalUrl(args: { customerId: string }): Promise<{ url: string }>;
  /**
   * Stop a subscription.
   *
   *  - `"period_end"` — no further charges, access kept until the paid period
   *    runs out. What vault deletion and the Cancel action use: the owner has
   *    already paid for this month, so ending it early would be a refund we
   *    never promised.
   *  - `"now"` — revoke immediately (the deliberate "stop billing me today"
   *    choice, and the only way to clear a tombstone the owner no longer wants).
   */
  cancelSubscription(
    providerSubscriptionId: string,
    mode: "period_end" | "now",
  ): Promise<SubscriptionSnapshot>;
  /**
   * Un-cancel a subscription that is set to end at period end, putting it back
   * on renewal. Transfer needs this: the "delete a vault, make a new one, move
   * the subscription across" story has to end with a live Pro, not one that
   * quietly lapses at the end of the month.
   */
  resumeSubscription(providerSubscriptionId: string): Promise<SubscriptionSnapshot>;
  /**
   * Read one subscription's current state. `null` means the provider does not
   * know this id (404) — the row is referring to something that no longer
   * exists, so the caller leaves it alone rather than inventing a status.
   */
  getSubscription(providerSubscriptionId: string): Promise<SubscriptionSnapshot | null>;
  /**
   * Read one checkout session by the id the provider put on the success
   * redirect. `null` means the provider does not know this id — the URL was
   * malformed, guessed, or for another account — and the caller must treat it
   * as "nothing to confirm", never as a failure of the page.
   */
  getCheckout(checkoutId: string): Promise<CheckoutSnapshot | null>;
  /**
   * Re-point a subscription's `organization_id` / `user_id` metadata after a
   * transfer. Best-effort: the caller logs and carries on, because our own row
   * is the source of truth and webhooks resolve by provider subscription id
   * before they ever look at metadata.
   */
  setSubscriptionOrg(
    providerSubscriptionId: string,
    orgId: string,
    userId: string,
  ): Promise<void>;
  /**
   * Verify a raw webhook body + headers and normalize it. Returns `null` for a
   * valid signature carrying an event we don't act on (caller answers 202).
   * MUST throw on an invalid signature so the caller can answer 403.
   */
  verifyAndNormalizeWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedBillingEvent | null;
}
