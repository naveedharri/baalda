// SPDX-License-Identifier: Apache-2.0

/**
 * SQL SET fragment every soft-delete path uses. `$userParam` is the positional
 * parameter holding the acting user id (or NULL).
 *
 * A deleted note is deleted (decided 2026-11-19): there is no Trash window, so
 * it is due for purge at once (`purgeDeletedSoon` right after the delete, the
 * hourly sweep as a backstop). The row itself stays as a content-free
 * tombstone so an offline device still hears "deleted".
 */
export function softDeleteSet(userParam: string): string {
  return `deleted_at = now(), deleted_by = ${userParam}, purge_after = now()`;
}
