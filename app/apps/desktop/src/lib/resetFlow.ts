// Password-reset request outcomes → sentences a person can act on.
//
// The server (`POST /api/password-reset/request`) says exactly what happened
// rather than the usual neutral "if an account exists…", because in practice
// that sentence hid the two things that actually go wrong: the address has no
// account on THIS server (they signed up elsewhere, or with another email), or
// the mail provider refused the message. Each gets its own line here.

import { ApiError } from "./api";

export interface ResetFailureContext {
  email: string;
  /** Host of the server the request went to, e.g. "api.baalda.com". */
  serverHost: string;
}

function errorCode(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const code = (err.body as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return null;
}

function serverMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const m = (err.body as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return null;
}

export function passwordResetFailureMessage(err: unknown, ctx: ResetFailureContext): string {
  const code = errorCode(err);
  if (code === "no_account" || (err instanceof ApiError && err.status === 404)) {
    return `There's no account for ${ctx.email} on ${ctx.serverHost}. Check the address — or the server, if your team runs its own — or sign up instead.`;
  }
  if (code === "send_failed") {
    return `The reset email couldn't be sent. ${serverMessage(err) ?? ""} Try again in a minute, or contact whoever runs this server.`.replace(/\s+/g, " ");
  }
  if (code === "too_many_requests") {
    return serverMessage(err) ?? "Too many reset requests for this address. Try again in an hour.";
  }
  if (code === "email_not_configured") {
    return "This server can't send email, so passwords can't be reset from here. Ask whoever runs it to set a new password for you.";
  }
  return err instanceof Error && err.message ? err.message : "Could not request a reset.";
}
