// SPDX-License-Identifier: Apache-2.0
//
// Sealed search rows for keyed vaults (W3). One envelope per note_index row,
// AAD bound to (note_index, search_enc, vaultId, docId), holding everything
// search needs: the full text (so the pre-068 substring rule still works when
// a row has no token set), the embedding vector and the token set.
import { deflateRawSync, inflateRawSync } from "node:zlib";
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

/** What ranking needs, sealed apart from the body (`note_index.search_score_enc`).
 *  `tokens` null = a row whose score needs the body (the pre-068 substring
 *  rule): search opens the full row for that one. */
export interface SealedScoreRow {
  vector: number[];
  tokens: string | null;
}

/**
 * A score blob's plaintext. The JSON is deflated behind a leading 0x00 byte:
 * a token set plus a 256-number vector averaged 8 KB per note uncompressed, and
 * a 14k-note vault's search spent most of its time just receiving 108 MB of
 * them (2026-11-02). Older blobs are plain JSON (first byte `{`) and still open.
 */
const SCORE_DEFLATED = 0x00;
/** Far above any real row (token sets cap at 64 KB); the plaintext is ours and
 *  authenticated, this only bounds a bug. */
const SCORE_MAX_BYTES = 4 * 1024 * 1024;

function encodeScore(row: SealedScoreRow): Buffer {
  return Buffer.concat([Buffer.of(SCORE_DEFLATED), deflateRawSync(JSON.stringify(row))]);
}

function decodeScore(plain: Buffer): SealedScoreRow {
  const json = plain[0] === SCORE_DEFLATED
    ? inflateRawSync(plain.subarray(1), { maxOutputLength: SCORE_MAX_BYTES })
    : plain;
  return JSON.parse(json.toString("utf8")) as SealedScoreRow;
}

/** True when a score blob's plaintext is the older uncompressed JSON. */
export function isUncompressedScore(plain: Buffer): boolean {
  return plain[0] !== SCORE_DEFLATED;
}

function scoreAad(vaultId: string, docId: string): Buffer {
  return aadFor("note_index", "search_score_enc", vaultId, docId);
}

export function sealScoreRow(c: DocCrypto, docId: string, row: SealedScoreRow): Buffer {
  return seal(c.key, scoreAad(c.vaultId, docId), encodeScore(row), c.generation);
}

export function openScoreRow(c: DocCrypto, docId: string, sealed: Buffer): SealedScoreRow {
  return decodeScore(openScorePlain(c, docId, sealed));
}

/** A score blob's raw plaintext (either encoding). */
export function openScorePlain(c: DocCrypto, docId: string, sealed: Buffer): Buffer {
  return open(c.key, scoreAad(c.vaultId, docId), sealed);
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

function blobScoreAad(vaultId: string, blobId: string): Buffer {
  return aadFor("blob_text", "search_score_enc", vaultId, blobId);
}

/** A file's ranking data, sealed apart from its text (`blob_text.search_score_enc`). */
export function sealBlobScoreRow(c: DocCrypto, blobId: string, row: SealedScoreRow): Buffer {
  return seal(c.key, blobScoreAad(c.vaultId, blobId), encodeScore(row), c.generation);
}

export function openBlobScoreRow(c: DocCrypto, blobId: string, sealed: Buffer): SealedScoreRow {
  return decodeScore(openBlobScorePlain(c, blobId, sealed));
}

/** A file score blob's raw plaintext (either encoding). */
export function openBlobScorePlain(c: DocCrypto, blobId: string, sealed: Buffer): Buffer {
  return open(c.key, blobScoreAad(c.vaultId, blobId), sealed);
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
