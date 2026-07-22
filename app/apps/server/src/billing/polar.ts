import { Polar } from "@polar-sh/sdk";
import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { config } from "../config.js";
import {
  WebhookSignatureError,
  type BillingProvider,
  type CreateCheckoutArgs,
  type NormalizedBillingEvent,
} from "./provider.js";

/**
 * Polar adapter for {@link BillingProvider}. This is the ONLY file that imports
 * `@polar-sh/sdk`; every Polar type is mapped to our neutral shapes here so the
 * rest of the server never sees them.
 *
 * SDK surface used (verified against @polar-sh/sdk 0.48 + docs.polar.sh):
 *  - `polar.checkouts.create({ products, successUrl, customerEmail, metadata })`
 *    → `{ url }`. Metadata set on checkout is copied onto the resulting order
 *    **and** subscription, so `organization_id`/`user_id` ride along to the
 *    subscription webhooks — that's how we key entitlements without a lookup.
 *  - `polar.customerSessions.create({ customerId })` → `{ customerPortalUrl }`
 *    (hosted manage/cancel page).
 *  - `polar.subscriptions.revoke({ id })` — cancel immediately (org delete).
 *  - `validateEvent(body, headers, secret)` from `@polar-sh/sdk/webhooks`
 *    (Standard-Webhooks based) → typed payload; throws
 *    `WebhookVerificationError` on a bad signature.
 */

/** Metadata keys we stamp on checkout so the subscription webhooks self-identify. */
const META_ORG = "organization_id";
const META_USER = "user_id";

function client(): Polar {
  if (!config.polarAccessToken) {
    throw new Error("Polar access token not configured");
  }
  return new Polar({
    accessToken: config.polarAccessToken,
    server: config.polarServer === "production" ? "production" : "sandbox",
  });
}

/** Map a Polar subscription status to the status we persist. */
function normalizeStatus(polarStatus: string): string {
  switch (polarStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    default:
      // canceled, unpaid, incomplete, incomplete_expired → treated as canceled.
      return "canceled";
  }
}

/** Map a Polar webhook `type` to our normalized event type (or null to ignore). */
function normalizeType(polarType: string): NormalizedBillingEvent["type"] | null {
  switch (polarType) {
    case "subscription.active":
    case "subscription.created":
    case "subscription.uncanceled":
      return "subscription_active";
    case "subscription.updated":
    case "subscription.past_due":
      return "subscription_updated";
    case "subscription.canceled":
      return "subscription_canceled";
    case "subscription.revoked":
      return "subscription_revoked";
    default:
      return null;
  }
}

export class PolarBillingProvider implements BillingProvider {
  async createCheckout(args: CreateCheckoutArgs): Promise<{ url: string }> {
    const productId =
      args.interval === "year"
        ? config.polarProductYearlyId
        : config.polarProductMonthlyId;
    if (!productId) {
      throw new Error(
        `No Polar product configured for interval "${args.interval}"`,
      );
    }
    const checkout = await client().checkouts.create({
      products: [productId],
      successUrl: args.successUrl,
      customerEmail: args.email,
      metadata: {
        [META_ORG]: args.orgId,
        [META_USER]: args.userId,
      },
    });
    return { url: checkout.url };
  }

  async getPortalUrl(args: { customerId: string }): Promise<{ url: string }> {
    const session = await client().customerSessions.create({
      customerId: args.customerId,
    });
    return { url: session.customerPortalUrl };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await client().subscriptions.revoke({ id: providerSubscriptionId });
  }

  verifyAndNormalizeWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedBillingEvent | null {
    if (!config.polarWebhookSecret) {
      throw new Error("Polar webhook secret not configured");
    }

    // validateEvent throws WebhookVerificationError on a bad signature (→ 403)
    // and SDKValidationError for an unknown/unparseable event type. We map the
    // former to our neutral WebhookSignatureError and swallow the latter into a
    // `null` (valid signature, event we don't act on → the route answers 202).
    let event: { type: string; data: Record<string, unknown> };
    try {
      event = validateEvent(rawBody, headers, config.polarWebhookSecret) as {
        type: string;
        data: Record<string, unknown>;
      };
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        throw new WebhookSignatureError(err.message);
      }
      // Unknown event type / parse error on a verified body: ignore it.
      return null;
    }

    const type = normalizeType(event.type);
    if (!type) return null;

    const sub = event.data as {
      id: string;
      customerId: string;
      status: string;
      currentPeriodEnd: Date | string | null;
      cancelAtPeriodEnd: boolean;
      modifiedAt?: Date | string | null;
      metadata?: Record<string, unknown> | null;
    };

    const orgId = String(sub.metadata?.[META_ORG] ?? "");
    if (!orgId) {
      // A subscription with no vault (org) metadata isn't ours to act on.
      return null;
    }

    // A revoked subscription always drops the org to a canceled/free state,
    // regardless of the raw Polar status.
    const status = type === "subscription_revoked" ? "canceled" : normalizeStatus(sub.status);

    return {
      eventId: this.eventId(event, headers),
      occurredAt: this.occurredAt(sub.modifiedAt, headers),
      type,
      organizationId: orgId,
      providerCustomerId: sub.customerId,
      providerSubscriptionId: sub.id,
      plan: "pro",
      status,
      currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
      cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    };
  }

  /**
   * A stable idempotency id for the event. Standard-Webhooks delivers a unique
   * `webhook-id` header that is stable across redeliveries of the same message
   * — the canonical dedupe key. If it's somehow absent we fall back to a
   * composite of type + subscription id + last-modified so replays still dedupe.
   */
  private eventId(
    event: { type: string; data: Record<string, unknown> },
    headers: Record<string, string>,
  ): string {
    const webhookId = headers["webhook-id"] ?? headers["Webhook-Id"];
    if (webhookId) return webhookId;
    const data = event.data as { id?: string; modifiedAt?: unknown };
    const modified = data.modifiedAt ? String(data.modifiedAt) : "";
    return `${event.type}:${String(data.id ?? "")}:${modified}`;
  }

  /**
   * When this subscription state changed, for event ordering. Prefer the
   * subscription's own `modifiedAt`; fall back to the Standard-Webhooks
   * `webhook-timestamp` (unix seconds) header; last resort, now.
   */
  private occurredAt(
    modifiedAt: Date | string | null | undefined,
    headers: Record<string, string>,
  ): Date {
    if (modifiedAt) {
      const d = new Date(modifiedAt);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const ts = headers["webhook-timestamp"] ?? headers["Webhook-Timestamp"];
    if (ts) {
      const secs = Number(ts);
      if (Number.isFinite(secs)) return new Date(secs * 1000);
    }
    return new Date();
  }
}
