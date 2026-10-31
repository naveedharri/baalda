// SPDX-License-Identifier: Apache-2.0
//
// Sealing a keyed vault's Yjs log (W3). Sealed bytes live in their own columns
// (`doc_updates.update_enc`, `doc_snapshots.snapshot_enc`); a row is sealed iff
// its `*_enc` is non-null, never judged by sniffing the bytes.
//
// AAD row key = the doc id, not the `doc_updates.id`: that id is assigned by
// the database at insert, so it cannot be bound before the seal. Binding to the
// doc still stops moving a value to another doc, column, table or vault. What a
// database writer CAN do inside one doc (reorder, duplicate or drop updates,
// put an older snapshot back) is harmless or already possible: Yjs updates are
// idempotent and commutative, so reorder/duplicate change nothing, and deleting
// rows is a denial of service the database owner can always do. Content can
// neither be read nor forged without the key.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "./config.js";
import { aadFor, open, seal } from "./envelope.js";
import { KeyRequiredError, loadVkCheck } from "./transport.js";

type Queryable = Pick<pg.Pool, "query">;

export interface DocCrypto {
  /** The note collection (`vaults.id`) the doc belongs to. */
  vaultId: string;
  key: Buffer;
  generation: number;
}

export type SealedColumn = "doc_updates.update" | "doc_snapshots.snapshot";

function aad(column: SealedColumn, vaultId: string, docId: string): Buffer {
  const [table, col] = column.split(".") as [string, string];
  return aadFor(table, col, vaultId, docId);
}

export function sealDocBytes(c: DocCrypto, column: SealedColumn, docId: string, plain: Uint8Array): Buffer {
  return seal(c.key, aad(column, c.vaultId, docId), Buffer.from(plain), c.generation);
}

/** A row's bytes: `enc` opened with the key, else the plaintext column. */
export function openDocBytes(
  c: DocCrypto | undefined,
  column: SealedColumn,
  docId: string,
  enc: Buffer | null | undefined,
  plain: Buffer | null | undefined,
): Buffer | null {
  if (enc) {
    if (!c) throw new KeyRequiredError();
    return open(c.key, aad(column, c.vaultId, docId), enc);
  }
  return plain ?? null;
}

/** The note collection a doc (note or tree file) lives in. */
export async function vaultOfDoc(docId: string, db: Queryable = defaultPool): Promise<string | null> {
  const { rows } = await db.query<{ vault_id: string }>(
    `SELECT vault_id FROM notes WHERE id = $1
     UNION ALL SELECT vault_id FROM files WHERE id = $1 LIMIT 1`,
    [docId],
  );
  return rows[0]?.vault_id ?? null;
}

/**
 * Refuse to write plaintext into a keyed vault. Flag off, or a key supplied:
 * nothing to check (no query). Flag on with no key: one lookup; a keyed
 * vault throws {@link KeyRequiredError}.
 */
export async function assertWritableWithoutKey(
  docId: string,
  c: DocCrypto | undefined,
  db: Queryable = defaultPool,
): Promise<void> {
  if (c || !vaultKeysEnabled()) return;
  const vaultId = await vaultOfDoc(docId, db);
  if (vaultId && (await loadVkCheck(vaultId, db))) throw new KeyRequiredError();
}
