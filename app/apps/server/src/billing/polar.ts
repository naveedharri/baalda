import { Polar } from "@polar-sh/sdk";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
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
 *  - Webhook signatures are verified HERE with `standardwebhooks` directly
 *    (see `verifyWebhookSignature`), NOT with the SDK's `validateEvent`. Polar
 *    changed how it derives the signing key: endpoints whose secret was
 *    generated after their cutoff are signed the Standard-Webhooks way (strip
 *    the `whsec_` prefix, base64-decode the rest), older ones with the legacy
 *    key `base64(utf8(secret))`. The SDK (0.48 and current main) only knows the
 *    legacy derivation, so every delivery to a freshly created endpoint fails
 *    with 403 "invalid signature" — that is exactly what took production down
 *    on 2026-09-08 (paid, Polar shows an active subscription, app stays Free:
 *    all 30 retries answered 403). We try both derivations, so an endpoint of
 *    either generation verifies, and we read the few fields we need from the
 *    verified JSON ourselves instead of running it through the SDK's strict
 *    schema (which silently turned any payload drift into a 202-and-drop).
 */

/** Metadata keys we stamp on checkout so the subscription webhooks self-identify. */
const META_ORG = "organization_id";
const META_USER = "user_id";

/**
 * Run one Polar SDK call, converting its errors into something diagnosable.
 *
 * The SDK's `ResponseValidationError` carries a `message` of exactly
 * "Response validation failed" — the Zod cause, the HTTP status and the body
 * that failed to parse live on the error object and are NOT in `message`. Since
 * the routes surface `err.message` to the client, an unhandled one of these
 * reaches the UI as a bare "Response validation failed" with every clue
 * dropped. So log the detail server-side (that's the only place it can go — it
 * may quote a provider payload, which must not travel to the client) and
 * rethrow a neutral Error that at least names the operation and status.
 *
 * Note this fires on error responses too, not just success ones: the SDK
 * validates a 4xx/5xx body against its declared error schema with the same
 * message, so a wrong token/server/product — whose error body doesn't match —
 * shows up here rather than as the actual "not found"/"unauthorized".
 */
async function polarCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as {
      name?: string;
      statusCode?: number;
      body?: string;
      rawValue?: unknown;
      pretty?: () => string;
    };
    if (typeof e.pretty === "function") {
      const body = typeof e.body === "string" ? e.body.slice(0, 2000) : "";
      console.error(
        `[billing] Polar ${op} failed: ${e.name} status=${e.statusCode ?? "?"}\n` +
          `${e.pretty()}\nbody: ${body}`,
      );
      throw new Error(
        `Polar ${op} returned a response this SDK could not parse (HTTP ${e.statusCode ?? "?"}) — see server logs`,
      );
    }
    throw err;
  }
}

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
    const checkout = await polarCall("checkouts.create", () =>
      client().checkouts.create({
        products: [productId],
        successUrl: args.successUrl,
        customerEmail: args.email,
        metadata: {
          [META_ORG]: args.orgId,
          [META_USER]: args.userId,
        },
      }),
    );
    return { url: checkout.url };
  }

  async getPortalUrl(args: { customerId: string }): Promise<{ url: string }> {
    const session = await polarCall("customerSessions.create", () =>
      client().customerSessions.create({
        customerId: args.customerId,
      }),
    );
    return { url: session.customerPortalUrl };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await polarCall("subscriptions.revoke", () =>
      client().subscriptions.revoke({ id: providerSubscriptionId }),
    );
  }

  verifyAndNormalizeWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedBillingEvent | null {
    if (!config.polarWebhookSecret) {
      throw new Error("Polar webhook secret not configured");
    }

    // Throws WebhookSignatureError (→ 403) unless one of the two key
    // derivations verifies the signature (and the timestamp is fresh).
    const parsed = verifyWebhookSignature(rawBody, headers, config.polarWebhookSecret);

    // Valid signature but not an event envelope we understand → ignore (202).
    if (!parsed || typeof parsed !== "object") return null;
    const event = parsed as { type?: unknown; data?: unknown };
    if (typeof event.type !== "string") return null;
    const type = normalizeType(event.type);
    if (!type) return null;
    if (!event.data || typeof event.data !== "object") return null;

    // Polar's wire format is snake_case; accept camelCase too so a payload
    // that already went through the SDK's parser (tests, future refactors)
    // normalizes identically.
    const sub = event.data as Record<string, unknown>;
    const pick = (snake: string, camel: string): unknown => sub[snake] ?? sub[camel];
    const metadata = (pick("metadata", "metadata") ?? null) as Record<string, unknown> | null;

    const orgId = String(metadata?.[META_ORG] ?? "");
    if (!orgId) {
      // A subscription with no vault (org) metadata isn't ours to act on.
      return null;
    }

    const rawStatus = String(pick("status", "status") ?? "");
    // A revoked subscription always drops the org to a canceled/free state,
    // regardless of the raw Polar status.
    const status = type === "subscription_revoked" ? "canceled" : normalizeStatus(rawStatus);
    const modifiedAt = pick("modified_at", "modifiedAt") as Date | string | null | undefined;
    const currentPeriodEnd = pick("current_period_end", "currentPeriodEnd") as
      | Date
      | string
      | null
      | undefined;

    return {
      eventId: this.eventId(event.type, sub, headers),
      occurredAt: this.occurredAt(modifiedAt, headers),
      type,
      organizationId: orgId,
      providerCustomerId: String(pick("customer_id", "customerId") ?? ""),
      providerSubscriptionId: String(sub.id ?? ""),
      plan: "pro",
      status,
      currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : null,
      cancelAtPeriodEnd: Boolean(pick("cancel_at_period_end", "cancelAtPeriodEnd")),
    };
  }

  /**
   * A stable idempotency id for the event. Standard-Webhooks delivers a unique
   * `webhook-id` header that is stable across redeliveries of the same message
   * — the canonical dedupe key. If it's somehow absent we fall back to a
   * composite of type + subscription id + last-modified so replays still dedupe.
   */
  private eventId(
    type: string,
    data: Record<string, unknown>,
    headers: Record<string, string>,
  ): string {
    const webhookId = headers["webhook-id"] ?? headers["Webhook-Id"];
    if (webhookId) return webhookId;
    const modifiedRaw = data.modified_at ?? data.modifiedAt;
    const modified = modifiedRaw ? String(modifiedRaw) : "";
    return `${type}:${String(data.id ?? "")}:${modified}`;
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

/**
 * Verify a Standard-Webhooks signature the way Polar produces it, for BOTH
 * generations of Polar secret, and return the parsed JSON body.
 *
 *  1. Standard derivation — `new Webhook(secret)`: strips a `whsec_` prefix and
 *     base64-decodes the remainder into the raw HMAC key. This is how Polar
 *     signs for endpoints whose secret was generated after its cutoff (see
 *     `sign_webhook` / `uses_standard_webhook_signature` in polarsource/polar).
 *  2. Legacy derivation — `new Webhook(base64(utf8(secret)))`: the HMAC key is
 *     the secret's own UTF-8 bytes. Older endpoints, and what
 *     `@polar-sh/sdk`'s `validateEvent` does exclusively.
 *
 * The library also enforces the ±5 min timestamp tolerance. Any derivation
 * that cannot even build a key (a non-base64 legacy secret under #1) is simply
 * skipped. Exported for tests.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): unknown {
  const derivations: Array<() => Webhook> = [
    () => new Webhook(secret),
    () => new Webhook(Buffer.from(secret, "utf-8").toString("base64")),
  ];
  let lastMessage = "invalid signature";
  for (const make of derivations) {
    let wh: Webhook;
    try {
      wh = make();
    } catch {
      continue; // secret not decodable under this derivation
    }
    try {
      return wh.verify(rawBody, headers);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        lastMessage = err.message;
        continue;
      }
      throw err;
    }
  }
  throw new WebhookSignatureError(lastMessage);
}
