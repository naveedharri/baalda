import { s3KeyPrefix } from "./config.js";

/**
 * Object keys for the content-addressed blob store.
 *
 * Content-addressed and vault-scoped: the same bytes uploaded twice into one
 * vault are one object (which is also what `blobs_vault_sha_idx` enforces), and
 * two vaults that happen to hold identical bytes never share an object, so
 * deleting one vault can never pull a file out from under another.
 *
 * No extension in the key. The name a user sees lives in `blobs.filename` /
 * `blobs.rel_path`, and the type in `blobs.mime`; putting either in the key
 * would make a rename an object copy, and would let an uploader choose the
 * suffix a bucket serves.
 *
 * An optional `S3_KEY_PREFIX` puts everything under one more path segment
 * (`<prefix>/vaults/<vaultId>/<sha256>`), which is what lets a staging and a
 * production server share ONE bucket without either one's keys landing on the
 * other's. It only ever affects keys computed from NOW on: every row stores the
 * FULL key in `blobs.storage_key`, and reads, deletes, the GC deletion queue
 * and `scripts/migrate-blobs.ts` all work from that stored value — so objects
 * written under an earlier prefix (or none) keep resolving after the setting
 * changes. Changing the prefix is therefore additive, never a migration; what
 * it must not do is MOVE anything.
 */
export function objectKey(vaultId: string, sha256: string, prefix = s3KeyPrefix()): string {
  const base = `vaults/${vaultId}/${sha256}`;
  return prefix ? `${prefix}/${base}` : base;
}
