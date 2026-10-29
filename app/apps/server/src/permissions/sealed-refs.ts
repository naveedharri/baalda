// SPDX-License-Identifier: Apache-2.0
//
// The attachment reference rule for keyed vaults (W3). Today's rule: a scoped
// member may read an `attachments/` blob iff some note they can read has the
// blob's rel_path as a case-sensitive substring of its indexed body
// (`note_index.content`; the `ref_text` excerpt is an optimisation giving the
// same answer). A sealed row's body is decrypted in memory with the REQUEST's
// key and tested with `String.includes` — the identical predicate — so nobody
// gains or loses access. Plaintext rows keep the SQL path unchanged; sealed
// rows are excluded from it (their plaintext columns may be stale).
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocCrypto } from "../crypto/doc-crypto.js";
import { KeyRequiredError, loadVkCheck } from "../crypto/transport.js";
import { openSearchRow } from "../index/sealed-index.js";

type Queryable = Pick<pg.Pool, "query">;

/** Is this vault keyed? One primary-key lookup; unkeyed = today's SQL exactly. */
export async function vaultIsKeyed(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  return (await loadVkCheck(vaultId, db)) !== null;
}

/**
 * The paths (of `paths`) that some readable SEALED note body contains.
 * Throws {@link KeyRequiredError} when sealed readable rows exist and no key
 * was presented: refusing is the only answer that cannot change access.
 */
export async function sealedReferencedPaths(
  vaultId: string,
  readableIds: string[],
  paths: string[],
  crypto: DocCrypto | undefined,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const hit = new Set<string>();
  if (readableIds.length === 0 || paths.length === 0) return hit;
  const { rows } = await db.query<{ doc_id: string; search_enc: Buffer }>(
    `SELECT doc_id, search_enc FROM note_index
      WHERE vault_id = $1 AND doc_id = ANY($2::text[]) AND search_enc IS NOT NULL`,
    [vaultId, readableIds],
  );
  if (rows.length === 0) return hit;
  if (!crypto) throw new KeyRequiredError();
  for (const r of rows) {
    const body = openSearchRow(crypto, r.doc_id, r.search_enc).body;
    for (const p of paths) if (!hit.has(p) && body.includes(p)) hit.add(p);
    if (hit.size === paths.length) break;
  }
  return hit;
}
