// Client-side helpers for the subscription-billing UX. Kept dependency-free
// (only `ApiError`/types) so it's unit-testable without the store, IPC, or DOM.
//
// The server enforces free-plan limits by rejecting with HTTP 402 and a body
// carrying one of the contract tokens `vault_limit_reached` /
// `member_limit_reached`. Some enforcement paths flow through Better Auth, whose
// body shape can't be fully controlled — so the token may land in `message`
// rather than a clean `{ error }` field. We therefore scan both the message and
// the (stringified) body for the literal token.

import { ApiError } from "./api";
import type { BillingConfig, MyBillingAccount } from "./api";

export type LimitKind =
  | "vault_limit"
  | "member_limit"
  | "note_limit"
  | "seat_limit"
  | "housekeeper"
  | "attachment"
  | "storage_limit"
  | "read_only";

/** Every 402 contract token the desktop classifies, in match order. The order
 *  matters because the haystack is a substring scan: none of these is a
 *  substring of another today, but the specific ones still go first. Pinned
 *  against the server sources by `__tests__/billingCodesLockstep.test.ts`. */
export const LIMIT_CODES: ReadonlyArray<readonly [string, LimitKind]> = [
  ["seat_limit_reached", "seat_limit"],
  ["account_read_only", "read_only"],
  ["note_limit_reached", "note_limit"],
  ["vault_limit_reached", "vault_limit"],
  ["member_limit_reached", "member_limit"],
  ["storage_limit_reached", "storage_limit"],
  ["housekeeper_requires_team", "housekeeper"],
  ["housekeeper_requires_pro", "housekeeper"],
  ["attachment_sync_requires_pro", "attachment"],
];

/** One product promise, shared by every Team card so checkout and Settings do
 * not drift. Note sync and local previews are deliberately absent: both are
 * Free features. */
export const TEAM_BENEFITS = [
  "Unlimited people, one seat each",
  "Unlimited synced vaults",
  "Standalone file sync",
  "Baalda Assistant",
  "Priority support",
] as const;

/** What the Free plan includes, as the Upgrade dialog's Free card lists it. */
export const FREE_PLAN_INCLUDES = [
  "2 people",
  "1 synced vault",
  "Unlimited notes and attachments",
  "MCP for your AI tools",
  "Real-time collaboration",
] as const;

/** @deprecated Use {@link TEAM_BENEFITS}. Kept for older imports. */
export const PRO_BENEFITS = TEAM_BENEFITS;

/** Pro's promise on servers that still bill PER VAULT (`model` absent or
 *  `vault`). Only vault-mode branches use it; Team-model screens keep
 *  {@link TEAM_BENEFITS}. */
export const LEGACY_PRO_BENEFITS = [
  "Unlimited team members",
  "Standalone file sync",
  "Baalda Assistant",
  "Doesn't count toward your free vaults",
] as const;

/** The per-vault model's Free explanation, built from the server's own
 *  `freeLimits` when it sends them (defaults: 3 members per vault, 2 free
 *  vaults). Vault-mode branches only. */
export function legacyFreePlanExplanation(
  limits?: { vaultsPerUser?: number; membersPerVault?: number } | null,
): string {
  const members = limits?.membersPerVault ?? 3;
  const vaults = limits?.vaultsPerUser ?? 2;
  return `Free includes ${members} member${members === 1 ? "" : "s"} per vault, ${vaults} free vault${vaults === 1 ? "" : "s"}, note sync, embedded attachments and MCP. Pro adds unlimited members, standalone file sync and Baalda Assistant.`;
}

/** {@link legacyFreePlanExplanation} with the default limits. */
export const LEGACY_FREE_PLAN_EXPLANATION = legacyFreePlanExplanation();

/** What a Free account does not get, listed beside the upgrade. */
export const FREE_PLAN_LACKS = [
  "More than 2 people",
  "More than 1 synced vault",
  "Standalone file sync",
  "Baalda Assistant",
] as const;

export const FREE_PLAN_EXPLANATION =
  "Free includes 2 people, 1 synced vault, note sync, embedded attachments and MCP. Team adds more people, unlimited vaults, standalone file sync and Baalda Assistant.";

export const FREE_PEOPLE_COPY = "Free includes 2 people. Upgrade to Team to add more.";
/** The Upgrade dialog's reason line when a people limit sent the user there. */
export const PEOPLE_LIMIT_REASON = "Free includes 2 people. Team has no limit.";

const syncedVaults = (n: number) => `${n} synced vault${n === 1 ? "" : "s"}`;

/**
 * Team-model nudge for a refused vault (`vault_limit_reached`). `n` is the
 * server's `limit`, which is above the default for a grandfathered account.
 */
export function teamVaultLimitCopy(n: number): string {
  return `Free includes ${syncedVaults(n)} on your account. Upgrade to Team for unlimited synced vaults.`;
}

/** The Upgrade dialog's reason line for a refused vault. */
export function vaultLimitReason(n: number): string {
  return `Free includes ${syncedVaults(n)}. Team has no limit.`;
}
export const ASK_OWNER_SEATS_COPY = "Ask the vault owner to add seats.";

/** "All 5 seats are in use." — or the count-free form when the server sent none. */
export function seatsFullCopy(seats: number | null): string {
  return seats != null ? `All ${seats} seats are in use.` : "All seats are in use.";
}

/** Every place the contract token might surface on a rejected request. */
function haystack(e: ApiError): string {
  let bodyText = "";
  try {
    bodyText = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
  } catch {
    bodyText = "";
  }
  return `${e.message} ${bodyText}`.toLowerCase();
}

/**
 * Classify a rejected request as a free-plan limit error, or `null` if it isn't
 * one. Only HTTP 402 responses carrying a contract token count — anything else
 * (403, 500, network) is a plain error the caller should surface as-is.
 */
export function classifyLimitError(e: unknown): LimitKind | null {
  if (!(e instanceof ApiError) || e.status !== 402) return null;
  const hay = haystack(e);
  for (const [code, kind] of LIMIT_CODES) if (hay.includes(code)) return kind;
  return null;
}

function numField(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object" || !(key in body)) return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The seat counts a `seat_limit_reached` 402 carried, or null when `e` is not
 *  one. A field the server left out reads as null rather than 0. */
export function seatLimitFromError(
  e: unknown,
): { seats: number | null; used: number | null; pending: number | null } | null {
  if (classifyLimitError(e) !== "seat_limit") return null;
  const body = (e as ApiError).body;
  return { seats: numField(body, "seats"), used: numField(body, "used"), pending: numField(body, "pending") };
}

// ---- Team seats (pure) -----------------------------------------------------

/** The seat stepper's floor: never below the plan minimum or the people who
 *  already count. There is no ceiling. */
export function seatBounds(used: number, minSeats: number): { min: number; max: null } {
  return { min: Math.max(minSeats, Math.max(0, Math.floor(used))), max: null };
}

/** What the stepper starts on: the floor. */
export function defaultSeats(used: number, minSeats: number): number {
  return seatBounds(used, minSeats).min;
}

export function seatTotalCents(seats: number, perSeat: number): number {
  return seats * perSeat;
}

/** "Save 8%" from the two configured per-seat prices, or null when there is no
 *  yearly price (or no monthly one to compare it with, or no saving). */
export function yearlySavingsLabel(cfg: Pick<BillingConfig, "team"> | null | undefined): string | null {
  const prices = cfg?.team?.prices ?? [];
  const month = prices.find((p) => p.interval === "month")?.perSeat;
  const year = prices.find((p) => p.interval === "year")?.perSeat;
  if (month == null || year == null || month <= 0) return null;
  const pct = Math.round((1 - year / (month * 12)) * 100);
  return pct > 0 ? `Save ${pct}%` : null;
}

/** "$10" / "$10.50" / "€110". Fixed `en-US` grouping so it is testable. */
export function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${code}`;
  }
}

/** "5 seats × $10 = $50/mo". */
export function seatTotalLine(
  seats: number,
  perSeat: number,
  currency: string,
  interval: "month" | "year",
): string {
  const per = interval === "year" ? "/yr" : "/mo";
  return `${seats} ${seats === 1 ? "seat" : "seats"} × ${formatMoney(perSeat, currency)} = ${formatMoney(seatTotalCents(seats, perSeat), currency)}${per}`;
}

/** True for the forever discount `move-legacy-subs.ts` creates (`legacy-<accountId>`). */
export function isLegacyDiscount(name: string | null | undefined): boolean {
  return typeof name === "string" && /^legacy(-|$)/i.test(name.trim());
}

/** ONE short line under the plan summary when the account pays less than the
 *  list price, else null: "Legacy price $5/mo · saving $5/mo" for a migrated
 *  legacy subscription, "Discount LAUNCH100 · saving $330/yr" for any other
 *  named discount, "Discounted · saving …" when the name is unknown. */
export function discountLine(
  account: Pick<MyBillingAccount, "price" | "interval"> & { currency?: string | null },
): string | null {
  const p = account.price;
  if (!p || p.charged >= p.list) return null;
  const per = account.interval === "year" ? "/yr" : "/mo";
  const currency = account.currency ?? "usd";
  const saving = `saving ${formatMoney(p.list - p.charged, currency)}${per}`;
  const label = p.discountName?.trim() && !isLegacyDiscount(p.discountName)
    ? `Discount ${p.discountName.trim()}`
    : "Discount";
  const renews = `${formatMoney(p.renewalAmount ?? p.list, currency)}${per}`;
  // A promo code often lasts one payment or a few months: say when it ends
  // instead of promising the saving every renewal. Forever and an unknown
  // duration (an older server) keep the saving wording.
  if (p.discountDuration === "once") {
    return `${label} applied to your first payment · renews at ${renews}`;
  }
  if (p.discountDuration === "repeating" && p.discountDurationMonths) {
    const months = p.discountDurationMonths === 1 ? "1 month" : `${p.discountDurationMonths} months`;
    return `${label} for ${months} · then ${renews}`;
  }
  if (isLegacyDiscount(p.discountName)) {
    return `Legacy price ${formatMoney(p.charged, currency)}${per} · ${saving}`;
  }
  const name = p.discountName?.trim();
  return `${name ? `Discount ${name}` : "Discounted"} · ${saving}`;
}

/** Manage seats is locked while the subscription is set to cancel at the
 *  period end: the only change on offer is Resume plan. */
export function seatChangeLocked(account: Pick<MyBillingAccount, "cancelAtPeriodEnd">): boolean {
  return account.cancelAtPeriodEnd === true;
}

export const RESUME_TO_CHANGE_SEATS = "Resume your plan to change seats.";
const BILLING_FALLBACK =
  "Billing couldn't make that change right now. Try again, or open Manage billing.";

/**
 * A billing error as a sentence for people: the server's own `message` for
 * coded refusals (`subscription_canceling` maps to {@link RESUME_TO_CHANGE_SEATS}
 * when it carries none), and a plain fallback instead of a raw provider string
 * such as "Polar subscriptions.update(seats): … (HTTP 403)" or a bare 5xx.
 */
export function billingErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const body = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : null;
  const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const raw = (m: string) => /\bpolar\b|\(HTTP \d{3}\)|^HTTP \d{3}$|subscriptions\.\w+\(/i.test(m);
  if (code === "subscription_canceling") return message && !raw(message) ? message : RESUME_TO_CHANGE_SEATS;
  if (message && !raw(message)) return message;
  if (e.status >= 500 || e.status === 0) return BILLING_FALLBACK;
  return e.message && !raw(e.message) && !/^[a-z_]+$/.test(e.message) ? e.message : BILLING_FALLBACK;
}

/**
 * The `limit` number the server reported on a limit error, if present in the
 * body. Callers fall back to `billingConfig.freeLimits` when this is null (the
 * Better-Auth path may not include a structured `limit`).
 */
export function limitFromError(e: unknown): number | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body;
  if (body && typeof body === "object" && "limit" in body) {
    const v = (body as { limit?: unknown }).limit;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// ---- Subscriptions list (#109) -------------------------------------------
//
// The Billing tab lists every vault the user belongs to plus any subscription
// left behind by a deleted vault, and each row needs the same derived facts:
// what to say about its state, what to call its plan, and which vaults a
// transfer could move it to. They live here rather than in the component so
// they stay testable without React, the store, or a server.

/** The subset of a billing row these helpers actually read. */
export interface SubscriptionFacts {
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
}

/**
 * How a row's date and price get written. Injected rather than imported:
 * `formatDate` (AccountMenu) and `formatPrice`/`perLabel` (UpgradeDialog)
 * already exist, and a second copy of "how we write a price" is exactly the
 * drift to avoid. It also keeps this module free of `Intl`, whose output is
 * locale-dependent and therefore untestable as a fixed string.
 */
export interface SubscriptionLineFormat {
  date: (iso: string) => string;
  price: (amount: number, currency: string, interval: "month" | "year" | null) => string;
}

/**
 * The secondary line under a vault in the Subscriptions list — "Renews 3 Oct
 * 2026 · $10/mo", "Ends 3 Oct 2026", "Past due" — or null when there is
 * nothing to say (a free vault).
 *
 * Order matters: `past_due` outranks everything (the money is the problem, not
 * the date), and a cancelling subscription reads as an end date, never a
 * renewal — telling someone their cancelled plan "renews" is the worst thing
 * this line could do.
 */
export function subscriptionStatusLine(
  row: SubscriptionFacts,
  fmt: SubscriptionLineFormat,
): string | null {
  if (row.status === "none") return null;
  if (row.status === "past_due") return "Past due";
  if (row.status === "canceled") {
    return row.currentPeriodEnd ? `Ended ${fmt.date(row.currentPeriodEnd)}` : "Canceled";
  }
  if (row.cancelAtPeriodEnd) {
    return row.currentPeriodEnd
      ? `Ends ${fmt.date(row.currentPeriodEnd)}`
      : "Ends at the end of the current period";
  }
  const parts: string[] = [];
  if (row.currentPeriodEnd) parts.push(`Renews ${fmt.date(row.currentPeriodEnd)}`);
  if (row.amount != null && row.currency) {
    parts.push(fmt.price(row.amount, row.currency, row.interval));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Text for a row's plan pill. Team carries its status when that status is worth
 * interrupting for; a healthy Team just says Team, because the line under it
 * already carries the renewal.
 */
export function planPillLabel(row: {
  plan: "free" | "pro" | "team";
  status: SubscriptionFacts["status"];
  readOnly?: boolean;
  complimentary?: boolean;
  lapsed?: boolean;
}): string {
  if (row.readOnly || row.lapsed) return "Read-only";
  if (row.plan === "free") return "Free";
  if (row.status === "past_due") return "Past due";
  if (row.status === "canceled") return "Canceled";
  if (row.complimentary) return "Team (complimentary)";
  return "Team";
}

/** A plan header's status pill. `tone` is the `billing-status` modifier class. */
export interface PlanStatusPill {
  label: string;
  tone: "active" | "past_due" | "canceled";
}

/**
 * The status pill beside the current plan's name in Plan & Billing: the
 * subscription's STATE, never the plan name again. Free has no status (null).
 * Read-only outranks everything, then past due (the money is the problem),
 * then a scheduled cancellation, which must never read as Active.
 */
export function planStatusPill(
  account: Pick<MyBillingAccount, "plan" | "status" | "cancelAtPeriodEnd" | "currentPeriodEnd" | "lapsed">,
  fmtDate: (iso: string) => string,
): PlanStatusPill | null {
  if (account.lapsed) return { label: "Read-only", tone: "canceled" };
  if (account.plan === "free") return null;
  if (account.status === "past_due") return { label: "Past due", tone: "past_due" };
  if (account.cancelAtPeriodEnd) {
    return {
      label: account.currentPeriodEnd ? `Cancels on ${fmtDate(account.currentPeriodEnd)}` : "Cancels at period end",
      tone: "past_due",
    };
  }
  if (account.status === "canceled") return { label: "Canceled", tone: "canceled" };
  return { label: "Active", tone: "active" };
}

/**
 * Vault Settings → Usage header, drawn by `PlanHeader` exactly like Plan &
 * Billing: the plan name ("Team" / "Free"), the same status pill (Active
 * included; null on Free, which reads "Free forever"), and whose account pays
 * when it is not the caller's. When the vault is billed on the caller's own
 * account (no other account id, or the same one) it reads that account exactly
 * like Plan & Billing; otherwise the vault's resolved plan from `/mine`
 * (`accountPlan`), whose subscription state this caller cannot see, so a Team
 * vault there reads Active.
 */
export function vaultPlanLine(input: {
  account: Pick<
    MyBillingAccount,
    "id" | "plan" | "status" | "cancelAtPeriodEnd" | "currentPeriodEnd" | "lapsed"
  > | null;
  vaultAccountId: string | null;
  fallbackPlan: "free" | "pro" | "team";
  isOwner: boolean;
  /** The vault owner's display name, for a member's "Billed on X's account". */
  ownerName?: string | null;
  fmtDate: (iso: string) => string;
}): { plan: "Team" | "Free"; status: PlanStatusPill | null; billedOn: string | null } {
  const a = input.account;
  if (input.isOwner && a && (!input.vaultAccountId || input.vaultAccountId === a.id)) {
    return { plan: a.plan === "free" ? "Free" : "Team", status: planStatusPill(a, input.fmtDate), billedOn: null };
  }
  const isFree = input.fallbackPlan === "free";
  const plan = isFree ? "Free" : "Team";
  const status: PlanStatusPill | null = isFree ? null : { label: "Active", tone: "active" };
  if (!input.isOwner) {
    const name = input.ownerName?.trim();
    return { plan, status, billedOn: name ? `Billed on ${name}'s account` : "Billed on the owner's account" };
  }
  return { plan, status, billedOn: input.vaultAccountId && a ? "Billed on another account" : null };
}

/** The shape {@link transferTargets} filters on — a `MyBillingVault`, loosened
 *  so the helper doesn't drag the API types into its tests. */
export interface TransferCandidate {
  orgId: string;
  role: "owner" | "admin" | "member";
  plan: "free" | "pro" | "team";
  status: SubscriptionFacts["status"];
}

/**
 * Vaults a subscription could be moved to: another vault the caller OWNS
 * (admin isn't enough — this changes who pays for what) that isn't already
 * paying. The `status` guard is belt-and-braces for the server's
 * `target_already_subscribed`: a target whose row is merely `canceled` still
 * reads as free and is a legal destination.
 */
export function transferTargets<T extends TransferCandidate>(
  vaults: readonly T[],
  sourceOrgId: string,
): T[] {
  return vaults.filter(
    (v) =>
      v.orgId !== sourceOrgId &&
      v.role === "owner" &&
      v.plan === "free" &&
      v.status !== "active" &&
      v.status !== "past_due",
  );
}

// ---- Plan & Billing (Team model, pure) ----------------------------------------

/** What the Manage seats dialog says about a pending change, and whether
 *  Confirm is allowed. `preview` is null while the estimate is loading. */
export function seatChangeSummary(input: {
  seats: number;
  current: number | null;
  floor: number;
  used: number;
  minSeats: number;
  preview: {
    proratedNow: number | null;
    newAmount: number | null;
    currentPeriodEnd: string | null;
  } | null;
  currency: string;
  interval: "month" | "year";
  formatDate: (iso: string) => string;
}): { text: string | null; canConfirm: boolean } {
  const { seats, current, floor, used, minSeats, preview, currency, interval } = input;
  if (seats < floor) {
    return {
      text: `You can't go below the people already on your account (${used}) or the ${minSeats}-seat minimum.`,
      canConfirm: false,
    };
  }
  if (current != null && seats === current) return { text: null, canConfirm: false };
  if (!preview) return { text: null, canConfirm: false };
  const per = interval === "year" ? "year" : "month";
  const money = (v: number | null | undefined): string | null =>
    typeof v === "number" && Number.isFinite(v) ? formatMoney(v, currency) : null;
  if (current == null || seats > current) {
    const now = money(preview.proratedNow);
    const next = money(preview.newAmount);
    let text: string;
    if (now !== null && next !== null) {
      text = `You'll be charged about ${now} today (prorated); then ${next} per ${per}.`;
    } else if (next !== null) {
      text = `Then ${next} per ${per}. Your next invoice will show the exact amount.`;
    } else {
      text = SEAT_PRICE_UNKNOWN;
    }
    return { text, canConfirm: true };
  }
  const end = preview.currentPeriodEnd;
  return {
    text: end
      ? `Goes down to ${seats} ${seats === 1 ? "seat" : "seats"} on ${input.formatDate(end)}.`
      : `Goes down to ${seats} ${seats === 1 ? "seat" : "seats"} at the end of this billing period.`,
    canConfirm: true,
  };
}

/** Shown when the seat preview has no usable prices. */
export const SEAT_PRICE_UNKNOWN = "Your next invoice will show the exact amount.";

/** "1.2 MB" style byte counts for the Usage table. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const rounded = i === 0 || v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** "2 of 2 people" when a ceiling applies (Free), else the plain count. */
export function usageAgainstLimit(
  count: number,
  limit: number | null | undefined,
  singular: string,
  plural: string,
): string {
  const noun = (n: number) => (n === 1 ? singular : plural);
  if (limit == null) return `${count} ${noun(count)}`;
  return `${count} of ${limit} ${noun(limit)}`;
}

/** The price line on the Plan card: "Free" or "$10 per seat / month". */
export function planPriceLine(
  plan: "free" | "team",
  interval: "month" | "year" | null,
  team: { currency: string; prices: { interval: "month" | "year"; perSeat: number }[] } | null | undefined,
): string {
  if (plan === "free") return "Free";
  const iv = interval ?? "month";
  const price = team?.prices.find((p) => p.interval === iv);
  if (!price || !team) return "Team";
  return `${formatMoney(price.perSeat, team.currency)} per seat / ${iv}`;
}

/** "N of M seats used" plus reserved and pending-decrease lines. */
export function seatUsageLines(
  seats: { purchased: number | null; used: number; reserved: number; pendingDecrease: { to: number; effectiveAt: string } | null },
  formatDate: (iso: string) => string,
): string[] {
  const lines: string[] = [];
  if (seats.purchased != null) lines.push(`${seats.used} of ${seats.purchased} seats used`);
  else lines.push(`${seats.used} ${seats.used === 1 ? "person" : "people"}`);
  if (seats.reserved > 0) lines.push(`${seats.reserved} reserved by pending invites`);
  if (seats.pendingDecrease) {
    lines.push(`Goes down to ${seats.pendingDecrease.to} on ${formatDate(seats.pendingDecrease.effectiveAt)}`);
  }
  return lines;
}

export const LAPSED_COPY =
  "Subscription ended. Sync is read-only until you resume or reduce to 2 people.";

/** The Plan card's seat breakdown: Seats · Claimed · Reserved · Available. */
export interface SeatBreakdown {
  purchased: number;
  claimed: number;
  reserved: number;
  available: number;
}

/**
 * Every accepted person claims a seat and every pending invitation reserves
 * one; what is left is available, never below 0 (an over-limit account shows
 * 0, not a negative). `pendingDecrease` is shown separately and does not
 * change these numbers until it takes effect.
 */
export function seatBreakdown(seats: {
  purchased: number | null;
  used: number;
  reserved: number;
}): SeatBreakdown {
  const purchased = Math.max(0, seats.purchased ?? 0);
  const claimed = Math.max(0, seats.used);
  const reserved = Math.max(0, seats.reserved);
  return { purchased, claimed, reserved, available: Math.max(0, purchased - claimed - reserved) };
}

/**
 * The quiet line above the Members and access roster. Team: seats on the
 * owner's account; Free: the 2 included people. The account
 * owner reads "your account".
 */
export function membersSeatLine(
  account: { plan: "free" | "team"; seats: { purchased: number | null; used: number; reserved: number } },
  ownerName: string | null,
  viewerIsOwner = false,
): string {
  if (account.plan === "team" && account.seats.purchased != null) {
    const b = seatBreakdown(account.seats);
    const owner = viewerIsOwner ? "your" : ownerName ? `${ownerName}'s` : "the owner's";
    return `Uses ${b.claimed} of ${b.purchased} seats on ${owner} account · ${b.reserved} reserved`;
  }
  return `Free includes 2 people on this account (${account.seats.used} of 2 used)`;
}

/** What Account Settings → Plan & Billing should show for one config fetch. */
export type BillingConfigState = "team" | "vault" | "disabled" | "error";

/**
 * Classify the outcome of `probeBillingConfig`: pass the config it resolved
 * with, or the error it threw. Only a DEFINITIVE answer is a verdict — a 200
 * with `enabled: false`, or a 404 (the billing routes 404 when the server has
 * billing off). Anything else that failed (network, timeout, 5xx, 401) is
 * `error`, never "disabled": a failed fetch says nothing about the server.
 */
export function classifyBillingConfigResult(result: unknown): BillingConfigState {
  if (result instanceof ApiError) return result.status === 404 ? "disabled" : "error";
  if (result instanceof Error || result == null || typeof result !== "object") return "error";
  const config = result as Partial<BillingConfig>;
  if (typeof config.enabled !== "boolean") return "error";
  if (!config.enabled) return "disabled";
  return config.model === "team" ? "team" : "vault";
}

/** The Plan tab's one sentence for a fetch that failed (after its retry). */
export const PLAN_LOAD_ERROR_COPY = "Couldn't load your plan. Check your connection and try again.";

/** The plan line on a server with billing off (self-hosted without a provider). */
export const SELF_HOSTED_PLAN_COPY = "Everything is included on this server. There are no plan limits.";

/**
 * Has a Team checkout we are waiting on been paid? True once the account is
 * on the Team plan or its subscription is active / past due (past due is
 * still a paid plan in its grace window).
 */
export function teamCheckoutPaid(
  account: { plan?: string | null; status?: string | null } | null | undefined,
): boolean {
  if (!account) return false;
  return account.plan === "team" || account.status === "active" || account.status === "past_due";
}

/** Poll delay while waiting for a checkout: every 3 s for the first minute,
 *  then every 10 s. */
export function checkoutPollDelay(elapsedMs: number): number {
  return elapsedMs < 60_000 ? 3_000 : 10_000;
}
