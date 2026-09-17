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
 */
export function objectKey(vaultId: string, sha256: string): string {
  return `vaults/${vaultId}/${sha256}`;
}
