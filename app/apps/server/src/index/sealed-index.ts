// SPDX-License-Identifier: Apache-2.0
//
// Sealed search rows for keyed vaults (W3). One envelope per note_index row,
// AAD bound to (note_index, search_enc, vaultId, docId), holding everything
// search needs: the full text (so the pre-068 substring rule still works when
// a row has no token set), the embedding vector and the token set.
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "../crypto/config.js";
import { aadFor, open, seal } from "../crypto/envelope.js";
import { vaultKeyCache } from "../crypto/key-cache.js";
import type { DocCrypto } from "../crypto/doc-crypto.js";
import { loadVkCheck } from "../crypto/transport.js";

type Queryable = Pick<pg.Pool, "query">;

export interface SealedSearchRow {
  /** The note body, exactly what `note_index.content` holds for a plaintext row. */
  body: string;
  vector: number[];
  tokens: string | null;
}

function aad(vaultId: string, docId: string): Buffer {
  return aadFor("note_index", "search_enc", vaultId, docId);
}

export function sealSearchRow(c: DocCrypto, docId: string, row: SealedSearchRow): Buffer {
  return seal(c.key, aad(c.vaultId, docId), Buffer.from(JSON.stringify(row), "utf8"), c.generation);
}

export function openSearchRow(c: DocCrypto, docId: string, sealed: Buffer): SealedSearchRow {
  return JSON.parse(open(c.key, aad(c.vaultId, docId), sealed).toString("utf8")) as SealedSearchRow;
}

function blobAad(vaultId: string, blobId: string): Buffer {
  return aadFor("blob_text", "search_enc", vaultId, blobId);
}

/** A file's extracted text, sealed the same way (row key = blob id). */
export function sealBlobTextRow(c: DocCrypto, blobId: string, row: SealedSearchRow): Buffer {
  return seal(c.key, blobAad(c.vaultId, blobId), Buffer.from(JSON.stringify(row), "utf8"), c.generation);
}

export function openBlobTextRow(c: DocCrypto, blobId: string, sealed: Buffer): SealedSearchRow {
  return JSON.parse(open(c.key, blobAad(c.vaultId, blobId), sealed).toString("utf8")) as SealedSearchRow;
}

/**
 * Background indexing's view of a vault's key: `undefined` = unkeyed (today's
 * plaintext path), `null` = keyed but no member connected (defer: write
 * nothing), else a COPY from the process cache the caller must zero.
 */
export async function indexCryptoFor(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<DocCrypto | null | undefined> {
  if (!vaultKeysEnabled()) return undefined;
  if (!(await loadVkCheck(vaultId, db))) return undefined;
  const held = vaultKeyCache.get(vaultId);
  return held ? { vaultId, key: held.key, generation: held.generation } : null;
}
