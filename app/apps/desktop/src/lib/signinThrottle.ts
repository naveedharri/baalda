import { ApiError } from "./api";

/**
 * Sign-in lockout (issue #237): the server answers 429 with `Retry-After` and
 * `retryAfterSeconds` in the body once an account has too many failed attempts.
 * These helpers turn that into the dialog's countdown message.
 */

/** Seconds to wait from a rejected sign-in, or null when it was not a lockout. */
export function signInRetryAfter(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const body = e.body as { retryAfterSeconds?: unknown } | undefined;
  const n = Number(body?.retryAfterSeconds);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
}

/** "45 seconds", "1 minute", "5 minutes" — rounded up to whole minutes past 60 s. */
export function humanizeWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export function throttleMessage(seconds: number): string {
  return `Too many attempts. Try again in ${humanizeWait(seconds)}, or reset your password.`;
}
