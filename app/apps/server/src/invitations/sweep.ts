// SPDX-License-Identifier: Apache-2.0
//
// Invitation reminders and expiry notices (#268).
//
// Two things happen to a pending invitation near the end of its life
// (`INVITATION_EXPIRES_HOURS`, default 7 days):
//
//  · about a day before it expires, the invitee gets ONE reminder email — only
//    when this server sends email at all (`getMailer()`), never otherwise;
//  · once it has expired unaccepted, the vault's Activity feed gets ONE notice
//    for the inviter and the owners/admins, with a Resend action
//    (`GET /vaults/:id/invitation-expiries`, `routes/invitations.ts`).
//
// Both are "at most once per invitation", recorded in `invitation_notices`
// (migration 045). The claim is written BEFORE the email goes out and is never
// cleared, so a crash after the send cannot send it twice, and a send that
// failed is not retried. The whole tick also runs under a TRY advisory lock, so
// a second instance whose timer fires meanwhile skips its turn instead of
// racing the same rows.
//
// Accepted, rejected and canceled invitations are never touched (only
// `status = 'pending'` rows qualify), and neither is one whose invitee is
// already a member of the vault by another route (a join code).
//
// Nothing here logs an address or a name: ids and counts only (#267).

import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { config } from "../config.js";
import { getMailer, type Mailer } from "../email/mailer.js";
import { invitationReminderEmail } from "../email/templates.js";
import { invitationState, loadInvitation } from "../registry/invitations.js";

/** The reminder goes out once the invitation has this long left… */
export const REMINDER_LEAD_HOURS = 24;
/**
 * …and only if it was sent at least this long ago. With a short configured
 * expiry (a day or less) a "reminder" minutes after the invitation itself is
 * noise, not help.
 */
export const REMINDER_MIN_AGE_HOURS = 24;
/**
 * Expiry notices cover invitations that expired within this window. It is the
 * slack for a server that was down for a while, and it is what keeps the first
 * sweep after deploying this from announcing every invitation that ever
 * expired: those are already in the members list with a Resend button.
 */
export const EXPIRY_NOTICE_LOOKBACK_HOURS = 72;
/** Rows claimed per kind per tick; the next tick takes the rest. */
export const SWEEP_BATCH = 500;

const LOCK_KEY = "invitation-sweep";

/** The invitee is already in the vault (a join code, an older acceptance). */
export const INVITEE_NOT_A_MEMBER = `
  NOT EXISTS (
    SELECT 1 FROM member m JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = i."organizationId" AND lower(u.email) = lower(i.email)
  )`;

/**
 * Nobody re-invited the same address in this vault since. A Resend creates a
 * fresh row, which answers an expiry notice whatever became of the new one.
 */
export const NO_LATER_INVITATION = `
  NOT EXISTS (
    SELECT 1 FROM invitation later
     WHERE later."organizationId" = i."organizationId"
       AND lower(later.email) = lower(i.email)
       AND later."createdAt" > i."createdAt"
  )`;

/** A provider's error text can echo the recipient; keep addresses out of logs. */
export function redactAddresses(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, "<address>");
}

type ActivityPublisher = (organizationId: string) => void;
let activityPublisher: ActivityPublisher | null = null;

/**
 * Wired once from index.ts: announce that an org's Activity listings moved
 * (the vault channel's `activity` frame). Null in tests: a no-op.
 */
export function setInvitationActivityPublisher(fn: ActivityPublisher | null): void {
  activityPublisher = fn;
}

/** Tell open Activity feeds in this org to refetch. Never throws. */
export function invitationActivityChanged(organizationId: string | null | undefined): void {
  if (!organizationId || !activityPublisher) return;
  try {
    activityPublisher(organizationId);
  } catch (err) {
    console.error("[invitations] activity publish failed:", err);
  }
}

export interface SweepResult {
  /** Reminder emails handed to the mailer this tick. */
  reminded: number;
  /** Reminders claimed whose send failed (claimed anyway: never retried). */
  reminderFailures: number;
  /** New expiry notices recorded this tick. */
  expired: number;
  /** False when another instance held the lock and this tick did nothing. */
  ran: boolean;
}

export interface SweepOptions {
  pool?: pg.Pool;
  /**
   * The mailer to remind with. Defaults to the process mailer, which is null
   * when email is off — and then no reminder row is even claimed, so turning
   * email on later still reminds invitations that are inside the window.
   */
  mailer?: Mailer | null;
  /** The clock, for tests. */
  now?: Date;
}

/**
 * One sweep. Exported for the tests and callable on demand. Claims inside one
 * transaction under the lock, then sends after COMMIT so a slow mail provider
 * never holds a connection or the lock.
 */
export async function sweepInvitationsOnce(opts: SweepOptions = {}): Promise<SweepResult> {
  const pool = opts.pool ?? defaultPool;
  const mailer = opts.mailer === undefined ? getMailer() : opts.mailer;
  const now = opts.now ?? new Date();

  let reminderIds: string[] = [];
  let expiredOrgs: string[] = [];
  let expiredCount = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok",
      [LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { reminded: 0, reminderFailures: 0, expired: 0, ran: false };
    }

    if (mailer) {
      const claimed = await client.query<{ invitation_id: string }>(
        `INSERT INTO invitation_notices (invitation_id, organization_id, reminder_sent_at)
         SELECT i.id, i."organizationId", $1::timestamptz
           FROM invitation i
          WHERE i.status = 'pending'
            AND i."expiresAt" > $1::timestamptz
            AND i."expiresAt" <= $1::timestamptz + make_interval(hours => $2::int)
            AND i."createdAt" <= $1::timestamptz - make_interval(hours => $3::int)
            AND NOT EXISTS (
              SELECT 1 FROM invitation_notices n
               WHERE n.invitation_id = i.id AND n.reminder_sent_at IS NOT NULL
            )
            AND ${INVITEE_NOT_A_MEMBER}
            AND ${NO_LATER_INVITATION}
          ORDER BY i."expiresAt"
          LIMIT $4
         ON CONFLICT (invitation_id) DO UPDATE
           SET reminder_sent_at = EXCLUDED.reminder_sent_at
           WHERE invitation_notices.reminder_sent_at IS NULL
         RETURNING invitation_id`,
        [now, REMINDER_LEAD_HOURS, REMINDER_MIN_AGE_HOURS, SWEEP_BATCH],
      );
      reminderIds = claimed.rows.map((r) => r.invitation_id);
    }

    // Independent of email: the notice lives in the app, not a mailbox.
    const noticed = await client.query<{ organization_id: string }>(
      `INSERT INTO invitation_notices (invitation_id, organization_id, expired_noticed_at)
       SELECT i.id, i."organizationId", $1::timestamptz
         FROM invitation i
        WHERE i.status = 'pending'
          AND i."expiresAt" <= $1::timestamptz
          AND i."expiresAt" > $1::timestamptz - make_interval(hours => $2::int)
          AND NOT EXISTS (
            SELECT 1 FROM invitation_notices n
             WHERE n.invitation_id = i.id AND n.expired_noticed_at IS NOT NULL
          )
          AND ${INVITEE_NOT_A_MEMBER}
          AND ${NO_LATER_INVITATION}
        ORDER BY i."expiresAt"
        LIMIT $3
       ON CONFLICT (invitation_id) DO UPDATE
         SET expired_noticed_at = EXCLUDED.expired_noticed_at
         WHERE invitation_notices.expired_noticed_at IS NULL
       RETURNING organization_id`,
      [now, EXPIRY_NOTICE_LOOKBACK_HOURS, SWEEP_BATCH],
    );
    expiredCount = noticed.rows.length;
    expiredOrgs = [...new Set(noticed.rows.map((r) => r.organization_id))];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let reminded = 0;
  let reminderFailures = 0;
  for (const id of reminderIds) {
    try {
      const inv = await loadInvitation(pool, id);
      // Accepted or canceled between the claim and now: nothing to remind.
      if (!inv || invitationState(inv) !== "pending" || !mailer) continue;
      await mailer.send(
        invitationReminderEmail({
          to: inv.email,
          url: `${config.betterAuthUrl}/invite/${encodeURIComponent(inv.id)}`,
          organizationName: inv.organizationName,
          inviterName: inv.inviterName,
          expiresAt: inv.expiresAt,
        }),
      );
      reminded++;
    } catch (err) {
      reminderFailures++;
      console.error(`[invitations] reminder for invitation ${id} failed: ${redactAddresses(err)}`);
    }
  }

  for (const orgId of expiredOrgs) invitationActivityChanged(orgId);
  return { reminded, reminderFailures, expired: expiredCount, ran: true };
}
