// Email preference and prefill, retained for existing email-only preferences.
//
// Device-local, like the theme and the other `prefs` values: a person signing
// in on their own machine should not retype the same address every time the
// app asks them to sign in again.
//
// Two keys, deliberately:
//   - the SWITCH, so a person who ticked it once keeps it ticked even before
//     they have ever completed a sign-in from this device;
//   - the ADDRESS, written only when a sign-in actually succeeded, so a typo
//     someone abandoned is never the thing we hand them back.
//
// This module stores only the address. Remembered passwords are handled by
// rememberedPassword.ts in the OS keychain, separately from session tokens.

/** The switch: "on" when the person asked us to remember, absent otherwise. */
export const REMEMBER_EMAIL_KEY = "context.rememberEmail";
/** The address itself, written at a successful sign-in. */
export const REMEMBERED_EMAIL_KEY = "context.rememberedEmail";

/** The slice of `Storage` this needs; `removeItem` because unticking clears. */
type EmailStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * `localStorage` when there is one. Some embedders throw on the property
 * access itself rather than on use, so the read is guarded too.
 */
function storage(): EmailStore | null {
  try {
    return (globalThis as { localStorage?: EmailStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Is the switch on? Off on a device that has never answered, and on failure. */
export function readRememberEmail(): boolean {
  try {
    return storage()?.getItem(REMEMBER_EMAIL_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * Record the switch. Turning it OFF forgets the address in the same breath —
 * unticking the box is the one gesture a person has for "stop keeping this",
 * and making them wait for a sign-in that never comes would keep it forever.
 */
export function writeRememberEmail(on: boolean): void {
  try {
    const store = storage();
    if (!store) return;
    if (on) {
      store.setItem(REMEMBER_EMAIL_KEY, "on");
    } else {
      store.removeItem(REMEMBER_EMAIL_KEY);
      store.removeItem(REMEMBERED_EMAIL_KEY);
    }
  } catch {
    /* storage unavailable — the switch stays in-memory for this session only */
  }
}

/**
 * The remembered address, or `""` when there is nothing usable to prefill.
 *
 * Gated on the switch as well as on the value: a stored address left behind by
 * a half-failed write must not resurrect a preference that is off.
 */
export function readRememberedEmail(): string {
  try {
    const store = storage();
    if (!store) return "";
    if (store.getItem(REMEMBER_EMAIL_KEY) !== "on") return "";
    return store.getItem(REMEMBERED_EMAIL_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Remember (or forget) the address that just signed in. A no-op while the
 * switch is off, so the caller can call it unconditionally on success; an
 * empty address clears rather than storing a blank.
 */
export function rememberEmailAddress(address: string): void {
  try {
    const store = storage();
    if (!store) return;
    if (store.getItem(REMEMBER_EMAIL_KEY) !== "on") return;
    const addr = address.trim();
    if (addr) store.setItem(REMEMBERED_EMAIL_KEY, addr);
    else store.removeItem(REMEMBERED_EMAIL_KEY);
  } catch {
    /* storage unavailable — nothing to remember, and nothing to report */
  }
}

/**
 * What the email field opens with.
 *
 * Order is an order of authority, not of convenience: an invitation is bound to
 * ONE address and outranks everything; then what this device remembered; then
 * the dev build's test account, which exists only so a fresh database is one
 * click away and must never overwrite a real remembered address.
 */
export function initialEmail(opts: {
  invitedEmail?: string | null;
  remembered?: string;
  devFallback?: string;
}): string {
  const invited = opts.invitedEmail?.trim();
  if (invited) return invited;
  const remembered = opts.remembered?.trim();
  if (remembered) return remembered;
  return opts.devFallback?.trim() ?? "";
}
