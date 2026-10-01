// SPDX-License-Identifier: Apache-2.0
import { sweepInvitationsOnce } from "./sweep.js";

/**
 * Every 15 minutes: two claim queries over the (small) pending-invitation set.
 * A reminder lands within a quarter hour of the 24-hour mark and an expiry
 * notice within a quarter hour of the expiry; neither needs to be sooner.
 */
export const INVITATION_SWEEP_TICK_MS = 15 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    const r = await sweepInvitationsOnce();
    if (r.reminded > 0 || r.reminderFailures > 0 || r.expired > 0) {
      console.log(
        `[invitations] sent ${r.reminded} reminder(s) (${r.reminderFailures} failed), recorded ${r.expired} expiry notice(s)`,
      );
    }
  } catch (err) {
    console.error("[invitations] sweep failed:", err);
  }
}

/** Started only from `index.ts` (never imported by tests' app factory). */
export function startInvitationSweep(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), INVITATION_SWEEP_TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopInvitationSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
