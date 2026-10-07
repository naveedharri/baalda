import type pg from "pg";
import { resolveAccountPlan, type PlanLimits } from "./plan.js";

/**
 * Per-vault usage for an account (`GET /api/billing/account/usage`). Counts
 * only, never paths or names of notes. Storage is the sum of READY blob bytes
 * in the vault's collections, the settled half of what the upload quota
 * (`routes/blobs.ts storageUsage`) sums; pending uploads are excluded because
 * they may never complete.
 */

type Queryable = Pick<pg.Pool, "query">;

export interface OrgUsage {
  orgId: string;
  name: string;
  people: number;
  notes: number;
  storageBytes: number;
  files: number;
}

export interface AccountUsage {
  vaults: OrgUsage[];
  totals: { people: number; notes: number; storageBytes: number; files: number; vaults: number };
  limits: PlanLimits;
}

export async function accountUsage(db: Queryable, accountId: string): Promise<AccountUsage> {
  const { rows } = await db.query<{
    org_id: string;
    name: string;
    people: number;
    notes: number;
    storage: string;
    files: number;
  }>(
    `SELECT o.id AS org_id, o.name,
            (SELECT count(*)::int FROM member m WHERE m."organizationId" = o.id) AS people,
            (SELECT count(*)::int FROM notes n JOIN vaults v ON v.id = n.vault_id
              WHERE v.organization_id = o.id AND n.deleted_at IS NULL) AS notes,
            (SELECT coalesce(sum(b.size), 0)::bigint FROM blobs b JOIN vaults v ON v.id = b.vault_id
              WHERE v.organization_id = o.id AND b.status = 'ready') AS storage,
            (SELECT count(*)::int FROM files f JOIN vaults v ON v.id = f.vault_id
              WHERE v.organization_id = o.id) AS files
       FROM billing_account_orgs bao
       JOIN organization o ON o.id = bao.organization_id
      WHERE bao.billing_account_id = $1
      ORDER BY bao.attached_at, o.id`,
    [accountId],
  );
  const { rows: people } = await db.query<{ n: number }>(
    `SELECT count(DISTINCT m."userId")::int AS n
       FROM billing_account_orgs bao
       JOIN member m ON m."organizationId" = bao.organization_id
      WHERE bao.billing_account_id = $1`,
    [accountId],
  );
  const vaults = rows.map((r) => ({
    orgId: r.org_id,
    name: r.name,
    people: Number(r.people),
    notes: Number(r.notes),
    storageBytes: Number(r.storage),
    files: Number(r.files),
  }));
  const plan = await resolveAccountPlan(db, { accountId });
  return {
    vaults,
    totals: {
      // Distinct across vaults: one person in two vaults is one seat.
      people: people[0]?.n ?? 0,
      notes: vaults.reduce((s, v) => s + v.notes, 0),
      storageBytes: vaults.reduce((s, v) => s + v.storageBytes, 0),
      files: vaults.reduce((s, v) => s + v.files, 0),
      vaults: vaults.length,
    },
    limits: plan.limits,
  };
}
