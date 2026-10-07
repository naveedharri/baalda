// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { resolveAccountPlan } from "./plan.js";
import { accountIdForOrg, orgIdsForAccount } from "./accounts.js";
import type { ResolverCache } from "../permissions/resolver.js";

/**
 * Account-wide read-only on billing lapse (pricing rev §3.4).
 *
 * The verdict itself is `resolveAccountPlan(...).lapsed`; this module only
 * (1) answers it for the permission layer and (2) tells every attached vault
 * when it flips, so open sockets reconnect read-only (or regain edit). Reads
 * are never touched, so a lapse causes no `ready.revoked` storm.
 */

type Queryable = Pick<pg.Pool, "query">;

/** Wired from `index.ts`: per collection (`vaults.id`), the same fan-out
 *  `PUT team-access` uses, plus closing that collection's live sockets so
 *  `onAuthenticate` re-admits them with the new `readOnly`. */
export type LapseNotifier = (vaultId: string) => void;
let notifier: LapseNotifier | null = null;
export function setLapseNotifier(fn: LapseNotifier | null): void {
  notifier = fn;
}

/** Last verdict seen per account (process memory; unknown ⇒ fire). */
const lastVerdict = new Map<string, boolean>();

export async function isAccountReadOnly(
  db: Queryable,
  orgId: string,
  cache?: ResolverCache,
): Promise<boolean> {
  if (cache) return cache.billingReadOnly(db, orgId);
  return (await resolveAccountPlan(db, { orgId })).lapsed;
}

async function fanOut(db: Queryable, accountId: string): Promise<void> {
  if (!notifier) return;
  const orgIds = await orgIdsForAccount(db, accountId);
  if (orgIds.length === 0) return;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM vaults WHERE organization_id = ANY($1::text[])`,
    [orgIds],
  );
  for (const r of rows) notifier(r.id);
}

/**
 * Re-judge one account and fan out when its lapsed verdict changed (or was
 * never seen by this process — a spurious `onAclChanged` only re-evaluates).
 * Returns the current verdict.
 */
export async function recheckAccount(
  accountId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const now = (await resolveAccountPlan(db, { accountId })).lapsed;
  const before = lastVerdict.get(accountId);
  lastVerdict.set(accountId, now);
  if (before !== now && (before !== undefined || now)) await fanOut(db, accountId);
  return now;
}

/** Test seam: forget remembered verdicts. */
export function resetLapseMemory(): void {
  lastVerdict.clear();
}

/**
 * Called by `store.applySubscriptionState` right after the row is written.
 * The writer may still be inside a transaction, so the re-judge runs on the
 * pool shortly after (by then the row is committed). Never throws.
 */
export function onSubscriptionStateChanged(
  _db: Queryable,
  target: { accountId?: string | null; orgId?: string | null },
  opts: { delayMs?: number; db?: Queryable } = {},
): Promise<void> {
  const db = opts.db ?? defaultPool;
  return new Promise((resolve) => {
    const run = async () => {
      try {
        const accountId =
          target.accountId ?? (target.orgId ? await accountIdForOrg(db, target.orgId) : null);
        if (accountId) await recheckAccount(accountId, db);
      } catch (err) {
        console.error("[billing] lapse recheck failed:", err);
      }
      resolve();
    };
    const t = setTimeout(() => void run(), opts.delayMs ?? 250);
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * For callers that REMOVE a member, cancel an invitation or DETACH a vault
 * from an account: trimming below the Free limits lifts a lapse. Call after
 * the change commits; never throws.
 */
export async function onMembershipTrimmed(
  db: Queryable,
  orgId: string,
  accountId?: string | null,
): Promise<void> {
  try {
    const id = accountId ?? (await accountIdForOrg(db, orgId));
    if (id) await recheckAccount(id, db);
  } catch (err) {
    console.error("[billing] lapse recheck failed:", err);
  }
}

/**
 * Time-based expiry has no webhook: a canceled sub lapses when its paid
 * period ends. Hourly, re-judge every account whose subscription period ended
 * in the last 2 hours (and every account already known lapsed).
 */
export async function lapseTick(db: Queryable = defaultPool): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT billing_account_id AS id FROM subscriptions
      WHERE billing_account_id IS NOT NULL
        AND status NOT IN ('active', 'past_due')
        AND current_period_end <= now()
        AND current_period_end > now() - interval '2 hours'`,
  );
  const ids = new Set(rows.map((r) => r.id));
  for (const [id, lapsed] of lastVerdict) if (lapsed) ids.add(id);
  let flipped = 0;
  for (const id of ids) {
    const before = lastVerdict.get(id);
    const now = await recheckAccount(id, db);
    if (before !== now) flipped++;
  }
  return flipped;
}

export const LAPSE_TICK_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Started only from `index.ts` (never imported by tests' app factory). */
export function startLapseScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void lapseTick().catch((err) => console.error("[billing] lapse tick failed:", err));
  }, LAPSE_TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopLapseScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
