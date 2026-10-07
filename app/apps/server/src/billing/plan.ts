import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import {
  config,
  billingEnabled,
  billingModel,
  abuseMaxNotes,
  abuseMaxStorageBytes,
} from "../config.js";
import { requiresCloudPlan } from "../deployment-policy.js";
import {
  orgHasActiveSubscription,
  legacyStorageLimitBytes,
  legacyCanSyncAttachments,
} from "./entitlements.js";

/**
 * ONE plan resolver (pricing rev: Free + Team, user-based seats).
 *
 * The billing unit is a `billing_accounts` row (migration 051): one per owner,
 * every vault they own attached through `billing_account_orgs`. People are
 * counted across the whole account (distinct `member.userId`, any role, owner
 * included); pending unexpired invitations for addresses not already on the
 * account RESERVE a seat.
 *
 * `BILLING_MODEL=vault` (the default until the flip) reproduces today's per-vault
 * semantics through the old entitlement helpers, so nothing changes until the
 * flag does. Every gate reads `limits` from here; nobody re-derives a limit.
 */

type Queryable = Pick<pg.Pool, "query">;

export type PlanName = "free" | "team";
export type PlanStatus = "none" | "active" | "past_due" | "canceled";

export interface PlanLimits {
  /** People on the account (Free) or purchased seats (Team); null = no cap. */
  people: number | null;
  /** Synced vaults attached to the account; null = no cap. */
  vaults: number | null;
  /** Attachment bytes per vault; null = no cap. */
  storageBytes: number | null;
  /** Live notes per vault; null = no cap. */
  notesPerVault: number | null;
  assistant: boolean;
  fileSync: boolean;
}

export interface AccountPlan {
  accountId: string | null;
  plan: PlanName;
  status: PlanStatus;
  seatsPurchased: number | null;
  seatsUsed: number;
  seatsReserved: number;
  vaultsAttached: number;
  /** Computed only (approved plan §3.4); enforcement is a later slice. */
  lapsed: boolean;
  limits: PlanLimits;
}

export type PlanTarget = { orgId: string } | { accountId: string } | { userId: string };

const ACTIVE = ["active", "past_due"];
const MIB = 1024 * 1024;
const FREE_PEOPLE_DEFAULT = 2;
const FREE_VAULTS_DEFAULT = 1;
/** Today's hardcoded Free note cap (vault mode only). */
const LEGACY_FREE_NOTE_LIMIT = 20_000;

/** Billing limits apply only on Cloud with billing configured; self-host = unlimited. */
export function planEnforced(): boolean {
  return requiresCloudPlan() && billingEnabled();
}

export function teamModel(): boolean {
  return billingModel() === "team";
}

const UNLIMITED: PlanLimits = {
  people: null,
  vaults: null,
  storageBytes: null,
  notesPerVault: null,
  assistant: true,
  fileSync: true,
};

function normalizeStatus(status: string | null | undefined): PlanStatus {
  return status === "active" || status === "past_due" || status === "canceled" ? status : "none";
}

/** The account a target resolves to (null = not attached / owns nothing). */
async function accountIdFor(db: Queryable, target: PlanTarget): Promise<string | null> {
  if ("accountId" in target) return target.accountId;
  if ("orgId" in target) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT billing_account_id AS id FROM billing_account_orgs WHERE organization_id = $1`,
      [target.orgId],
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM billing_accounts WHERE owner_user_id = $1`,
    [target.userId],
  );
  return rows[0]?.id ?? null;
}

interface AccountRow {
  free_people_limit: number | null;
  free_synced_vaults: number | null;
  plan_override: string | null;
  complimentary_until: Date | null;
  vaults: number;
  people: number;
  reserved: number;
  sub_status: string | null;
  sub_seats: number | null;
  sub_period_end: Date | null;
}

/**
 * Account row + attached vault count + distinct people + reserved seats + the
 * best subscription (active/past_due first, else the latest period end), in
 * ONE statement.
 */
async function loadAccount(db: Queryable, accountId: string): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    `WITH orgs AS (
       SELECT organization_id FROM billing_account_orgs WHERE billing_account_id = $1
     ), people AS (
       SELECT DISTINCT m."userId" AS user_id, lower(u.email) AS email
         FROM member m JOIN orgs o ON o.organization_id = m."organizationId"
         JOIN "user" u ON u.id = m."userId"
     )
     SELECT ba.free_people_limit, ba.free_synced_vaults, ba.plan_override, ba.complimentary_until,
            (SELECT count(*)::int FROM orgs) AS vaults,
            (SELECT count(*)::int FROM people) AS people,
            (SELECT count(DISTINCT lower(i.email))::int
               FROM invitation i JOIN orgs o ON o.organization_id = i."organizationId"
              WHERE i.status = 'pending' AND i."expiresAt" > now()
                AND lower(i.email) NOT IN (SELECT email FROM people)) AS reserved,
            s.status AS sub_status, s.seats AS sub_seats, s.current_period_end AS sub_period_end
       FROM billing_accounts ba
       LEFT JOIN LATERAL (
         SELECT status, seats, current_period_end FROM subscriptions
          WHERE billing_account_id = ba.id
          ORDER BY (status = ANY($2::text[])) DESC, current_period_end DESC NULLS LAST
          LIMIT 1
       ) s ON true
      WHERE ba.id = $1`,
    [accountId, ACTIVE],
  );
  return rows[0] ?? null;
}

/** Pure: turn an account row into the plan (exported for tests). */
export function planFromRow(
  accountId: string | null,
  row: AccountRow | null,
  enforced: boolean,
  now: Date = new Date(),
): AccountPlan {
  const seatsUsed = row?.people ?? 0;
  const seatsReserved = row?.reserved ?? 0;
  const vaultsAttached = row?.vaults ?? 0;
  const status = normalizeStatus(row?.sub_status);
  const periodLive = row?.sub_period_end ? new Date(row.sub_period_end) > now : false;
  // Polar keeps a scheduled cancel `active`; a `canceled` row still inside its
  // paid period keeps Team until that period ends.
  const subscribed = status === "active" || status === "past_due" || (status === "canceled" && periodLive);
  // Complimentary Team: an override without an end date is open-ended.
  const complimentary =
    row?.plan_override === "team" &&
    (row.complimentary_until === null || new Date(row.complimentary_until) > now);
  const plan: PlanName = subscribed || complimentary ? "team" : "free";
  const seatsPurchased = subscribed && row?.sub_seats != null ? Number(row.sub_seats) : null;
  const freePeople = row?.free_people_limit ?? FREE_PEOPLE_DEFAULT;
  const freeVaults = row?.free_synced_vaults ?? FREE_VAULTS_DEFAULT;

  const lapsed =
    enforced &&
    plan === "free" &&
    row?.sub_status != null &&
    (seatsUsed > freePeople || vaultsAttached > freeVaults);

  let limits: PlanLimits;
  if (!enforced) limits = UNLIMITED;
  else if (plan === "team") {
    limits = { ...UNLIMITED, people: seatsPurchased };
  } else {
    limits = {
      people: freePeople,
      vaults: freeVaults,
      storageBytes: abuseMaxStorageBytes(),
      notesPerVault: abuseMaxNotes(),
      assistant: false,
      fileSync: false,
    };
  }
  return { accountId, plan, status, seatsPurchased, seatsUsed, seatsReserved, vaultsAttached, lapsed, limits };
}

/** Vault mode: today's per-org semantics, delegated to the old helpers. */
async function legacyPlan(db: Queryable, target: PlanTarget): Promise<AccountPlan> {
  const enforced = billingEnabled();
  const orgId = "orgId" in target ? target.orgId : null;
  const active = orgId ? await orgHasActiveSubscription(orgId, db) : false;
  let seatsUsed = 0;
  let seatsReserved = 0;
  if (orgId) {
    const { rows } = await db.query<{ m: number; p: number }>(
      `SELECT (SELECT count(*)::int FROM member WHERE "organizationId" = $1) AS m,
              (SELECT count(*)::int FROM invitation WHERE "organizationId" = $1
                  AND status = 'pending' AND "expiresAt" > now()) AS p`,
      [orgId],
    );
    seatsUsed = rows[0]?.m ?? 0;
    seatsReserved = rows[0]?.p ?? 0;
  }
  const limits: PlanLimits = !enforced
    ? { ...UNLIMITED, notesPerVault: requiresCloudPlan() && !active ? LEGACY_FREE_NOTE_LIMIT : null }
    : {
        people: active ? null : config.freeMaxMembers,
        vaults: active ? null : config.freeMaxVaults,
        storageBytes: orgId ? await legacyStorageLimitBytes(orgId, db) : null,
        notesPerVault: requiresCloudPlan() && !active ? LEGACY_FREE_NOTE_LIMIT : null,
        assistant: !requiresCloudPlan() || active,
        fileSync: orgId ? await legacyCanSyncAttachments(orgId, db) : false,
      };
  return {
    accountId: null,
    plan: active ? "team" : "free",
    status: active ? "active" : "none",
    seatsPurchased: null,
    seatsUsed,
    seatsReserved,
    vaultsAttached: orgId ? 1 : 0,
    lapsed: false,
    limits,
  };
}

/**
 * Resolve the plan for a vault, an account or a user (the account they OWN).
 * One or two queries. Pass a {@link PlanMemo} (e.g. `ResolverCache.planFor`)
 * to share the answer across one request.
 */
export async function resolveAccountPlan(
  db: Queryable,
  target: PlanTarget,
): Promise<AccountPlan> {
  if (!teamModel()) return legacyPlan(db, target);
  const enforced = planEnforced();
  const accountId = await accountIdFor(db, target);
  if (!accountId) {
    // A vault no account claims yet (created between the hook and attach), or
    // a user who owns nothing: Free with only what that vault itself holds.
    let row: AccountRow | null = null;
    if ("orgId" in target) {
      const { rows } = await db.query<{ people: number; reserved: number }>(
        `SELECT (SELECT count(*)::int FROM member WHERE "organizationId" = $1) AS people,
                (SELECT count(DISTINCT lower(email))::int FROM invitation WHERE "organizationId" = $1
                    AND status = 'pending' AND "expiresAt" > now()) AS reserved`,
        [target.orgId],
      );
      row = {
        free_people_limit: null, free_synced_vaults: null, plan_override: null, complimentary_until: null,
        vaults: 1, people: rows[0]?.people ?? 0, reserved: rows[0]?.reserved ?? 0,
        sub_status: null, sub_seats: null, sub_period_end: null,
      };
    }
    return planFromRow(null, row, enforced);
  }
  return planFromRow(accountId, await loadAccount(db, accountId), enforced);
}

// ---------------------------------------------------------------------------
// Seat gates (team model). Callers branch on `teamModel()`; vault mode keeps
// the old per-org `canAddMember`.
// ---------------------------------------------------------------------------

export type SeatRefusal =
  | { code: "member_limit_reached"; limit: number; scope: "account" }
  | { code: "seat_limit_reached"; seats: number; used: number; pending: number; message: string };

export function seatLimitMessage(seats: number): string {
  return `All ${seats} seats are in use. The vault owner can add seats in Baalda (update the app if you don't see Billing).`;
}

/** Is this address (or user) already one of the account's people? */
async function alreadyOnAccount(
  db: Queryable,
  orgId: string,
  who: { email?: string; userId?: string },
): Promise<boolean> {
  if (!who.email && !who.userId) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM member m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" IN (
              SELECT organization_id FROM billing_account_orgs
               WHERE billing_account_id = (SELECT billing_account_id FROM billing_account_orgs WHERE organization_id = $1)
              UNION SELECT $1::text)
        AND (u.id = $2 OR lower(u.email) = lower($3))
      LIMIT 1`,
    [orgId, who.userId ?? null, who.email ?? null],
  );
  return rows.length > 0;
}

/** Is this address already holding a reserved seat on the account? */
async function alreadyReserved(db: Queryable, orgId: string, email: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM invitation
      WHERE status = 'pending' AND "expiresAt" > now() AND lower(email) = lower($2)
        AND "organizationId" IN (
              SELECT organization_id FROM billing_account_orgs
               WHERE billing_account_id = (SELECT billing_account_id FROM billing_account_orgs WHERE organization_id = $1)
              UNION SELECT $1::text)
      LIMIT 1`,
    [orgId, email],
  );
  return rows.length > 0;
}

function refusal(plan: AccountPlan, cap: number): SeatRefusal {
  if (plan.plan === "team") {
    return { code: "seat_limit_reached", seats: cap, used: plan.seatsUsed, pending: plan.seatsReserved, message: seatLimitMessage(cap) };
  }
  return { code: "member_limit_reached", limit: cap, scope: "account" };
}

/**
 * Invite CREATION (soft gate): members + reserved + this one must fit. An
 * address already on the account, or already reserved, takes no new seat.
 */
export async function checkInviteSeat(
  db: Queryable,
  orgId: string,
  email: string | null,
  plan?: AccountPlan,
): Promise<SeatRefusal | null> {
  const p = plan ?? (await resolveAccountPlan(db, { orgId }));
  const cap = p.limits.people;
  if (cap === null) return null;
  if (email && ((await alreadyOnAccount(db, orgId, { email })) || (await alreadyReserved(db, orgId, email)))) {
    return null;
  }
  return p.seatsUsed + p.seatsReserved + 1 > cap ? refusal(p, cap) : null;
}

/**
 * ACCEPTANCE / join-code redemption (hard gate): members + 1 must fit; a
 * person already on the account takes no seat. Reservations are ignored here
 * (the joiner's own invitation is one of them).
 */
export async function checkJoinSeat(
  db: Queryable,
  orgId: string,
  who: { userId?: string; email?: string },
  plan?: AccountPlan,
): Promise<SeatRefusal | null> {
  const p = plan ?? (await resolveAccountPlan(db, { orgId }));
  const cap = p.limits.people;
  if (cap === null) return null;
  if (await alreadyOnAccount(db, orgId, who)) return null;
  return p.seatsUsed + 1 > cap ? refusal(p, cap) : null;
}

/** JSON body for a seat refusal (402). */
export function seatRefusalBody(r: SeatRefusal): Record<string, unknown> {
  return r.code === "seat_limit_reached"
    ? { error: "seat_limit_reached", code: "seat_limit_reached", message: r.message, seats: r.seats, used: r.used, pending: r.pending }
    : { error: "member_limit_reached", code: "member_limit_reached", message: "member_limit_reached", limit: r.limit, scope: r.scope };
}
