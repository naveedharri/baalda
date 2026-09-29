// SPDX-License-Identifier: Apache-2.0
import { config } from "../config.js";

/**
 * How long a soft-deleted note stays in the vault's Trash (restorable, still
 * accepting CRDT pushes) before `purgeExpiredTrash` removes it for good.
 * THE one definition; override with the `TRASH_RETENTION_DAYS` env var.
 */
export const TRASH_RETENTION_DAYS: number = config.trashRetentionDays;

/**
 * SQL SET fragment every soft-delete path uses. `$userParam` is the positional
 * parameter holding the acting user id (or NULL). The day count is a validated
 * integer from config, so interpolating it is safe.
 */
export function softDeleteSet(userParam: string): string {
  return `deleted_at = now(), deleted_by = ${userParam}, purge_after = now() + make_interval(days => ${TRASH_RETENTION_DAYS})`;
}
