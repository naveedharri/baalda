import { FREE_NOTE_LIMIT } from "../../billing/note-quota.js";
import { Hono, type Context } from "hono";
import { pool } from "../../db/pool.js";
import {
  config,
  billingEnabled,
  billingModel,
  teamMinSeats,
  teamPricePerSeatCents,
  teamProductId,
  abuseMaxNotes,
} from "../../config.js";
import {
  ensureAccountForOrg,
  ensureAccountForUser,
  orgIdsForAccount,
} from "../../billing/accounts.js";
import { resolveAccountPlan, type AccountPlan } from "../../billing/plan.js";
import { accountUsage } from "../../billing/usage.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import {
  SubscriptionCancelingError,
  WebhookSignatureError,
  type BillingInterval,
  type BillingProvider,
  type CheckoutSnapshot,
  type DiscountDuration,
  type NormalizedBillingEvent,
  type SubscriptionSnapshot,
  repeatingCoversRenewal,
} from "../../billing/provider.js";
import {
  getEntitlement,
  normalizeIntervalForApi,
  seatCount,
  countOwnedUnsubscribedOrgs,
  freeVaultLimitForUser,
  type Entitlement,
} from "../../billing/entitlements.js";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_COLUMNS,
  applySubscriptionState,
  canManageSubscriptionRow,
  findByOrg,
  findByProviderSubscription,
  isActiveStatus,
  setSubscriptionAccount,
  type SubscriptionRow,
  type SubscriptionState,
} from "../../billing/store.js";
import { successPageHtml } from "./billing-success.js";
import { recheckAccount } from "../../billing/lapse.js";

/** What the success page learns from confirming a checkout. */
interface ConfirmedCheckout {
  orgId: string | null;
  /** Seats on the confirmed subscription; null when unknown or not seat-based. */
  seats: number | null;
  productId: string | null;
}

/**
 * The desktop URL schemes a checkout may hand back to: the released app,
 * the Baalda Staging app and a local `tauri dev` build. The desktop names its
 * own in the checkout request so the success page reopens the SAME build that
 * started the checkout; anything outside this list is ignored, so the page can
 * never be made to open an arbitrary scheme.
 */
const APP_SCHEMES: readonly string[] = ["baalda", "baalda-staging", "baalda-dev"];

/** `v` when it is one of {@link APP_SCHEMES}, else null. */
export function allowedAppScheme(v: unknown): string | null {
  return typeof v === "string" && APP_SCHEMES.includes(v) ? v : null;
}

/** The scheme a checkout request's `client: { channel, scheme }` names, if allowed. */
function clientSchemeFrom(body: { client?: unknown }): string | null {
  const client = body.client;
  if (!client || typeof client !== "object") return null;
  return allowedAppScheme((client as { scheme?: unknown }).scheme);
}

/**
 * The provider's success redirect. `{CHECKOUT_ID}` is Polar's placeholder,
 * substituted on redirect; `app` names the build to hand back to.
 */
function checkoutSuccessUrl(scheme: string | null): string {
  const base = `${config.betterAuthUrl}/api/billing/success?checkout_id={CHECKOUT_ID}`;
  return scheme ? `${base}&app=${encodeURIComponent(scheme)}` : base;
}

/** Is this provider product one of the configured Team seat products? */
function isTeamProduct(productId: string): boolean {
  return productId === teamProductId("month") || productId === teamProductId("year");
}

/**
 * Shape of the checkout id Polar substitutes for `{CHECKOUT_ID}` on the success
 * redirect (a UUID today). Anything else on the query string is ignored rather
 * than sent to the provider — the page must render for everyone who lands on
 * it, including someone who arrives with a mangled link.
 */
const CHECKOUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Subscription billing routes (frozen API contract).
 *
 *  GET  /api/billing/config               — public; advertises plans + limits.
 *  GET  /api/billing/mine                 — every vault I'm in + orphaned subs.
 *  GET  /api/billing/orgs/:orgId          — member: this vault's plan/seats.
 *  POST /api/billing/orgs/:orgId/checkout — owner/admin: hosted checkout URL.
 *  POST /api/billing/orgs/:orgId/portal   — owner/admin: manage/cancel URL.
 *  POST /api/billing/orgs/:orgId/cancel   — owner: stop at period end, or now.
 *  POST /api/billing/orgs/:orgId/transfer — owner: move a sub to another vault.
 *  POST /api/billing/webhook              — provider webhook (raw body, idempotent).
 *  GET  /api/billing/success              — checkout success landing page; confirms
 *                                            the checkout with the provider by id
 *                                            and bounces into the desktop app.
 *
 * When billing is disabled (no provider token), /config reports
 * `{ enabled: false }` and every other route 404s — self-host stays unlimited.
 *
 * A subscription can OUTLIVE its vault (#109/#111). Deleting a vault leaves a
 * **tombstone** row (`deleted_at` set) so the owner can still see, cancel or
 * transfer what they are paying for, and so a webhook that arrives afterwards
 * has somewhere to land instead of 500ing on a foreign key forever. Every
 * per-org route below therefore accepts the tombstone's recorded owner as well
 * as the live vault's members: `:orgId` may name a vault that no longer exists.
 */
export interface BillingDeps {
  provider: BillingProvider;
}

const PLANS = [
  { id: "pro-monthly", label: "Pro", amount: 1000, currency: "usd", interval: "month" },
  { id: "pro-yearly", label: "Pro", amount: 9700, currency: "usd", interval: "year" },
] as const;

/**
 * How stale an active row may get before `GET /mine` re-reads it from the
 * provider. Webhooks are the fast path; this is the backstop for the ones that
 * never arrive (a mis-signed endpoint, a delivery dropped during an outage —
 * 2026-09-08 was exactly that), so the two sides cannot stay diverged for
 * longer than one visit to the Billing tab.
 */
const RECONCILE_STALE_MINUTES = 10;
/** Cap the provider calls one request may make, so the tab can't hang on Polar. */
const RECONCILE_MAX_PER_REQUEST = 5;

/** A stored `discount_duration`, or null when unknown. */
function asDuration(v: string | null | undefined): DiscountDuration | null {
  return v === "once" || v === "repeating" || v === "forever" ? v : null;
}

/**
 * What the NEXT renewal will cost: `forever` (or no discount, or an unknown
 * duration from a row written before m055) = what is charged now; `once` =
 * list, the discount was spent on the first payment; `repeating` = charged
 * while started_at + months runs past the current period end, else list.
 * The repeating start is our row's created_at, so it is approximate.
 *
 * `renewalSeats` is a seat decrease scheduled for that renewal: the amount
 * is scaled from the row's seat count to it, so 19 seats at $2,090/yr with a
 * drop to 3 renews at $330/yr.
 */
function renewalAmount(row: SubscriptionRow, renewalSeats: number | null = null): number | null {
  const { amount, discounted } = renewalAtCurrentSeats(row);
  const seats = row.seats === null ? null : Number(row.seats);
  if (amount === null || renewalSeats === null || !seats || renewalSeats === seats) return amount;
  // A FIXED discount (an amount off, no basis points) does not shrink with the
  // seats: 5 seats at $50 with $20 off dropping to 3 renews at $30 − $20 = $10,
  // not $30 × 3/5 = $18. A percentage (or no discount) scales proportionally.
  const list = row.list_amount === null ? null : Number(row.list_amount);
  const interval = row.interval === "month" || row.interval === "year" ? row.interval : null;
  if (discounted && row.discount_basis_points === null && list !== null && interval) {
    const fixedOff = Math.max(0, list - amount);
    return Math.max(0, teamPricePerSeatCents(interval) * renewalSeats - fixedOff);
  }
  return Math.round((amount * renewalSeats) / seats);
}

/**
 * The next renewal at today's seat count, and whether the discount still
 * applies to it (`once` spent, `repeating` run out ⇒ list, undiscounted).
 */
function renewalAtCurrentSeats(row: SubscriptionRow): { amount: number | null; discounted: boolean } {
  const list = row.list_amount === null ? null : Number(row.list_amount);
  const charged = row.amount === null ? null : Number(row.amount);
  if (!row.discount_id) return { amount: charged, discounted: false };
  const duration = asDuration(row.discount_duration);
  if (duration === "once") return list === null ? { amount: charged, discounted: true } : { amount: list, discounted: false };
  if (duration === "repeating") {
    const covers = repeatingCoversRenewal(
      row.created_at ? new Date(row.created_at) : null,
      row.discount_duration_months,
      row.current_period_end ? new Date(row.current_period_end) : null,
    );
    if (!covers && list !== null) return { amount: list, discounted: false };
  }
  return { amount: charged, discounted: true };
}

/** Map a provider snapshot onto the shape `applySubscriptionState` persists. */
function stateFromSnapshot(
  orgId: string | null,
  snap: SubscriptionSnapshot,
  extra: Pick<SubscriptionState, "deletedAt" | "ownerUserId" | "accountId"> = {},
): SubscriptionState {
  return {
    seats: snap.seats,
    listAmount: snap.listAmount,
    // Null when Polar reports none, so a removed discount clears.
    discountId: snap.discountId ?? null,
    discountName: snap.discountName ?? null,
    discountBasisPoints: snap.discountBasisPoints ?? null,
    discountDuration: snap.discountDuration ?? null,
    discountDurationMonths: snap.discountDurationMonths ?? null,
    accountId: snap.accountId,
    organizationId: orgId,
    providerCustomerId: snap.providerCustomerId || null,
    providerSubscriptionId: snap.providerSubscriptionId || null,
    plan: "pro",
    status: snap.status,
    currentPeriodEnd: snap.currentPeriodEnd,
    cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
    eventTs: snap.modifiedAt,
    interval: snap.interval,
    amount: snap.amount,
    currency: snap.currency,
    ...extra,
  };
}

/**
 * A live subscription for a vault that is gone would bill its owner forever
 * for nothing: vault deletion cancels at period end, but a webhook can still
 * land a live, renewing subscription on a tombstone (a checkout that completed
 * after the delete, a resume from the provider portal). When that happens we
 * ask the provider to stop it at period end — never `now`, the period is paid
 * for — and write back what it answers, which is what makes this idempotent:
 * the stored row then says `cancel_at_period_end` and the next event skips it.
 *
 * Only for subscriptions this server can vouch for. The tombstone's owner must
 * be a user HERE: a provider organization shared by two servers (staging and
 * production on one Polar org) delivers every checkout to both endpoints, and
 * each sees the other's vault as "deleted". Canceling those would stop a live
 * subscription that belongs to the other deployment, so they are only logged.
 *
 * Best-effort: a refusal or outage is logged and the row stays as the provider
 * last described it; the owner can still cancel or transfer it themselves.
 */
async function cancelOrphanedSubscription(
  provider: BillingProvider,
  row: SubscriptionRow,
): Promise<void> {
  const subId = row.provider_subscription_id;
  if (!row.deleted_at || !subId || !isActiveStatus(row.status) || row.cancel_at_period_end) {
    return;
  }
  const { rowCount } = await pool.query('SELECT 1 FROM "user" WHERE id = $1', [
    row.owner_user_id ?? "",
  ]);
  if (!rowCount) {
    console.warn(
      `billing: live subscription ${subId} on deleted vault ${row.organization_id} has no owner on this server; not canceling (another deployment's?)`,
    );
    return;
  }
  try {
    const snap = await provider.cancelSubscription(subId, "period_end");
    await applySubscriptionState(pool, stateFromSnapshot(row.organization_id, snap));
    console.warn(
      `billing: canceled orphaned subscription ${subId} of deleted vault ${row.organization_id} at period end`,
    );
  } catch (err) {
    console.warn(
      `billing: could not cancel orphaned subscription ${subId} of deleted vault ${row.organization_id}:`,
      (err as Error).message,
    );
  }
}

/** The `GET /api/billing/orgs/:orgId` body — shared with cancel and transfer. */
function orgBillingBody(
  ent: Entitlement,
  seats: { members: number; pendingInvitations: number },
) {
  return {
    plan: ent.plan,
    status: ent.status,
    currentPeriodEnd: ent.currentPeriodEnd,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
    interval: ent.interval,
    amount: ent.amount,
    currency: ent.currency,
    seats: {
      members: seats.members,
      pendingInvitations: seats.pendingInvitations,
      // Active subscription ⇒ unlimited (null); otherwise the free-tier cap.
      limit: ent.active ? null : config.freeMaxMembers,
    },
  };
}

/** Read the billing view for one org (works for a tombstone: seats come back 0). */
async function readOrgBilling(orgId: string) {
  const [ent, seats] = await Promise.all([getEntitlement(orgId), seatCount(orgId)]);
  return orgBillingBody(ent, seats);
}

/**
 * Does this user own the tombstone for `orgId`? The fallback authority for
 * every per-org route: the vault is gone, so `orgRole` has nothing to answer
 * with, but the person still being charged must not be locked out of the
 * subscription they are paying for.
 */
async function ownsTombstone(orgId: string, userId: string): Promise<boolean> {
  const row = await findByOrg(pool, orgId);
  return !!row && !!row.deleted_at && row.owner_user_id === userId;
}

export function createBillingRoutes(deps: BillingDeps): Hono {
  const billing = new Hono();

  // ── public config ─────────────────────────────────────────────────────────
  billing.get("/billing/config", (c) => {
    if (!billingEnabled()) return c.json({ enabled: false });
    if (billingModel() === "team") {
      const perMonth = teamPricePerSeatCents("month");
      return c.json({
        enabled: true,
        model: "team",
        free: { people: 2, syncedVaults: 1 },
        team: {
          minSeats: teamMinSeats(),
          currency: "usd",
          prices: [
            { interval: "month", perSeat: perMonth },
            { interval: "year", perSeat: teamPricePerSeatCents("year") },
          ],
        },
        // One monthly entry so an old desktop still renders an upgrade card.
        plans: [{ id: "team-monthly", label: "Team", amount: perMonth, currency: "usd", interval: "month" }],
        freeLimits: { vaultsPerUser: 1, membersPerVault: 2, notesPerVault: abuseMaxNotes() },
      });
    }
    return c.json({
      enabled: true,
      model: "vault",
      plans: PLANS,
      freeLimits: {
        // Legacy wire field names (desktop parses by exact name); do not rename.
        vaultsPerUser: config.freeMaxVaults,
        membersPerVault: config.freeMaxMembers,
        notesPerVault: FREE_NOTE_LIMIT,
      },
    });
  });

  // ── success landing page (checkout success_url) ─────────────────────────────
  //
  // Two jobs. First, CONFIRM: the redirect carries Polar's checkout id, so we
  // read the checkout back over Polar's API and, if it succeeded, write the
  // subscription row right here. This is the path that does not depend on a
  // webhook — the staging server, whose URL Polar had no endpoint for, showed
  // exactly why: the customer paid, landed on this page, and the app polled
  // "free" for three minutes because nothing ever told the server (2026-09-09).
  // The webhook, when it does arrive, hits the same upsert and its ordering
  // guard, so the two paths converge instead of fighting. Second, HAND BACK:
  // bounce into the desktop app on this deployment's URL scheme — the same
  // hand-off the account pages use — so nobody is left staring at a browser tab
  // wondering whether the app noticed.
  billing.get("/billing/success", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const checkoutId = c.req.query("checkout_id") ?? "";
    let orgId: string | null = null;
    // Team copy when this deployment bills per seat, or when the confirmed
    // subscription is on a Team seat product (a team checkout on a server
    // still flagged "vault"); seats only ever come from the provider.
    let team = billingModel() === "team";
    let seats: number | null = null;
    if (CHECKOUT_ID_RE.test(checkoutId)) {
      // Best-effort and never fatal: the page is the customer's receipt and
      // must render even when the provider is unreachable — the app's polling
      // and the webhook are still behind it.
      try {
        const confirmed = await confirmCheckout(checkoutId);
        orgId = confirmed.orgId;
        seats = confirmed.seats;
        if (confirmed.productId && isTeamProduct(confirmed.productId)) team = true;
      } catch (err) {
        console.warn(
          `billing success: could not confirm checkout ${checkoutId}:`,
          (err as Error).message,
        );
      }
    }
    // Back to the build that started the checkout (allow-listed), else this
    // deployment's own scheme. A dev build (`baalda-dev`) gets no hand-back:
    // a macOS `tauri dev` process cannot receive deep links, so the page only
    // tells the person to switch back.
    const scheme = allowedAppScheme(c.req.query("app")) ?? config.deepLinkScheme;
    const deepLink =
      scheme === "baalda-dev"
        ? null
        : `${scheme}://billing/upgraded` + (orgId ? `?org=${encodeURIComponent(orgId)}` : "");
    return c.html(
      successPageHtml({ deepLink, plan: team ? { kind: "team", seats } : { kind: "vault" } }),
    );
  });

  /**
   * Read a checkout back from the provider and, if it has succeeded, persist
   * its subscription. Returns the vault id the checkout was for (when known),
   * whether or not anything was written.
   *
   * Nothing from the URL is trusted beyond "which checkout to ask about": the
   * vault, the user, the subscription and its state all come from the
   * provider's authenticated answer, exactly as they would off a webhook.
   */
  async function confirmCheckout(
    checkoutId: string,
    prefetched?: CheckoutSnapshot,
  ): Promise<ConfirmedCheckout> {
    const none = { seats: null, productId: null };
    const checkout = prefetched ?? (await deps.provider.getCheckout(checkoutId));
    if (!checkout) return { orgId: null, ...none };
    // Polar can redirect while the checkout still reads `confirmed`; once it
    // carries a subscription id that subscription is real, so ask for it.
    // `open`, `expired` and `failed` never write.
    const payable = checkout.status === "succeeded" || checkout.status === "confirmed";
    if (!payable || !checkout.providerSubscriptionId) {
      return { orgId: checkout.orgId, ...none };
    }
    const snap = await deps.provider.getSubscription(checkout.providerSubscriptionId);
    if (!snap) return { orgId: checkout.orgId, ...none };
    // Only a paid subscription is persisted from this path.
    if (snap.status !== "active" && snap.status !== "past_due") {
      return { orgId: checkout.orgId, ...none };
    }
    const plan = { seats: snap.seats, productId: snap.productId };

    // Same resolution as the webhook: a row that already holds this provider
    // subscription wins over the checkout's metadata (a transfer may have moved
    // it since), then the vault the checkout was started for.
    const existing = await findByProviderSubscription(pool, checkout.providerSubscriptionId);
    const accountId = existing?.billing_account_id ?? snap.accountId ?? checkout.accountId ?? null;
    let orgId = existing?.organization_id ?? checkout.orgId;
    if (!orgId && accountId) orgId = (await orgIdsForAccount(pool, accountId))[0] ?? null;
    if (!orgId) return { orgId: null, ...plan };

    // The vault may have been deleted between paying and landing here. Record
    // the tombstone the webhook would have, so the owner can still see, cancel
    // or transfer what they are paying for (#109).
    let deletedAt: Date | null | undefined;
    if (!existing) {
      const { rowCount } = await pool.query("SELECT 1 FROM organization WHERE id = $1", [orgId]);
      if (rowCount === 0) deletedAt = new Date();
    }
    await applySubscriptionState(pool, {
      ...stateFromSnapshot(orgId, snap, { deletedAt, ownerUserId: checkout.userId, accountId }),
      providerCustomerId: snap.providerCustomerId || checkout.providerCustomerId,
    });
    return { orgId, ...plan };
  }

  // ── webhook (raw body, signature-verified, idempotent) ─────────────────────
  // Registered before the gate below only conceptually; the gate short-circuits
  // disabled billing for ALL non-config routes including this one.
  billing.post("/billing/webhook", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);

    // This route is unauthenticated (signature is checked below), so bound the
    // body BEFORE buffering it — a Polar event is a few KB; 256 KB is ample.
    // Without this an attacker who knows the path could OOM the shared process
    // with a huge payload before the signature check ever runs.
    const MAX_WEBHOOK_BYTES = 256 * 1024;
    const declaredLen = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_WEBHOOK_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    // MUST read the raw body before any JSON parsing so the signature matches.
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });

    let event: NormalizedBillingEvent | null;
    try {
      event = deps.provider.verifyAndNormalizeWebhook(raw, headers);
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        return c.json({ error: "invalid signature" }, 403);
      }
      throw err;
    }

    // Valid signature, but an event we don't act on.
    if (!event) return c.body(null, 202);

    // The idempotency claim and the entitlement write MUST commit together: if
    // they were separate autocommit statements, a claim that landed before a
    // failed upsert would make Polar's retry short-circuit as "already
    // processed" and the org would never be upgraded. One transaction — a
    // failed upsert rolls back the claim so the retry re-processes cleanly.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: first writer wins; a replay claims nothing and is a no-op.
      const claim = await client.query(
        `INSERT INTO billing_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [event.eventId],
      );
      if (claim.rowCount === 0) {
        await client.query("COMMIT");
        return c.body(null, 200); // already processed
      }

      // Which row does this subscription belong to? The provider subscription
      // id wins over `metadata.organization_id`: after a transfer Polar's
      // metadata can still name the vault the subscription came FROM, and
      // following it would move a live subscription back onto a vault that no
      // longer holds it.
      const existing = await findByProviderSubscription(
        client,
        event.providerSubscriptionId,
      );
      // Resolution order: provider subscription id (above) → metadata
      // `billing_account_id` → legacy metadata `organization_id` → that
      // org's account (the store's fallback). An account-level checkout may
      // name no vault; it lands on the account's first attached vault.
      const accountId = existing?.billing_account_id ?? event.accountId ?? null;
      let orgId = existing?.organization_id ?? event.organizationId;
      if (!orgId && accountId) {
        orgId = (await orgIdsForAccount(client, accountId))[0] ?? "";
      }

      // No row yet and no such org ⇒ the vault was deleted and this event is
      // about a subscription that outlived it. Record a tombstone and answer
      // 200. Before migration 024 this hit the FK, rolled back the idempotency
      // claim with it and 500'd, so Polar retried the same event forever (#109).
      let deletedAt: Date | null | undefined;
      if (!existing) {
        const { rowCount } = await client.query(
          "SELECT 1 FROM organization WHERE id = $1",
          [orgId],
        );
        if (rowCount === 0) deletedAt = new Date();
      }

      // Ordering guard (inside applySubscriptionState): webhooks aren't
      // delivery-ordered, so provider state only applies when the incoming
      // event is at least as new as the row we hold. A stale redelivery is
      // still recorded as processed by the claim above but must NOT overwrite
      // newer state.
      const stored = await applySubscriptionState(client, {
        organizationId: orgId,
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        plan: event.plan,
        status: event.status,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        eventTs: event.occurredAt,
        interval: event.interval,
        amount: event.amount,
        currency: event.currency,
        deletedAt,
        // With the org gone there are no `member` rows to derive an owner from,
        // so checkout's `metadata.user_id` is the only remaining answer.
        ownerUserId: event.userId,
        seats: event.seats,
        listAmount: event.listAmount,
        discountId: event.discountId ?? null,
        discountName: event.discountName ?? null,
        discountBasisPoints: event.discountBasisPoints ?? null,
        discountDuration: event.discountDuration ?? null,
        discountDurationMonths: event.discountDurationMonths ?? null,
        accountId,
      });
      // Only a real tombstone: an account-level event with no vault is stored
      // as a live row with organization_id NULL, not a deleted vault.
      if (deletedAt && stored?.deleted_at) {
        console.warn(
          `billing webhook for deleted vault ${orgId}: recorded as tombstone`,
        );
      }
      if (stored?.billing_account_id && isActiveStatus(stored.status)) {
        await recordPendingSeats(client, stored.billing_account_id, event.pendingSeats, stored.seats);
      }

      await client.query("COMMIT");
      // Outside the transaction: a provider call must never hold (or roll back)
      // the idempotency claim, and its failure must never fail the webhook.
      if (stored) await cancelOrphanedSubscription(deps.provider, stored);
      return c.body(null, 200);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // ── every vault I'm in, plus subscriptions whose vault is gone ─────────────
  billing.get("/billing/mine", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const userId = session.userId;

    const { rows: memberships } = await pool.query<{
      org_id: string;
      name: string;
      role: string;
    }>(
      `SELECT o.id AS org_id, o.name AS name, m.role AS role
         FROM member m
         JOIN organization o ON o.id = m."organizationId"
        WHERE m."userId" = $1
        ORDER BY o.name ASC`,
      [userId],
    );

    // Reconcile before assembling, so what we return is what Polar says. Only
    // rows this user can actually act on, only ones that claim to be live, and
    // only after they have gone stale — a fresh row was just written by a
    // webhook or a mutation and re-reading it would be a wasted round trip.
    const manageableOrgIds = memberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.org_id);
    const { rows: stale } = await pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE (organization_id = ANY($1::text[])
               OR (owner_user_id = $2 AND deleted_at IS NOT NULL))
          AND status = ANY($3::text[])
          AND provider_subscription_id IS NOT NULL
          AND updated_at < now() - ($4 || ' minutes')::interval
        ORDER BY updated_at ASC
        LIMIT ${RECONCILE_MAX_PER_REQUEST}`,
      [
        manageableOrgIds,
        userId,
        ACTIVE_SUBSCRIPTION_STATUSES as unknown as string[],
        String(RECONCILE_STALE_MINUTES),
      ],
    );
    // Best-effort and never fatal: a provider outage must still render the tab.
    await Promise.allSettled(
      stale.map(async (row) => {
        const subId = row.provider_subscription_id;
        if (!subId) return;
        try {
          const snap = await deps.provider.getSubscription(subId);
          if (!snap) {
            // Unknown at Polar. Not "canceled" — our row points at something
            // that isn't there, which is a data question for a human.
            console.warn(
              `billing reconcile: provider does not know subscription ${subId} (vault ${row.organization_id})`,
            );
            return;
          }
          await applySubscriptionState(pool, stateFromSnapshot(row.organization_id, snap));
        } catch (err) {
          console.warn(
            `billing reconcile failed for vault ${row.organization_id}:`,
            (err as Error).message,
          );
        }
      }),
    );

    const orgIds = memberships.map((m) => m.org_id);
    const subsByOrg = new Map<string, SubscriptionRow>();
    const memberCounts = new Map<string, number>();
    const inviteCounts = new Map<string, number>();
    const owners = new Map<string, { userId: string; name: string; email: string }>();
    if (orgIds.length) {
      const [subs, members, invites, ownerRows] = await Promise.all([
        pool.query<SubscriptionRow>(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
            WHERE organization_id = ANY($1::text[])`,
          [orgIds],
        ),
        pool.query<{ org_id: string; c: number }>(
          `SELECT "organizationId" AS org_id, count(*)::int AS c FROM member
            WHERE "organizationId" = ANY($1::text[]) GROUP BY 1`,
          [orgIds],
        ),
        pool.query<{ org_id: string; c: number }>(
          `SELECT "organizationId" AS org_id, count(*)::int AS c FROM invitation
            WHERE "organizationId" = ANY($1::text[])
              AND status = 'pending' AND "expiresAt" > now()
            GROUP BY 1`,
          [orgIds],
        ),
        pool.query<{ org_id: string; user_id: string; name: string; email: string }>(
          `SELECT m."organizationId" AS org_id, u.id AS user_id, u.name AS name, u.email AS email
             FROM member m JOIN "user" u ON u.id = m."userId"
            WHERE m."organizationId" = ANY($1::text[]) AND m.role = 'owner'
            ORDER BY m."createdAt" ASC`,
          [orgIds],
        ),
      ]);
      for (const r of subs.rows) if (r.organization_id) subsByOrg.set(r.organization_id, r);
      for (const r of members.rows) memberCounts.set(r.org_id, Number(r.c));
      for (const r of invites.rows) inviteCounts.set(r.org_id, Number(r.c));
      // First owner by join time wins — the vault's creator, who pays for it.
      for (const r of ownerRows.rows) {
        if (!owners.has(r.org_id)) {
          owners.set(r.org_id, { userId: r.user_id, name: r.name, email: r.email });
        }
      }
    }

    const team = billingModel() === "team";
    const accountPlans = new Map<string, AccountPlan>();
    if (team) {
      await Promise.all(
        orgIds.map(async (id) => {
          await ensureAccountForOrg(pool, id);
          accountPlans.set(id, await resolveAccountPlan(pool, { orgId: id }));
        }),
      );
    }

    const vaults = memberships.map((m) => {
      const row = subsByOrg.get(m.org_id);
      const acct = accountPlans.get(m.org_id);
      // Team mode: an old desktop's "Pro" pill means "this vault's account pays".
      const active = team ? acct?.plan === "team" : !!row && isActiveStatus(row.status);
      const role = (m.role === "owner" || m.role === "admin" ? m.role : "member") as
        | "owner"
        | "admin"
        | "member";
      return {
        orgId: m.org_id,
        name: m.name,
        role,
        plan: (active ? "pro" : "free") as "free" | "pro",
        status: apiStatus(row?.status),
        currentPeriodEnd: row?.current_period_end
          ? new Date(row.current_period_end).toISOString()
          : null,
        cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
        interval: normalizeIntervalForApi(row?.interval ?? null),
        amount: row?.amount === undefined || row.amount === null ? null : Number(row.amount),
        currency: row?.currency ?? null,
        seats: {
          members: memberCounts.get(m.org_id) ?? 0,
          pendingInvitations: inviteCounts.get(m.org_id) ?? 0,
          limit: active ? null : config.freeMaxMembers,
        },
        billingOwner: owners.get(m.org_id) ?? null,
        // Upgrade / Manage — the same owner-or-admin gate as checkout/portal.
        canManage: role === "owner" || role === "admin",
        // Moving money is the owner's alone, and only while there is something
        // live to move.
        canTransfer: !team && role === "owner" && active,
        ...(team
          ? { accountPlan: (acct?.plan ?? "free") as "team" | "free", accountId: acct?.accountId ?? null }
          : {}),
      };
    });

    // Tombstones this user owns that are STILL being charged. A canceled
    // tombstone is history and deliberately not listed — there is nothing left
    // to act on and it would only clutter the tab.
    const { rows: orphanRows } = await pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE owner_user_id = $1
          AND deleted_at IS NOT NULL
          AND status = ANY($2::text[])
        ORDER BY deleted_at DESC`,
      [userId, ACTIVE_SUBSCRIPTION_STATUSES as unknown as string[]],
    );
    const orphaned = orphanRows.map((row) => ({
      orgId: row.organization_id,
      orgName: row.org_name,
      deletedAt: new Date(row.deleted_at as Date).toISOString(),
      status: row.status as "active" | "past_due",
      currentPeriodEnd: row.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      interval: normalizeIntervalForApi(row.interval),
      amount: row.amount === null ? null : Number(row.amount),
      currency: row.currency,
    }));

    return c.json({
      vaults,
      orphaned,
      freeLimits: {
        // Frozen wire field names, as in /config.
        vaultsPerUser: await freeVaultLimitForUser(userId),
        membersPerVault: config.freeMaxMembers,
        notesPerVault: FREE_NOTE_LIMIT,
        freeVaultsUsed: await countOwnedUnsubscribedOrgs(userId),
      },
    });
  });

  // ── status for a vault (any member, or a tombstone's owner) ────────────────
  billing.get("/billing/orgs/:orgId", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (!role && !(await ownsTombstone(orgId, session.userId))) {
      return c.json({ error: "Not a member of this vault" }, 403);
    }

    return c.json(await readOrgBilling(orgId));
  });

  // ── create checkout (owner/admin) ──────────────────────────────────────────
  billing.post("/billing/orgs/:orgId/checkout", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    const role = await orgRole(orgId, session.userId);
    if (role !== "owner" && role !== "admin") {
      return c.json({ error: "Only vault owner/admin can start checkout" }, 403);
    }

    // One vault, one subscription — always. `subscriptions` is keyed by
    // organization_id, so a second checkout would charge the card again and
    // then have nowhere to land: whichever subscription lost the upsert would
    // be invisible to us while Polar kept billing for it (the #109 shape of
    // problem, arrived at from the other direction). Refuse before the provider
    // is ever asked, so no checkout session exists to be paid for. Changing
    // plan or payment method goes through the portal; canceling goes through
    // /cancel.
    // Team mode: this route cannot carry a seat count, so an old desktop is
    // pointed at the new Plan & Billing screen instead.
    if (billingModel() === "team") {
      return c.json(
        {
          error: "upgrade_in_new_app",
          code: "upgrade_in_new_app",
          message: "Upgrade from Account Settings → Plan & Billing. Update Baalda if you do not see it.",
        },
        409,
      );
    }
    const existing = await findByOrg(pool, orgId);
    if (existing && isActiveStatus(existing.status)) {
      return c.json({ error: "already_subscribed" }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as { interval?: unknown; client?: unknown };
    const interval: BillingInterval = body.interval === "year" ? "year" : "month";
    const clientScheme = clientSchemeFrom(body);

    // `{CHECKOUT_ID}` is Polar's placeholder, substituted on redirect; the
    // success page reads the checkout back by that id to confirm the payment
    // without waiting on a webhook.
    const successUrl = checkoutSuccessUrl(clientScheme);
    try {
      const accountId = (await ensureAccountForOrg(pool, orgId)) ?? "";
      const { seats: people } = await seatsUsedForOrg(orgId);
      const { url } = await deps.provider.createCheckout({
        accountId,
        orgId,
        userId: session.userId,
        email: session.email,
        seats: Math.max(teamMinSeats(), people),
        minSeats: teamMinSeats(),
        interval,
        successUrl,
        ...(clientScheme ? { clientScheme } : {}),
      });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message || "checkout failed" }, 502);
    }
  });

  // ── customer portal (owner/admin, or a tombstone's owner) ─────────────────
  billing.post("/billing/orgs/:orgId/portal", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    if (billingModel() === "team") {
      const accountId = await ensureAccountForOrg(pool, orgId);
      if (!accountId) return c.json({ error: "no_account" }, 404);
      return accountPortal(c, accountId, session.userId);
    }
    const role = await orgRole(orgId, session.userId);
    const allowed =
      role === "owner" ||
      role === "admin" ||
      (await ownsTombstone(orgId, session.userId));
    if (!allowed) {
      return c.json({ error: "Only vault owner/admin can manage billing" }, 403);
    }

    const ent = await getEntitlement(orgId);
    if (!ent.providerCustomerId) {
      return c.json({ error: "No billing customer for this vault" }, 400);
    }
    try {
      const { url } = await deps.provider.getPortalUrl({
        customerId: ent.providerCustomerId,
      });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message || "portal failed" }, 502);
    }
  });

  // ── cancel (owner only; admins use the provider portal) ───────────────────
  // `period_end` keeps the paid period the owner already bought; `now` revokes
  // outright, which is the only way to stop paying for a vault that is gone.
  billing.post("/billing/orgs/:orgId/cancel", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    const orgId = c.req.param("orgId");
    if (billingModel() === "team") {
      const accountId = await ensureAccountForOrg(pool, orgId);
      if (!accountId) return c.json({ error: "no_subscription" }, 404);
      return accountCancel(c, accountId, session.userId);
    }
    const row = await findByOrg(pool, orgId);
    if (!row) return c.json({ error: "no_subscription" }, 404);
    if (!(await canManageSubscriptionRow(session.userId, row))) {
      return c.json({ error: "Only the vault owner can cancel the subscription" }, 403);
    }
    if (!isActiveStatus(row.status) || !row.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode: "period_end" | "now" = body.mode === "now" ? "now" : "period_end";

    let snap: SubscriptionSnapshot;
    try {
      snap = await deps.provider.cancelSubscription(row.provider_subscription_id, mode);
    } catch (err) {
      return c.json(
        {
          error: "subscription_cancel_failed",
          message: (err as Error).message || "provider cancel failed",
        },
        502,
      );
    }
    // The provider's answer IS the state — write it now rather than waiting on
    // a webhook that may be delayed or dropped.
    await applySubscriptionState(pool, stateFromSnapshot(orgId, snap));
    return c.json(await readOrgBilling(orgId));
  });

  // ── transfer a subscription to another vault I own (#110) ──────────────────
  // `:orgId` is the SOURCE and may be a tombstone: "delete the vault, make a
  // new one, move the subscription across" is the story this exists for, and
  // the subscription is only reachable through its tombstone by then.
  billing.post("/billing/orgs/:orgId/transfer", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);

    if (billingModel() === "team") {
      return c.json(
        {
          error: "transfer_retired",
          code: "transfer_retired",
          message: "Plans belong to your account now. Move a vault between accounts instead.",
        },
        409,
      );
    }
    const sourceOrgId = c.req.param("orgId");
    const body = (await c.req.json().catch(() => ({}))) as { targetOrgId?: unknown };
    const targetOrgId = typeof body.targetOrgId === "string" ? body.targetOrgId : "";
    if (!targetOrgId) return c.json({ error: "targetOrgId required" }, 400);

    const source = await findByOrg(pool, sourceOrgId);
    if (!source || !source.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }
    if (!(await canManageSubscriptionRow(session.userId, source))) {
      return c.json({ error: "Only the vault owner can transfer the subscription" }, 403);
    }
    if (!isActiveStatus(source.status)) {
      return c.json({ error: "subscription_not_active" }, 409);
    }
    // Checked before the target lookup: when source === target and the source
    // is a tombstone, the target "org" doesn't exist either, and a 404 would
    // hide the actual mistake.
    if (targetOrgId === sourceOrgId) {
      return c.json({ error: "same_vault" }, 400);
    }

    const { rows: targetOrgRows } = await pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = $1",
      [targetOrgId],
    );
    const targetName = targetOrgRows[0]?.name;
    if (targetName === undefined) return c.json({ error: "unknown_vault" }, 404);
    if ((await orgRole(targetOrgId, session.userId)) !== "owner") {
      return c.json({ error: "Only the target vault's owner can receive a subscription" }, 403);
    }
    const targetRow = await findByOrg(pool, targetOrgId);
    if (targetRow && isActiveStatus(targetRow.status)) {
      return c.json({ error: "target_already_subscribed" }, 409);
    }

    // Provider first, so a refusal changes nothing on our side. Un-cancel when
    // the subscription was scheduled to lapse (which is exactly what deleting
    // the source vault did to it) — otherwise the transfer would hand over a
    // subscription that quietly dies at the end of the month.
    let snap: SubscriptionSnapshot | null = null;
    if (source.cancel_at_period_end) {
      try {
        snap = await deps.provider.resumeSubscription(source.provider_subscription_id);
      } catch (err) {
        return c.json(
          {
            error: "subscription_resume_failed",
            message: (err as Error).message || "provider resume failed",
          },
          502,
        );
      }
    }
    // Best-effort: keep Polar's metadata honest for anyone reading it there.
    // Our row decides ownership, and webhooks resolve by provider subscription
    // id before they consult metadata, so a failure here costs us nothing.
    try {
      await deps.provider.setSubscriptionOrg(
        source.provider_subscription_id,
        targetOrgId,
        session.userId,
      );
    } catch (err) {
      console.error(
        `billing transfer: could not re-point provider metadata for ${source.provider_subscription_id}:`,
        (err as Error).message,
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A stale (canceled / none) row on the target would collide with the
      // primary key; it holds nothing worth keeping.
      if (targetRow) {
        await client.query("DELETE FROM subscriptions WHERE organization_id = $1", [
          targetOrgId,
        ]);
      }
      await client.query(
        `UPDATE subscriptions SET
           organization_id = $2,
           deleted_at      = NULL,
           org_name        = $3,
           owner_user_id   = $4,
           updated_at      = now()
         WHERE organization_id = $1`,
        [sourceOrgId, targetOrgId, targetName, session.userId],
      );
      if (snap) {
        await applySubscriptionState(
          client,
          stateFromSnapshot(targetOrgId, snap, { deletedAt: null }),
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return c.json({
      transferred: true,
      orgId: targetOrgId,
      billing: await readOrgBilling(targetOrgId),
    });
  });

  // ── account-level billing (team model) ─────────────────────────────────────
  //
  // The caller's account is the one they own (`ensureAccountForUser`); a
  // member of a vault on someone else's account may pass `?orgId=` to READ that
  // account's plan and limits, never its people or price. Every write is the
  // account owner's alone.

  /** Which account a read is about, and whether the caller manages it. */
  async function accountForRead(
    c: Context,
    userId: string,
  ): Promise<{ accountId: string; canManage: boolean } | Response> {
    const orgId = c.req.query("orgId");
    if (orgId) {
      if (!(await orgRole(orgId, userId))) {
        return c.json({ error: "Not a member of this vault" }, 403);
      }
      const accountId = await ensureAccountForOrg(pool, orgId);
      if (!accountId) return c.json({ error: "no_account" }, 404);
      return { accountId, canManage: await ownsAccount(accountId, userId) };
    }
    const accountId = await ensureAccountForUser(pool, userId);
    if (!accountId) return c.json({ error: "no_account" }, 404);
    return { accountId, canManage: true };
  }

  async function sessionAccount(c: Context) {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const accountId = await ensureAccountForUser(pool, session.userId);
    if (!accountId) return c.json({ error: "no_account" }, 404);
    return { session, accountId };
  }

  async function accountPortal(c: Context, accountId: string, userId: string) {
    if (!(await ownsAccount(accountId, userId))) {
      return c.json({ error: "Only the account owner can manage billing" }, 403);
    }
    const row = await accountSubscription(accountId);
    const { rows } = await pool.query<{ provider_customer_id: string | null }>(
      `SELECT provider_customer_id FROM billing_accounts WHERE id = $1`,
      [accountId],
    );
    const customerId = row?.provider_customer_id ?? rows[0]?.provider_customer_id ?? null;
    if (!customerId) return c.json({ error: "No billing customer for this account" }, 400);
    try {
      const { url } = await deps.provider.getPortalUrl({ customerId });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message || "portal failed" }, 502);
    }
  }

  async function accountCancel(c: Context, accountId: string, userId: string) {
    if (!(await ownsAccount(accountId, userId))) {
      return c.json({ error: "Only the account owner can cancel the subscription" }, 403);
    }
    const row = await accountSubscription(accountId);
    if (!row || !isActiveStatus(row.status) || !row.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode: "period_end" | "now" = body.mode === "now" ? "now" : "period_end";
    let snap: SubscriptionSnapshot;
    try {
      snap = await deps.provider.cancelSubscription(row.provider_subscription_id, mode);
    } catch (err) {
      return c.json(
        { error: "subscription_cancel_failed", message: (err as Error).message || "provider cancel failed" },
        502,
      );
    }
    await applySubscriptionState(pool, stateFromSnapshot(row.organization_id, snap, { accountId }));
    return c.json(await readAccountBody(accountId, true));
  }

  billing.get("/billing/account", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const who = await accountForRead(c, session.userId);
    if (who instanceof Response) return who;
    // `?refresh=1` (the account's owner only): re-read the live subscription
    // from the provider once before answering. Webhooks never reach a local
    // dev server, and a row written by an older build can lag the provider.
    // Best-effort: a provider failure still answers the stored summary.
    // At most one provider call per account per ACCOUNT_REFRESH_MS, so a
    // desktop polling with refresh cannot hammer the provider.
    if (c.req.query("refresh") === "1" && who.canManage && takeAccountRefresh(who.accountId)) {
      const row = await accountSubscription(who.accountId);
      if (row?.provider_subscription_id) {
        try {
          const snap = await deps.provider.getSubscription(row.provider_subscription_id);
          if (snap) {
            await applySubscriptionState(
              pool,
              stateFromSnapshot(row.organization_id, snap, { accountId: who.accountId }),
            );
          }
        } catch (err) {
          console.warn(
            `[billing] account refresh for ${who.accountId} failed:`,
            (err as Error).message,
          );
        }
      }
    }
    return c.json(await readAccountBody(who.accountId, who.canManage));
  });

  billing.get("/billing/account/usage", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const who = await accountForRead(c, session.userId);
    if (who instanceof Response) return who;
    return c.json(await accountUsage(pool, who.accountId));
  });

  billing.get("/billing/account/seats/preview", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    const seats = Number(c.req.query("seats"));
    if (!Number.isInteger(seats) || seats < 1) return c.json({ error: "seats required" }, 400);
    const plan = await resolveAccountPlan(pool, { accountId: ctx.accountId });
    const floor = Math.max(teamMinSeats(), plan.seatsUsed);
    if (seats < floor) return c.json({ error: "below_floor", code: "below_floor", floor }, 400);
    const row = await accountSubscription(ctx.accountId);
    if (row && isActiveStatus(row.status) && row.cancel_at_period_end) {
      return c.json(SUBSCRIPTION_CANCELING_BODY, 409);
    }
    if (row && isActiveStatus(row.status) && row.provider_subscription_id) {
      try {
        const preview = await deps.provider.previewSeatChange(row.provider_subscription_id, seats, {
          discountId: row.discount_id,
          discountBasisPoints: row.discount_basis_points,
          discountDuration: asDuration(row.discount_duration),
          discountDurationMonths: row.discount_duration_months,
          startedAt: row.created_at ? new Date(row.created_at) : null,
        });
        return c.json({ ...preview, floor });
      } catch (err) {
        return c.json({ error: (err as Error).message || "preview failed" }, 502);
      }
    }
    // No subscription yet: price a fresh checkout from the configured list price.
    const interval: BillingInterval = c.req.query("interval") === "year" ? "year" : "month";
    const perSeat = teamPricePerSeatCents(interval);
    return c.json({
      currentSeats: null,
      newSeats: seats,
      newAmount: perSeat * seats,
      perSeat,
      currency: "usd",
      interval,
      proratedNow: null,
      currentPeriodEnd: null,
      estimated: true,
      floor,
    });
  });

  billing.patch("/billing/account/seats", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => ({}))) as { seats?: unknown };
    const seats = Number(body.seats);
    if (!Number.isInteger(seats) || seats < 1) return c.json({ error: "seats required" }, 400);
    const row = await accountSubscription(ctx.accountId);
    if (!row || !isActiveStatus(row.status) || !row.provider_subscription_id) {
      return c.json({ error: "no_subscription", code: "no_subscription" }, 409);
    }
    // Scheduled to cancel: Polar refuses a seat change until it is resumed.
    if (row.cancel_at_period_end) return c.json(SUBSCRIPTION_CANCELING_BODY, 409);
    const plan = await resolveAccountPlan(pool, { accountId: ctx.accountId });
    const floor = Math.max(teamMinSeats(), plan.seatsUsed);
    if (seats < floor) return c.json({ error: "below_floor", code: "below_floor", floor }, 400);
    const current = row.seats ?? plan.seatsPurchased ?? 0;
    if (seats === current) {
      await recordPendingSeats(pool, ctx.accountId, null, row.seats);
      return c.json(await readAccountBody(ctx.accountId, true));
    }
    // More seats are billed now; fewer take effect at renewal.
    const proration = seats > current ? "invoice" : "next_period";
    let snap: SubscriptionSnapshot;
    try {
      snap = await deps.provider.updateSeats(row.provider_subscription_id, seats, proration);
    } catch (err) {
      // A cancel that raced this request (or one our row has not heard of yet).
      if (err instanceof SubscriptionCancelingError) return c.json(SUBSCRIPTION_CANCELING_BODY, 409);
      return c.json(
        { error: "seat_update_failed", message: (err as Error).message || "provider seat update failed" },
        502,
      );
    }
    const stored = await applySubscriptionState(
      pool,
      stateFromSnapshot(row.organization_id, snap, { accountId: ctx.accountId }),
    );
    await recordPendingSeats(
      pool,
      ctx.accountId,
      proration === "next_period" ? (snap.pendingSeats ?? seats) : null,
      stored?.seats ?? snap.seats,
    );
    return c.json(await readAccountBody(ctx.accountId, true));
  });

  billing.post("/billing/account/checkout", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    const row = await accountSubscription(ctx.accountId);
    if (row && isActiveStatus(row.status)) return c.json({ error: "already_subscribed" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      seats?: unknown;
      interval?: unknown;
      client?: unknown;
    };
    const interval: BillingInterval = body.interval === "year" ? "year" : "month";
    const clientScheme = clientSchemeFrom(body);
    const plan = await resolveAccountPlan(pool, { accountId: ctx.accountId });
    const floor = Math.max(teamMinSeats(), plan.seatsUsed);
    const asked = Number(body.seats);
    const seats = Number.isInteger(asked) ? Math.max(floor, asked) : floor;
    // Built here, never taken from the body: the success page is ours. Only
    // the allow-listed return scheme comes from the client.
    const successUrl = checkoutSuccessUrl(clientScheme);
    const orgId = (await orgIdsForAccount(pool, ctx.accountId))[0];
    try {
      const { url, id } = await deps.provider.createCheckout({
        accountId: ctx.accountId,
        ...(orgId ? { orgId } : {}),
        userId: ctx.session.userId,
        email: ctx.session.email,
        seats,
        minSeats: teamMinSeats(),
        interval,
        successUrl,
        ...(clientScheme ? { clientScheme } : {}),
      });
      return c.json({ url, seats, ...(id ? { checkoutId: id } : {}) });
    } catch (err) {
      return c.json({ error: (err as Error).message || "checkout failed" }, 502);
    }
  });

  // The desktop's "Waiting for payment…" screen polls this with the checkout
  // id it got from the checkout route. It reads the checkout back from the
  // provider and, once it has succeeded, writes the subscription through the
  // same confirm path as the success page, so the wait never depends on a
  // webhook (staging has none, and production's can lag). The success page's
  // single confirm is not enough on its own: Polar can redirect while the
  // checkout is still `confirmed`, before the subscription exists.
  billing.post("/billing/account/reconcile", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    const body = (await c.req.json().catch(() => ({}))) as { checkoutId?: unknown };
    const checkoutId = typeof body.checkoutId === "string" ? body.checkoutId : "";
    if (!CHECKOUT_ID_RE.test(checkoutId)) return c.json({ error: "invalid_checkout_id" }, 400);
    let checkout: CheckoutSnapshot | null;
    try {
      checkout = await deps.provider.getCheckout(checkoutId);
    } catch (err) {
      return c.json({ error: (err as Error).message || "provider unavailable" }, 502);
    }
    // Only the account the checkout was started for may reconcile it; anyone
    // else learns nothing about whether the id exists.
    if (!checkout || checkout.accountId !== ctx.accountId) {
      return c.json({ error: "checkout_not_found" }, 404);
    }
    try {
      await confirmCheckout(checkoutId, checkout);
    } catch (err) {
      console.warn(
        `billing reconcile: could not confirm checkout ${checkoutId}:`,
        (err as Error).message,
      );
    }
    return c.json({ ...(await readAccountBody(ctx.accountId, true)), checkoutStatus: checkout.status });
  });

  billing.post("/billing/account/cancel", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    return accountCancel(c, ctx.accountId, ctx.session.userId);
  });

  billing.post("/billing/account/resume", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    const row = await accountSubscription(ctx.accountId);
    if (!row || !isActiveStatus(row.status) || !row.provider_subscription_id) {
      return c.json({ error: "no_subscription" }, 404);
    }
    let snap: SubscriptionSnapshot;
    try {
      snap = await deps.provider.resumeSubscription(row.provider_subscription_id);
    } catch (err) {
      return c.json(
        { error: "subscription_resume_failed", message: (err as Error).message || "provider resume failed" },
        502,
      );
    }
    await applySubscriptionState(
      pool,
      stateFromSnapshot(row.organization_id, snap, { accountId: ctx.accountId }),
    );
    return c.json(await readAccountBody(ctx.accountId, true));
  });

  billing.post("/billing/account/portal", async (c) => {
    const ctx = await sessionAccount(c);
    if (ctx instanceof Response) return ctx;
    return accountPortal(c, ctx.accountId, ctx.session.userId);
  });

  // ── move a vault to another account (replaces transfer) ────────────────────
  billing.post("/billing/orgs/:orgId/move", async (c) => {
    if (!billingEnabled()) return c.json({ error: "Not found" }, 404);
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const orgId = c.req.param("orgId");
    const body = (await c.req.json().catch(() => ({}))) as { toAccountId?: unknown };
    const toAccountId = typeof body.toAccountId === "string" ? body.toAccountId : "";
    if (!toAccountId) return c.json({ error: "toAccountId required" }, 400);
    if ((await orgRole(orgId, session.userId)) !== "owner") {
      return c.json({ error: "Only the vault owner can move it" }, 403);
    }
    if (!(await ownsAccount(toAccountId, session.userId))) {
      return c.json({ error: "Only the destination account's owner can receive a vault" }, 403);
    }
    const fromAccountId = await ensureAccountForOrg(pool, orgId);
    if (fromAccountId === toAccountId) return c.json({ error: "same_account" }, 400);

    const dest = await resolveAccountPlan(pool, { accountId: toAccountId });
    if (dest.limits.vaults !== null && dest.vaultsAttached + 1 > dest.limits.vaults) {
      return c.json(
        {
          error: "vault_limit_reached",
          code: "vault_limit_reached",
          limit: dest.limits.vaults,
          message: "That account is on Free and already has its synced vault. Upgrade it to Team first.",
        },
        409,
      );
    }

    const client = await pool.connect();
    let movedSub: SubscriptionRow | null = null;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO billing_account_orgs (organization_id, billing_account_id, attached_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id) DO UPDATE
           SET billing_account_id = EXCLUDED.billing_account_id,
               attached_by = EXCLUDED.attached_by, attached_at = now()`,
        [orgId, toAccountId, session.userId],
      );
      const sub = await findByOrg(client, orgId);
      if (sub && billingModel() === "team" && sub.billing_account_id) {
        // Team model: the subscription belongs to the ACCOUNT, not this vault
        // (a migrated one still names its original vault). Only the vault
        // moves; the subscription, its seats and any discount stay with the
        // source account as an account-only row (organization_id NULL), the
        // same rule vault delete follows (`orgs.ts`).
        await client.query(
          `UPDATE subscriptions SET organization_id = NULL, updated_at = now() WHERE id = $1`,
          [sub.id],
        );
      } else if (sub) {
        await setSubscriptionAccount(client, sub.id, toAccountId);
        movedSub = sub;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // Best-effort: our row decides; webhooks resolve by subscription id first.
    if (movedSub?.provider_subscription_id && isActiveStatus(movedSub.status)) {
      try {
        await deps.provider.setSubscriptionAccount(
          movedSub.provider_subscription_id,
          toAccountId,
          session.userId,
        );
      } catch (err) {
        console.error(
          `billing move: could not re-point provider metadata for ${movedSub.provider_subscription_id}:`,
          (err as Error).message,
        );
      }
    }
    // Both accounts' plans changed: the source may drop under Free limits
    // (lifting a lapse), the destination may now be over them.
    await (fromAccountId ? recheckAccount(fromAccountId) : Promise.resolve(false)).catch((err) =>
      console.error("[billing] move: lapse recheck failed:", err),
    );
    await recheckAccount(toAccountId).catch((err) =>
      console.error("[billing] move: lapse recheck failed:", err),
    );
    return c.json({
      moved: true,
      orgId,
      fromAccountId,
      toAccountId,
      account: await readAccountBody(toAccountId, true),
    });
  });

  return billing;
}

/** Row status → the four values the wire contract allows. */
function apiStatus(status: string | undefined): "none" | "active" | "past_due" | "canceled" {
  if (status === "active" || status === "past_due" || status === "canceled") return status;
  return "none";
}

type Queryable = Pick<typeof pool, "query">;

/** Does this user own this billing account? */
async function ownsAccount(accountId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM billing_accounts WHERE id = $1 AND owner_user_id = $2`,
    [accountId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** The account's subscription row: a live one first, else the latest. */
/** Minimum gap between provider reads for one account's `?refresh=1`. */
const ACCOUNT_REFRESH_MS = 30_000;
const lastAccountRefresh = new Map<string, number>();

/** True (and records the attempt) when this account may refresh now. */
function takeAccountRefresh(accountId: string, now = Date.now()): boolean {
  const last = lastAccountRefresh.get(accountId);
  if (last !== undefined && now - last < ACCOUNT_REFRESH_MS) return false;
  lastAccountRefresh.set(accountId, now);
  // Keep the map bounded: drop entries past the window once it grows.
  if (lastAccountRefresh.size > 10_000) {
    for (const [id, at] of lastAccountRefresh) {
      if (now - at >= ACCOUNT_REFRESH_MS) lastAccountRefresh.delete(id);
    }
  }
  return true;
}

/** A seat change on a subscription scheduled to cancel at period end. */
const SUBSCRIPTION_CANCELING_BODY = {
  error: "subscription_canceling",
  code: "subscription_canceling",
  message: "Resume your plan before changing seats.",
} as const;

async function accountSubscription(accountId: string): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
      WHERE billing_account_id = $1
      ORDER BY (status = ANY($2::text[])) DESC, current_period_end DESC NULLS LAST, updated_at DESC
      LIMIT 1`,
    [accountId, ACTIVE_SUBSCRIPTION_STATUSES as unknown as string[]],
  );
  return rows[0] ?? null;
}

/**
 * Persist a pending seat decrease on the account (`billing_accounts.seats_pending`).
 * Cleared when the provider reports none, or when the pending number already
 * equals the live seat count (the decrease took effect).
 */
async function recordPendingSeats(
  db: Queryable,
  accountId: string,
  pending: number | null | undefined,
  liveSeats: number | null | undefined,
): Promise<void> {
  const value = pending != null && pending !== liveSeats ? pending : null;
  await db.query(
    `UPDATE billing_accounts
        SET seats_pending = $2,
            seats_pending_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $1`,
    [accountId, value],
  );
}

/** Members of one vault, for the old checkout's opening seat count. */
async function seatsUsedForOrg(orgId: string): Promise<{ seats: number }> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM member WHERE "organizationId" = $1`,
    [orgId],
  );
  return { seats: rows[0]?.n ?? 0 };
}

/** The `GET /api/billing/account` body. People and price only for a manager. */
async function readAccountBody(accountId: string, canManage: boolean) {
  const [plan, row, acct, vaultRows, invitedRows] = await Promise.all([
    resolveAccountPlan(pool, { accountId }),
    accountSubscription(accountId),
    pool.query<{ seats_pending: number | null; complimentary_until: Date | null }>(
      `SELECT seats_pending, complimentary_until FROM billing_accounts WHERE id = $1`,
      [accountId],
    ),
    pool.query<{ org_id: string; name: string }>(
      `SELECT o.id AS org_id, o.name FROM billing_account_orgs bao
         JOIN organization o ON o.id = bao.organization_id
        WHERE bao.billing_account_id = $1
        ORDER BY bao.attached_at, o.id`,
      [accountId],
    ),
    // Same predicate as `plan.ts loadAccount`'s `reserved`: pending, unexpired,
    // email not already a member of the account. An email invited to two vaults
    // counts once there, so it is attributed to ONE vault (first by name) and
    // the counts sum to `seats.reserved`.
    pool.query<{ org_id: string; name: string; count: number }>(
      `WITH orgs AS (
         SELECT organization_id FROM billing_account_orgs WHERE billing_account_id = $1
       ), people AS (
         SELECT DISTINCT lower(u.email) AS email
           FROM member m JOIN orgs o ON o.organization_id = m."organizationId"
           JOIN "user" u ON u.id = m."userId"
       ), invited AS (
         SELECT DISTINCT ON (lower(i.email)) lower(i.email) AS email, org.id AS org_id, org.name
           FROM invitation i
           JOIN orgs o ON o.organization_id = i."organizationId"
           JOIN organization org ON org.id = i."organizationId"
          WHERE i.status = 'pending' AND i."expiresAt" > now()
            AND lower(i.email) NOT IN (SELECT email FROM people)
          ORDER BY lower(i.email), org.name, org.id
       )
       SELECT org_id, name, count(*)::int AS count FROM invited
        GROUP BY org_id, name
        ORDER BY name, org_id`,
      [accountId],
    ),
  ]);
  const live = !!row && isActiveStatus(row.status);
  const pending = acct.rows[0]?.seats_pending ?? null;
  const purchased = plan.seatsPurchased;
  const pendingDecreaseTo = live && pending != null && purchased != null && pending < purchased ? pending : null;
  let people: { userId: string; name: string; email: string; vaults: string[] }[] = [];
  if (canManage) {
    const { rows } = await pool.query<{ user_id: string; name: string; email: string; vaults: string[] }>(
      `SELECT u.id AS user_id, u.name, u.email, array_agg(o.name ORDER BY o.name) AS vaults
         FROM billing_account_orgs bao
         JOIN member m ON m."organizationId" = bao.organization_id
         JOIN "user" u ON u.id = m."userId"
         JOIN organization o ON o.id = bao.organization_id
        WHERE bao.billing_account_id = $1
        GROUP BY u.id, u.name, u.email
        ORDER BY u.name, u.email`,
      [accountId],
    );
    people = rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, vaults: r.vaults }));
  }
  const complimentaryUntil = acct.rows[0]?.complimentary_until;
  return {
    id: accountId,
    status: plan.status,
    plan: plan.plan,
    interval: live ? normalizeIntervalForApi(row.interval) : null,
    currentPeriodEnd: row?.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    seats: {
      purchased,
      used: plan.seatsUsed,
      reserved: plan.seatsReserved,
      pendingDecrease:
        pendingDecreaseTo !== null
          ? {
              to: pendingDecreaseTo,
              effectiveAt: row?.current_period_end ? new Date(row.current_period_end).toISOString() : null,
            }
          : null,
    },
    price:
      canManage && live
        ? {
            list: row.list_amount === null ? null : Number(row.list_amount),
            charged: row.amount === null ? null : Number(row.amount),
            discountName: row.discount_name,
            discountBasisPoints: row.discount_basis_points,
            discountDuration: row.discount_id ? asDuration(row.discount_duration) : null,
            discountDurationMonths: row.discount_id ? row.discount_duration_months : null,
            renewalAmount: renewalAmount(row, pendingDecreaseTo),
          }
        : null,
    people,
    vaults: vaultRows.rows.map((v) => ({ orgId: v.org_id, name: v.name })),
    invitedByVault: invitedRows.rows.map((v) => ({ orgId: v.org_id, name: v.name, count: Number(v.count) })),
    limits: {
      people: plan.limits.people,
      vaults: plan.limits.vaults,
      assistant: plan.limits.assistant,
      fileSync: plan.limits.fileSync,
    },
    lapsed: plan.lapsed,
    canManage,
    complimentaryUntil: complimentaryUntil ? new Date(complimentaryUntil).toISOString() : null,
  };
}
