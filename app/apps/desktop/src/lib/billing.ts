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

export type LimitKind = "vault_limit" | "member_limit";

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
  if (hay.includes("vault_limit_reached")) return "vault_limit";
  if (hay.includes("member_limit_reached")) return "member_limit";
  return null;
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
 * Text for a row's plan pill. Pro carries its status when that status is worth
 * interrupting for; a healthy Pro just says Pro, because the line under it
 * already carries the renewal.
 */
export function planPillLabel(row: {
  plan: "free" | "pro";
  status: SubscriptionFacts["status"];
}): string {
  if (row.plan !== "pro") return "Free";
  if (row.status === "past_due") return "Past due";
  if (row.status === "canceled") return "Canceled";
  return "Pro";
}

/** The shape {@link transferTargets} filters on — a `MyBillingVault`, loosened
 *  so the helper doesn't drag the API types into its tests. */
export interface TransferCandidate {
  orgId: string;
  role: "owner" | "admin" | "member";
  plan: "free" | "pro";
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
