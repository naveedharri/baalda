import { Polar } from "@polar-sh/sdk";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { config, teamMinSeats, teamPricePerSeatCents, teamProductId } from "../config.js";
import {
  WebhookSignatureError,
  type BillingInterval,
  type BillingProvider,
  type CheckoutSnapshot,
  type CreateCheckoutArgs,
  type CreateDiscountArgs,
  type ProrationBehavior,
  type SeatChangePreview,
  type NormalizedBillingEvent,
  type SubscriptionSnapshot,
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
 *  - `polar.subscriptions.update({ id, subscriptionUpdate: { cancelAtPeriodEnd } })`
 *    — schedule a cancellation at period end, or take one back (uncancel).
 *  - `polar.subscriptions.revoke({ id })` — cancel immediately.
 *  - `polar.subscriptions.get({ id })` — reconcile a row we suspect is stale.
 *  - `polar.checkouts.get({ id })` — confirm a checkout from the success
 *    redirect. Polar substitutes `{CHECKOUT_ID}` in `successUrl`, and the
 *    checkout carries `subscription_id` + our metadata once it has succeeded,
 *    so the success page can grant Pro without waiting on a webhook.
 *    Each of those returns the full `Subscription`, which `toSnapshot` maps to
 *    a `SubscriptionSnapshot` the caller writes straight into our row: after a
 *    mutation Polar's answer IS the state, so we never wait on a webhook to
 *    learn what we just did.
 *  - `PATCH /v1/subscriptions/:id` by raw fetch for metadata (see
 *    `setSubscriptionOrg`): SDK 0.48.1's `SubscriptionUpdate` union has no
 *    `metadata` variant even though the REST API accepts one.
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
const META_ACCOUNT = "billing_account_id";
const META_CLIENT_SCHEME = "client_scheme";

/**
 * Polar answered 404 for the id we asked about. Its own class so
 * `getSubscription` can turn it into `null` while every other caller still
 * sees a plain failure.
 */
class PolarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarNotFoundError";
  }
}

/**
 * Polar refused a cancel-at-period-end because the subscription is already
 * cancelled or set to cancel at period end (403 `AlreadyCanceledSubscription`).
 * The end state is exactly what the caller asked for, so `cancelSubscription`
 * reads the subscription back instead of failing (#300).
 */
class PolarAlreadyCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarAlreadyCanceledError";
  }
}

/**
 * Polar's `error` code from a failed call, read from the typed error class,
 * the raw value a `ResponseValidationError` could not parse, or the JSON body.
 */
function polarErrorCode(e: { error?: unknown; body?: unknown; rawValue?: unknown }): string | null {
  if (typeof e.error === "string") return e.error;
  const raw = e.rawValue as { error?: unknown } | null | undefined;
  if (raw && typeof raw === "object" && typeof raw.error === "string") return raw.error;
  if (typeof e.body === "string") {
    try {
      const parsed = JSON.parse(e.body) as { error?: unknown } | null;
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

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
      error?: unknown;
      rawValue?: unknown;
      pretty?: () => string;
    };
    const code = polarErrorCode(e);
    if (e.statusCode === 403 && code === "AlreadyCanceledSubscription") {
      throw new PolarAlreadyCanceledError(`Polar ${op}: subscription already canceled (HTTP 403)`);
    }
    // A 404 is not a failure for every caller: reconciliation asks about ids
    // that may have been deleted at Polar and must be able to tell "gone" from
    // "call broke". Every Polar error class extends `PolarError`, which carries
    // `statusCode`, so this fires before the neutral-Error rewrite below —
    // otherwise the status would only survive inside a prose message.
    if (e.statusCode === 404) {
      throw new PolarNotFoundError(`Polar ${op}: not found (HTTP 404)`);
    }
    if (typeof e.pretty === "function") {
      const body = typeof e.body === "string" ? e.body.slice(0, 2000) : "";
      console.error(
        `[billing] Polar ${op} failed: ${e.name} status=${e.statusCode ?? "?"}\n` +
          `${e.pretty()}\nbody: ${body}`,
      );
      throw new Error(
        code
          ? `Polar ${op} refused: ${code} (HTTP ${e.statusCode ?? "?"})`
          : `Polar ${op} returned a response this SDK could not parse (HTTP ${e.statusCode ?? "?"}) — see server logs`,
      );
    }
    throw err;
  }
}

/**
 * Domain labels Polar (email-validator) refuses as special-use or reserved
 * (RFC 2606 / 6761 / 6762 / 7686, plus `internal`).
 */
export const RESERVED_EMAIL_TLDS: readonly string[] = [
  "local",
  "localhost",
  "test",
  "invalid",
  "example",
  "internal",
  "onion",
  "arpa",
];

/**
 * The address to prefill on a Polar checkout, or undefined when Polar would
 * reject it (dev accounts like `test@context.local`). Omitting it is safe:
 * Polar then asks for the email on the checkout page.
 */
export function checkoutEmailFor(email: string | null | undefined): string | undefined {
  const trimmed = (email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).toLowerCase().replace(/\.$/, "");
  if (!domain.includes(".")) return undefined;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (!tld || RESERVED_EMAIL_TLDS.includes(tld)) return undefined;
  return trimmed;
}

/** True when a Polar error is a 422 whose `detail` names `customer_email`. */
export function isCustomerEmailRejection(err: unknown): boolean {
  return isFieldRejection(err, "customer_email");
}

/**
 * True when a Polar error is a 422 whose `detail` names `member_id`: a
 * customer-session request for a TEAM customer (one created by a seat-based
 * product) must name the member it is for (2026-10-08, "member_id is required
 * for team customers").
 */
export function isMemberRequiredRejection(err: unknown): boolean {
  return isFieldRejection(err, "member_id");
}

function isFieldRejection(err: unknown, field: string): boolean {
  const e = err as { statusCode?: number; detail?: unknown; rawValue?: unknown; body?: unknown } | null;
  if (!e || typeof e !== "object" || e.statusCode !== 422) return false;
  const candidates: unknown[] = [e.detail];
  const raw = e.rawValue as { detail?: unknown } | null | undefined;
  if (raw && typeof raw === "object") candidates.push(raw.detail);
  if (typeof e.body === "string") {
    try {
      const parsed = JSON.parse(e.body) as { detail?: unknown } | null;
      if (parsed && typeof parsed === "object") candidates.push(parsed.detail);
    } catch {
      /* not JSON */
    }
  }
  return candidates.some(
    (d) =>
      Array.isArray(d) &&
      d.some((item) => {
        const loc = (item as { loc?: unknown } | null)?.loc;
        return Array.isArray(loc) && loc.includes(field);
      }),
  );
}

/** A provider id, or null for a missing/empty one ("" must never reach Polar). */
export function nonEmpty(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
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
function normalizeStatus(polarStatus: string): SubscriptionSnapshot["status"] {
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

/** Map Polar's `recurringInterval` to our two-value interval (or null). */
function normalizeInterval(raw: unknown): BillingInterval | null {
  return raw === "month" || raw === "year" ? raw : null;
}

/** A finite number or null — Polar sends `amount` as an int, but not always. */
function normalizeAmount(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a Polar `Subscription` (the read model returned by get/update/revoke)
 * onto our neutral snapshot. Reads defensively through `unknown` rather than
 * the SDK's declared type: the same shape arrives from the webhook JSON in
 * snake_case, and the 2026-09-08 outage was caused by trusting the SDK's strict
 * parse of a payload that had drifted.
 */
function toSnapshot(raw: unknown): SubscriptionSnapshot {
  const sub = (raw ?? {}) as Record<string, unknown>;
  const pick = (snake: string, camel: string): unknown => sub[snake] ?? sub[camel];
  const periodEnd = pick("current_period_end", "currentPeriodEnd") as
    | Date
    | string
    | null
    | undefined;
  const modified = pick("modified_at", "modifiedAt") as Date | string | null | undefined;
  const modifiedAt = modified ? new Date(modified) : new Date();
  return {
    providerSubscriptionId: String(sub.id ?? ""),
    providerCustomerId: nonEmpty(pick("customer_id", "customerId")),
    status: normalizeStatus(String(pick("status", "status") ?? "")),
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    cancelAtPeriodEnd: Boolean(pick("cancel_at_period_end", "cancelAtPeriodEnd")),
    interval: normalizeInterval(pick("recurring_interval", "recurringInterval")),
    amount: normalizeAmount(pick("amount", "amount")),
    currency: pick("currency", "currency") ? String(pick("currency", "currency")) : null,
    modifiedAt: Number.isNaN(modifiedAt.getTime()) ? new Date() : modifiedAt,
    ...seatFields(sub),
  };
}

type SeatFields = Pick<
  SubscriptionSnapshot,
  | "seats"
  | "listAmount"
  | "discountId"
  | "discountName"
  | "discountBasisPoints"
  | "pendingSeats"
  | "accountId"
  | "productId"
>;

/**
 * The seat/discount/product fields shared by a snapshot and a webhook event.
 * Read defensively from either casing (webhook JSON is snake_case, SDK
 * objects camelCase). `listAmount` is derived: Polar reports only the charged
 * `amount`, so list = our configured per-seat price x seats on a Team product,
 * else (legacy product, or no seats) the charged amount plus a fixed discount
 * when one is attached, else null.
 */
function seatFields(sub: Record<string, unknown>): SeatFields {
  const pick = (snake: string, camel: string): unknown => sub[snake] ?? sub[camel];
  const int = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => (v ? String(v) : null);
  const metadata = (pick("metadata", "metadata") ?? null) as Record<string, unknown> | null;
  const discount = (pick("discount", "discount") ?? null) as Record<string, unknown> | null;
  const pending = (pick("pending_update", "pendingUpdate") ?? null) as Record<string, unknown> | null;
  const seats = int(pick("seats", "seats"));
  const productId = str(pick("product_id", "productId"));
  const interval = normalizeInterval(pick("recurring_interval", "recurringInterval"));
  const amount = normalizeAmount(pick("amount", "amount"));
  let listAmount: number | null = null;
  const isTeam =
    productId !== null &&
    (productId === config.polarProductTeamMonthlyId || productId === config.polarProductTeamYearlyId);
  if (isTeam && seats !== null && interval) {
    listAmount = teamPricePerSeatCents(interval) * seats;
  } else if (amount !== null && discount && String(discount.type ?? "") === "fixed") {
    const off = int(discount.amount);
    listAmount = off !== null ? amount + off : null;
  } else if (amount !== null && !discount) {
    listAmount = amount;
  }
  return {
    seats,
    listAmount,
    discountId: str(pick("discount_id", "discountId")) ?? str(discount?.id),
    discountName: str(discount?.name),
    discountBasisPoints:
      discount && String(discount.type ?? "") === "percentage"
        ? int(discount.basis_points ?? discount.basisPoints)
        : null,
    pendingSeats: pending ? int(pending.seats) : null,
    accountId: str(metadata?.[META_ACCOUNT]),
    productId,
  };
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
    // Polar has NO `subscription.seats_updated` payload: a seat change arrives
    // as `subscription.updated` carrying `seats` (mapped above). The
    // `customer_seat.*` family (assigned / claimed / revoked) is about who
    // holds a seat, which we track ourselves, so it is acknowledged and
    // dropped (null ⇒ the webhook route answers 202).
    default:
      return null;
  }
}

export class PolarBillingProvider implements BillingProvider {
  async createCheckout(args: CreateCheckoutArgs): Promise<{ url: string; id?: string }> {
    // Team seat products only. The legacy per-vault product ids are kept in
    // config purely to classify subscriptions bought before the switch.
    const productId = teamProductId(args.interval);
    if (!productId) {
      throw new Error(`No Polar Team product configured for interval "${args.interval}"`);
    }
    const minSeats = Math.max(args.minSeats, teamMinSeats());
    const seats = Math.max(args.seats, minSeats);
    const metadata: Record<string, string> = {
      [META_ACCOUNT]: args.accountId,
      [META_USER]: args.userId,
    };
    if (args.orgId) metadata[META_ORG] = args.orgId;
    if (args.clientScheme) metadata[META_CLIENT_SCHEME] = args.clientScheme;
    const create = (customerEmail: string | undefined) =>
      client().checkouts.create({
        products: [productId],
        successUrl: args.successUrl,
        ...(customerEmail ? { customerEmail } : {}),
        seats,
        minSeats,
        metadata,
      });
    const email = checkoutEmailFor(args.email);
    const checkout = await polarCall("checkouts.create", async () => {
      try {
        return await create(email);
      } catch (err) {
        // Polar validates the address more strictly than we can predict; the
        // field is optional (the checkout page asks for it), so drop it once.
        if (email && isCustomerEmailRejection(err)) {
          console.warn("[billing] Polar refused the checkout customer email; retrying without it");
          return await create(undefined);
        }
        throw err;
      }
    });
    return { url: checkout.url, id: checkout.id };
  }

  async updateSeats(
    providerSubscriptionId: string,
    seats: number,
    proration: ProrationBehavior,
  ): Promise<SubscriptionSnapshot> {
    const sub = await polarCall("subscriptions.update(seats)", () =>
      client().subscriptions.update({
        id: providerSubscriptionId,
        subscriptionUpdate: { seats, prorationBehavior: proration },
      }),
    );
    return toSnapshot(sub);
  }

  async changeProduct(
    providerSubscriptionId: string,
    productId: string,
    proration: ProrationBehavior,
    discountId?: string,
  ): Promise<SubscriptionSnapshot> {
    // `SubscriptionUpdateBase` carries productId + discountId + prorationBehavior
    // together, so a product move and its legacy discount land in ONE PATCH.
    const sub = await polarCall("subscriptions.update(product)", () =>
      client().subscriptions.update({
        id: providerSubscriptionId,
        subscriptionUpdate: {
          productId,
          prorationBehavior: proration,
          ...(discountId ? { discountId } : {}),
        },
      }),
    );
    return toSnapshot(sub);
  }

  async applyDiscount(
    providerSubscriptionId: string,
    discountId: string,
  ): Promise<SubscriptionSnapshot> {
    const sub = await polarCall("subscriptions.update(discount)", () =>
      client().subscriptions.update({
        id: providerSubscriptionId,
        subscriptionUpdate: { discountId },
      }),
    );
    return toSnapshot(sub);
  }

  async createDiscount(args: CreateDiscountArgs): Promise<{ id: string; name: string }> {
    const common = {
      name: args.name,
      duration: "forever" as const,
      products: args.productIds,
      metadata: { source: "baalda-legacy-price" },
    };
    const body =
      args.type === "fixed"
        ? (() => {
            if (!Number.isInteger(args.amountCents) || (args.amountCents ?? 0) <= 0) {
              throw new Error("createDiscount: fixed discount needs a positive amountCents");
            }
            return {
              ...common,
              type: "fixed" as const,
              amount: args.amountCents,
              currency: args.currency.toLowerCase() as never,
            };
          })()
        : (() => {
            const bp = args.basisPoints ?? 0;
            if (!Number.isInteger(bp) || bp <= 0 || bp > 10000) {
              throw new Error("createDiscount: percentage discount needs basisPoints in 1..10000");
            }
            return { ...common, type: "percentage" as const, basisPoints: bp };
          })();
    const d = (await polarCall("discounts.create", () => client().discounts.create(body))) as {
      id: string;
      name: string;
    };
    return { id: d.id, name: d.name };
  }

  async previewSeatChange(providerSubscriptionId: string, seats: number): Promise<SeatChangePreview> {
    // Polar 0.48.1 has no preview/quote endpoint for subscription updates, so
    // this is DERIVED: per-seat = our configured Team price for the interval
    // (Polar's `amount` is post-discount, so it cannot give the list price);
    // the fixed discount carries over unchanged; the prorated "now" charge is
    // the seat delta x per-seat x the fraction of the period left.
    const snap = await this.getSubscription(providerSubscriptionId);
    if (!snap) throw new PolarNotFoundError(`Polar subscriptions.get: not found (HTTP 404)`);
    const perSeat = snap.interval ? teamPricePerSeatCents(snap.interval) : null;
    let newAmount: number | null = null;
    let proratedNow: number | null = null;
    if (perSeat !== null) {
      // What Polar will actually charge: a percentage discount scales with the
      // seats (100% off stays $0), a fixed one carries over as the same amount.
      const bp = snap.discountBasisPoints ?? null;
      const fixedOff =
        bp === null && snap.amount !== null && snap.listAmount !== null
          ? Math.max(0, snap.listAmount - snap.amount)
          : 0;
      const afterPct = (cents: number): number =>
        bp === null ? cents : Math.round((cents * (10000 - bp)) / 10000);
      newAmount = Math.max(0, afterPct(perSeat * seats) - fixedOff);
      const delta = seats - (snap.seats ?? 0);
      if (snap.currentPeriodEnd && snap.interval) {
        const periodMs = (snap.interval === "year" ? 365 : 30) * 86400_000;
        const left = Math.min(1, Math.max(0, (snap.currentPeriodEnd.getTime() - Date.now()) / periodMs));
        proratedNow = delta > 0 ? Math.max(0, Math.round(afterPct(delta * perSeat) * left)) : 0;
      }
      if (!Number.isFinite(newAmount)) newAmount = null;
      if (proratedNow !== null && !Number.isFinite(proratedNow)) proratedNow = null;
    }
    return {
      currentSeats: snap.seats,
      newSeats: seats,
      newAmount,
      perSeat,
      currency: snap.currency,
      interval: snap.interval,
      proratedNow,
      currentPeriodEnd: snap.currentPeriodEnd,
      estimated: true,
    };
  }

  async getPortalUrl(args: { customerId: string }): Promise<{ url: string }> {
    const customerId = args.customerId.trim();
    if (!customerId) throw new Error("No billing customer");
    const create = (memberId?: string) =>
      client().customerSessions.create({ customerId, ...(memberId ? { memberId } : {}) });
    const session = await polarCall("customerSessions.create", async () => {
      try {
        return await create();
      } catch (err) {
        // A Team (seat-based) subscription makes its customer a team customer,
        // and Polar refuses a session for one without a member. The portal is
        // the billing owner's, so open it as the customer's owner member.
        if (!isMemberRequiredRejection(err)) throw err;
        const memberId = await this.ownerMemberId(customerId);
        if (!memberId) throw err;
        return await create(memberId);
      }
    });
    return { url: session.customerPortalUrl };
  }

  /**
   * The customer's owner member id (else its first member), or null. Raw GET
   * read defensively like {@link subscriptionIdForCheckout}.
   */
  async ownerMemberId(providerCustomerId: string): Promise<string | null> {
    if (!config.polarAccessToken) {
      throw new Error("Polar access token not configured");
    }
    const base =
      config.polarServer === "production"
        ? "https://api.polar.sh"
        : "https://sandbox-api.polar.sh";
    const res = await fetch(
      `${base}/v1/members/?customer_id=${encodeURIComponent(providerCustomerId)}&limit=100`,
      { headers: { authorization: `Bearer ${config.polarAccessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Polar GET /v1/members failed (HTTP ${res.status})`);
    }
    const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
    const members = (body?.items ?? []) as Array<Record<string, unknown>>;
    const owner = members.find((m) => m.role === "owner" && m.id) ?? members.find((m) => m.id);
    return owner ? String(owner.id) : null;
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    mode: "period_end" | "now",
  ): Promise<SubscriptionSnapshot> {
    if (mode === "now") {
      const sub = await polarCall("subscriptions.revoke", () =>
        client().subscriptions.revoke({ id: providerSubscriptionId }),
      );
      return toSnapshot(sub);
    }
    // `cancelAtPeriodEnd: true` is Polar's "stop renewing but keep access"
    // switch — the same one their customer portal flips, so a cancel we make
    // and a cancel the owner makes end up in identical provider state.
    try {
      const sub = await polarCall("subscriptions.update(cancelAtPeriodEnd)", () =>
        client().subscriptions.update({
          id: providerSubscriptionId,
          subscriptionUpdate: { cancelAtPeriodEnd: true },
        }),
      );
      return toSnapshot(sub);
    } catch (err) {
      // Already cancelled (an earlier attempt got this far, or the owner
      // cancelled in the portal): the state is what we wanted, so report it
      // instead of refusing the teardown on every retry (#300).
      if (!(err instanceof PolarAlreadyCanceledError)) throw err;
      const snap = await this.getSubscription(providerSubscriptionId);
      if (snap) return snap;
      throw err;
    }
  }

  async resumeSubscription(providerSubscriptionId: string): Promise<SubscriptionSnapshot> {
    // Same field, other way round: Polar documents `cancelAtPeriodEnd: false`
    // as "uncancel a subscription currently set to be revoked at period end".
    const sub = await polarCall("subscriptions.update(uncancel)", () =>
      client().subscriptions.update({
        id: providerSubscriptionId,
        subscriptionUpdate: { cancelAtPeriodEnd: false },
      }),
    );
    return toSnapshot(sub);
  }

  async getSubscription(
    providerSubscriptionId: string,
  ): Promise<SubscriptionSnapshot | null> {
    try {
      const sub = await polarCall("subscriptions.get", () =>
        client().subscriptions.get({ id: providerSubscriptionId }),
      );
      return toSnapshot(sub);
    } catch (err) {
      // Unknown at Polar. Reconciliation must not read that as "canceled" —
      // it means our row points at something that is simply not there, which
      // is a data question for a human, not a status to write.
      if (err instanceof PolarNotFoundError) return null;
      throw err;
    }
  }

  async getCheckout(checkoutId: string): Promise<CheckoutSnapshot | null> {
    let raw: unknown;
    try {
      raw = await polarCall("checkouts.get", () => client().checkouts.get({ id: checkoutId }));
    } catch (err) {
      // A guessed or stale id: nothing to confirm, and not an error the success
      // page should ever surface.
      if (err instanceof PolarNotFoundError) return null;
      throw err;
    }
    return this.checkoutSnapshot(checkoutId, raw);
  }

  /** Map a checkout read from Polar onto our snapshot (see {@link getCheckout}). */
  async checkoutSnapshot(checkoutId: string, raw: unknown): Promise<CheckoutSnapshot> {
    // Same defensive read as `toSnapshot`: the SDK's declared type is not
    // trusted over what actually arrived (see the 2026-09-08 note above).
    const co = (raw ?? {}) as Record<string, unknown>;
    const pick = (snake: string, camel: string): unknown => co[snake] ?? co[camel];
    const metadata = (pick("metadata", "metadata") ?? null) as Record<string, unknown> | null;
    const status = String(pick("status", "status") ?? "");
    const known: CheckoutSnapshot["status"][] = [
      "open",
      "expired",
      "confirmed",
      "succeeded",
      "failed",
    ];
    const str = (v: unknown): string | null => (v ? String(v) : null);
    const providerCustomerId = str(pick("customer_id", "customerId"));
    let providerSubscriptionId = str(pick("subscription_id", "subscriptionId"));
    // A fully discounted checkout (total 0) reads `succeeded` with
    // `subscription_id: null` for good, although Polar did create the
    // subscription — which records the checkout it came from. Without this
    // lookup the reconcile poll and the success page never write anything and
    // the app waits for payment forever (2026-10-08).
    if (
      !providerSubscriptionId &&
      providerCustomerId &&
      (status === "succeeded" || status === "confirmed")
    ) {
      providerSubscriptionId = await this.subscriptionIdForCheckout(
        providerCustomerId,
        checkoutId,
      ).catch((err: unknown) => {
        console.warn(
          `[billing] Polar subscription lookup for checkout ${checkoutId} failed:`,
          (err as Error).message,
        );
        return null;
      });
    }
    return {
      // An unknown status is never read as paid.
      status: (known as string[]).includes(status)
        ? (status as CheckoutSnapshot["status"])
        : "open",
      orgId: str(metadata?.[META_ORG]),
      accountId: str(metadata?.[META_ACCOUNT]),
      userId: str(metadata?.[META_USER]),
      providerSubscriptionId,
      providerCustomerId,
    };
  }

  /**
   * The id of the customer's subscription that `checkoutId` created, or null.
   * Raw GET like {@link patchMetadata}: the match is on the subscription's
   * `checkout_id`, read defensively rather than through the SDK's strict parse.
   */
  async subscriptionIdForCheckout(
    providerCustomerId: string,
    checkoutId: string,
  ): Promise<string | null> {
    if (!config.polarAccessToken) {
      throw new Error("Polar access token not configured");
    }
    const base =
      config.polarServer === "production"
        ? "https://api.polar.sh"
        : "https://sandbox-api.polar.sh";
    const res = await fetch(
      `${base}/v1/subscriptions/?customer_id=${encodeURIComponent(providerCustomerId)}&limit=100`,
      { headers: { authorization: `Bearer ${config.polarAccessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Polar GET /v1/subscriptions failed (HTTP ${res.status})`);
    }
    const body = (await res.json().catch(() => null)) as { items?: unknown[] } | null;
    for (const item of body?.items ?? []) {
      const sub = (item ?? {}) as Record<string, unknown>;
      if ((sub.checkout_id ?? sub.checkoutId) === checkoutId && sub.id) return String(sub.id);
    }
    return null;
  }

  /** @deprecated Use {@link setSubscriptionAccount}. */
  async setSubscriptionOrg(
    providerSubscriptionId: string,
    orgId: string,
    userId: string,
  ): Promise<void> {
    await this.patchMetadata(providerSubscriptionId, { [META_ORG]: orgId, [META_USER]: userId });
  }

  async setSubscriptionAccount(
    providerSubscriptionId: string,
    accountId: string,
    userId?: string,
  ): Promise<void> {
    // Read-merge-write: Polar replaces the metadata object on PATCH, and the
    // legacy `organization_id` must survive for old-route webhooks.
    const current = (await polarCall("subscriptions.get", () =>
      client().subscriptions.get({ id: providerSubscriptionId }),
    )) as { metadata?: Record<string, unknown> };
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(current.metadata ?? {})) merged[k] = String(v);
    merged[META_ACCOUNT] = accountId;
    if (userId) merged[META_USER] = userId;
    await this.patchMetadata(providerSubscriptionId, merged);
  }

  private async patchMetadata(
    providerSubscriptionId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    // Raw PATCH, not the SDK: `SubscriptionUpdate` in 0.48.1 is a six-way union
    // (seats / billing period / cancel / revoke / clear-pending / base) and not
    // one variant carries `metadata`, even though Polar's REST API accepts it
    // on `SubscriptionUpdateBase`. Keeping Polar's metadata truthful is a
    // courtesy — our own row decides who owns the subscription, and the webhook
    // resolves by provider subscription id before consulting metadata — so the
    // caller logs a failure and carries on.
    if (!config.polarAccessToken) {
      throw new Error("Polar access token not configured");
    }
    const base =
      config.polarServer === "production"
        ? "https://api.polar.sh"
        : "https://sandbox-api.polar.sh";
    const res = await fetch(
      `${base}/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${config.polarAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ metadata }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Polar PATCH /v1/subscriptions/${providerSubscriptionId} failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
      );
    }
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

    // Legacy per-vault subscriptions carry `organization_id`; Team ones carry
    // `billing_account_id` (and `organization_id` only when started from the
    // old alias route). Neither ⇒ not ours to act on.
    const orgId = String(metadata?.[META_ORG] ?? "");
    const accountIdRaw = String(metadata?.[META_ACCOUNT] ?? "");
    if (!orgId && !accountIdRaw) {
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

    // The user who checked out. Rides in the same metadata and is the ONLY
    // remaining answer to "whose subscription is this" once the vault has been
    // deleted and its `member` rows have cascaded away (#109).
    const userIdRaw = String(metadata?.[META_USER] ?? "");
    const currency = pick("currency", "currency");

    return {
      eventId: this.eventId(event.type, sub, headers),
      occurredAt: this.occurredAt(modifiedAt, headers),
      type,
      organizationId: orgId,
      userId: userIdRaw || null,
      providerCustomerId: nonEmpty(pick("customer_id", "customerId")),
      providerSubscriptionId: String(sub.id ?? ""),
      plan: "pro",
      status,
      currentPeriodEnd: currentPeriodEnd ? new Date(currentPeriodEnd) : null,
      cancelAtPeriodEnd: Boolean(pick("cancel_at_period_end", "cancelAtPeriodEnd")),
      interval: normalizeInterval(pick("recurring_interval", "recurringInterval")),
      amount: normalizeAmount(pick("amount", "amount")),
      currency: currency ? String(currency) : null,
      ...seatFields(sub),
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
