// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

/**
 * Client-held vault keys (W3): drop a departed member's sealed vault keys and
 * pending key requests for every note collection of the org. A no-op when the
 * feature was never used. The vault key itself is rotated by a remaining
 * member's device, never here.
 */
export async function forgetMemberKeys(orgId: string, userId: string, db: Queryable): Promise<void> {
  const vaults = `SELECT id FROM vaults WHERE organization_id = $1`;
  await db.query(`DELETE FROM vault_key_wraps WHERE user_id = $2 AND vault_id IN (${vaults})`, [orgId, userId]);
  await db.query(`DELETE FROM vault_key_requests WHERE user_id = $2 AND vault_id IN (${vaults})`, [orgId, userId]);
}
