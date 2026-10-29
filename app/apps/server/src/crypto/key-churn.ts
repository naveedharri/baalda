// SPDX-License-Identifier: Apache-2.0
//
// Brakes on account-key churn (W3 vault keys). Every account-key REPLACEMENT
// (`PUT /api/me/keys` with a different public key) moves the old key to
// `user_key_history` and shows each teammate a "<name>'s security key changed"
// prompt; every device registration (`POST /api/me/devices`) shows the
// person's other computers an "approve this computer" prompt. A stolen session
// or a looping client could otherwise flood teammates with prompts that train
// them to click Approve.
//
//  · Key replacements: at most {@link MAX_KEY_REPLACEMENTS} per user per
//    {@link KEY_REPLACEMENT_WINDOW_MS}, counted from `user_key_history.replaced_at`
//    under the `user_keys` row lock (durable and exact across restarts and
//    instances). The first PUT that creates keys and a re-PUT of the SAME key
//    never count.
//  · Device registrations / approvals: a per-user hourly window in process
//    memory, like `registry/rename-guard.ts`: a burst brake, not an audit trail.
//    Idempotent repeats (same device, same key; an existing wrap) never count.
// Refusals are 429 `rate_limited` with Retry-After and a plain message; nothing
// is stored, so the client keeps whatever it had and may retry later.

export const MAX_KEY_REPLACEMENTS = 3;
export const KEY_REPLACEMENT_WINDOW_MS = 24 * 60 * 60_000;

export const MAX_DEVICE_REGISTRATIONS_PER_HOUR = 10;
export const MAX_DEVICE_APPROVALS_PER_HOUR = 10;
export const DEVICE_WINDOW_MS = 60 * 60_000;

export const RATE_LIMITED = "rate_limited";

/** "about 3 hours" / "about 20 minutes" / "a minute". */
export function plainWait(seconds: number): string {
  if (seconds >= 2 * 3600) return `about ${Math.ceil(seconds / 3600)} hours`;
  if (seconds >= 3600) return "about an hour";
  if (seconds >= 120) return `about ${Math.ceil(seconds / 60)} minutes`;
  return "a minute";
}

const windows = new Map<string, number[]>();

/**
 * Spend one slot of `kind` for `userId`. False ⇒ over budget; nothing is
 * spent. `retryAfter` is the seconds until a slot frees up.
 */
export function takeKeyChurn(
  kind: "device-register" | "device-approve",
  userId: string,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfter: number } {
  const max = kind === "device-register" ? MAX_DEVICE_REGISTRATIONS_PER_HOUR : MAX_DEVICE_APPROVALS_PER_HOUR;
  const key = `${kind}\u0000${userId}`;
  const cutoff = now - DEVICE_WINDOW_MS;
  const hits = (windows.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) {
    windows.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0]! - cutoff) / 1000)) };
  }
  hits.push(now);
  windows.set(key, hits);
  if (windows.size > 10_000) {
    for (const [k, ts] of windows) if (!ts.some((t) => t > cutoff)) windows.delete(k);
  }
  return { ok: true };
}

/** Tests only. */
export function resetKeyChurn(): void {
  windows.clear();
}
