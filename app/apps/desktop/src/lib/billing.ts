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
