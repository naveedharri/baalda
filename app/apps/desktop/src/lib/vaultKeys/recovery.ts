// "I lost every device": the pure half of the recovery UI (no React, no API
// client), so the state transitions are testable under vitest.
//
// A device of an existing account that no other device can approve has two
// ways on: an owner restores a vault with its 24 words, anyone starts a fresh
// account key (`session.startFreshAccountKey`) that teammates confirm by code.
// Neither touches local files or a vault key this device already holds.

import { rateLimitedMessage } from "../api";
import type { AccountKeysState } from "./session";

export const LOST_DEVICES_LABEL = "I don't have my other devices";
export const FRESH_KEY_EXPLAINER =
  "Create a new security key for this computer. Your teammates will be asked to confirm it with a code " +
  "before you get access again. Your notes on the server are not affected.";
export const RESTORE_INSTEAD_LABEL = "Or restore with your vault key";
export const FRESH_KEY_WAITING_PREFIX = "Waiting for a teammate to confirm your new security key — share this code:";

/** Offer the lost-devices path only while this computer is waiting for approval. */
export function offersLostDevices(account: AccountKeysState | null): boolean {
  return account?.state === "awaiting-device-approval";
}

/** "Or restore with your vault key": owners, with an open vault to restore. */
export function offersRestoreInstead(opts: { isOwner: boolean; vaultId: string | null | undefined }): boolean {
  return opts.isOwner && !!opts.vaultId;
}

export type LostDevicesStep =
  | { step: "closed" }
  /** The plain-words confirm. */
  | { step: "confirm" }
  /** The owner's 24-word restore instead. */
  | { step: "restore" }
  /** A new key exists: teammates confirm it with `code`. */
  | { step: "waiting"; code: string };

export type LostDevicesEvent =
  | { type: "open" }
  | { type: "restore" }
  | { type: "cancel" }
  | { type: "started"; code: string }
  /** Refused (rate limited, already holds a key) or failed: nothing changed. */
  | { type: "refused" };

export function lostDevicesStep(s: LostDevicesStep, e: LostDevicesEvent): LostDevicesStep {
  switch (e.type) {
    case "open":
      return s.step === "closed" ? { step: "confirm" } : s;
    case "restore":
      return s.step === "confirm" ? { step: "restore" } : s;
    case "started":
      return s.step === "confirm" ? { step: "waiting", code: e.code } : s;
    case "refused":
    case "cancel":
      return { step: "closed" };
  }
}

export type FreshKeyResult =
  | { kind: "started"; code: string }
  /** This device already holds an account key, or vault keys are off. */
  | { kind: "not-allowed" }
  /** The server's churn brake (429 rate_limited): its plain message. */
  | { kind: "rate-limited"; message: string };

/**
 * Run the session's `startFreshAccountKey` and read the new key's code. A 429
 * `rate_limited` becomes its message (nothing was stored either side); any
 * other error propagates.
 */
export async function runFreshAccountKey(session: {
  startFreshAccountKey(): Promise<boolean>;
  accountKeyCode(): Promise<string | null>;
}): Promise<FreshKeyResult> {
  let ok: boolean;
  try {
    ok = await session.startFreshAccountKey();
  } catch (e) {
    const message = rateLimitedMessage(e);
    if (message) return { kind: "rate-limited", message };
    throw e;
  }
  if (!ok) return { kind: "not-allowed" };
  const code = await session.accountKeyCode();
  return code ? { kind: "started", code } : { kind: "not-allowed" };
}

/** The waiting notice's line: the fresh-key wait (with its code) or the plain one. */
export function waitingNoticeCode(opts: { freshCode: string | null; vaultState: string | null }): string | null {
  // The new key waits on a teammate's re-seal: `waiting-for-teammate`. Any other
  // blocked state (mismatch, warning) is not this, so no code is offered.
  return opts.freshCode && opts.vaultState === "waiting-for-teammate" ? opts.freshCode : null;
}
