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
  /** Normalized status to persist: "active" | "past_due" | "canceled". */
  status: string;
  /** End of the current paid period, if known. */
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface CreateCheckoutArgs {
  orgId: string;
  userId: string;
  email: string;
  interval: BillingInterval;
  /** Absolute URL the provider redirects to after successful payment. */
  successUrl: string;
}

export interface BillingProvider {
  /** Create a hosted checkout session and return its URL. */
  createCheckout(args: CreateCheckoutArgs): Promise<{ url: string }>;
  /** Create a customer-portal session (manage / cancel) and return its URL. */
  getPortalUrl(args: { customerId: string }): Promise<{ url: string }>;
  /** Cancel a subscription at the provider (best-effort on org delete). */
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
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
