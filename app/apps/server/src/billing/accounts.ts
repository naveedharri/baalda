import type pg from "pg";

/**
 * Billing accounts (migration 051): one per owner, every vault they own
 * attached through `billing_account_orgs`. Seats and free limits are counted
 * across the whole account, never per vault.
 *
 * Accounts are created lazily. Migration 051 backfilled everyone who owned a
 * vault then; a vault created later is attached by the `afterCreateOrganization`
 * hook, and anything that slipped past it is attached the first time billing
 * asks (`ensureAccountForOrg`).
 */

type Queryable = Pick<pg.Pool, "query">;

/**
 * The account owned by this user, created if missing. Returns null only when
 * the user row does not exist (the FK would refuse it).
 */
export async function ensureAccountForUser(
  db: Queryable,
  userId: string,
): Promise<string | null> {
  await db.query(
    `INSERT INTO billing_accounts (id, owner_user_id)
     SELECT 'ba_' || md5(u.id), u.id FROM "user" u WHERE u.id = $1
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM billing_accounts WHERE owner_user_id = $1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

/** The account a vault is attached to, or null. Read-only. */
export async function accountIdForOrg(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ billing_account_id: string }>(
    `SELECT billing_account_id FROM billing_account_orgs WHERE organization_id = $1`,
    [orgId],
  );
  return rows[0]?.billing_account_id ?? null;
}

/**
 * The account a vault belongs to, attaching it to its earliest owner's account
 * (created if needed) when it is not attached yet. Null when the vault is gone
 * or has no owner.
 */
export async function ensureAccountForOrg(db: Queryable, orgId: string): Promise<string | null> {
  const existing = await accountIdForOrg(db, orgId);
  if (existing) return existing;

  const { rows: owners } = await db.query<{ userId: string }>(
    `SELECT m."userId" FROM member m
       JOIN organization o ON o.id = m."organizationId"
      WHERE m."organizationId" = $1 AND m.role = 'owner'
      ORDER BY m."createdAt", m.id
      LIMIT 1`,
    [orgId],
  );
  const ownerId = owners[0]?.userId;
  if (!ownerId) return null;

  const accountId = await ensureAccountForUser(db, ownerId);
  if (!accountId) return null;

  await db.query(
    `INSERT INTO billing_account_orgs (organization_id, billing_account_id, attached_by)
     SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM organization WHERE id = $1)
     ON CONFLICT (organization_id) DO NOTHING`,
    [orgId, accountId, ownerId],
  );
  // A concurrent attach may have won; whatever is stored is the answer.
  return accountIdForOrg(db, orgId);
}

/** Every vault attached to an account. */
export async function orgIdsForAccount(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ organization_id: string }>(
    `SELECT organization_id FROM billing_account_orgs
      WHERE billing_account_id = $1
      ORDER BY attached_at, organization_id`,
    [accountId],
  );
  return rows.map((r) => r.organization_id);
}

/** Distinct people who are members of any vault on the account (owner included). */
export async function countAccountPeople(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(DISTINCT m."userId")::int AS n
       FROM billing_account_orgs bao
       JOIN member m ON m."organizationId" = bao.organization_id
      WHERE bao.billing_account_id = $1`,
    [accountId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Distinct invited addresses (lowercased) still pending and unexpired across
 * the account's vaults, excluding anyone already a member of one of them.
 */
export async function countPendingInvites(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(DISTINCT lower(i.email))::int AS n
       FROM billing_account_orgs bao
       JOIN invitation i ON i."organizationId" = bao.organization_id
      WHERE bao.billing_account_id = $1
        AND i.status = 'pending'
        AND i."expiresAt" > now()
        AND NOT EXISTS (
          SELECT 1
            FROM billing_account_orgs bao2
            JOIN member m ON m."organizationId" = bao2.organization_id
            JOIN "user" u ON u.id = m."userId"
           WHERE bao2.billing_account_id = $1
             AND lower(u.email) = lower(i.email)
        )`,
    [accountId],
  );
  return rows[0]?.n ?? 0;
}
