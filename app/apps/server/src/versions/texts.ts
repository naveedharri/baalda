import type { DocCrypto } from "../crypto/doc-crypto.js";
import { aadFor, ENVELOPE_OVERHEAD, open, seal } from "../crypto/envelope.js";
import { KeyRequiredError } from "../crypto/transport.js";
import { indexCryptoFor } from "../index/sealed-index.js";
import type pg from "pg";

/**
 * Content-addressed note text (#264, migration 038).
 *
 * Version history and vault checkpoints both used to store a full copy of the
 * note's text per row, so an unchanged note cost every daily checkpoint its
 * whole body again. Each distinct text of a note now lives ONCE in
 * `note_texts (doc_id, sha256)`; `note_versions` and `vault_checkpoint_docs`
 * rows store `content = NULL` and reference it by the `sha256` they already
 * carry. Rows written before 038 keep their inline `content`, which is why every
 * reader resolves `COALESCE(row.content, t.content)` — old checkpoints and
 * versions stay readable with no backfill.
 *
 * Cleanup is a grace-period sweep, not reference counting: a writer bumps
 * `last_ref_at` (the upsert below) BEFORE it inserts the row that points at the
 * text, and {@link gcNoteTexts} only drops rows that are both unreferenced and
 * older than {@link TEXT_GC_GRACE_MS}. A sweep can therefore never delete a text
 * a concurrent writer has just found and is about to reference.
 */

type Queryable = Pick<pg.Pool, "query">;

// ── W3: sealed texts for keyed vaults ────────────────────────────────────────
// A keyed vault's text goes into `content_enc` (sealed, AAD bound to vault +
// doc + sha) with `content = ''`. Readers select {@link VERSION_CONTENT_ENC}
// beside {@link VERSION_CONTENT} and call {@link resolveText}: a sealed row
// without a key is `key_required`, never an empty note.

function textAad(vaultId: string, docId: string, sha: string): Buffer {
  return aadFor("note_texts", "content", vaultId, `${docId}:${sha}`);
}

/** The sealed text of a `note_versions v` row (null for plaintext/inline rows). */
export const VERSION_CONTENT_ENC = "CASE WHEN v.content IS NULL THEN t.content_enc END";
/** Byte size of a `note_versions v` row's text, sealed or not, without the key. */
export const VERSION_SIZE = `CASE WHEN v.content IS NULL AND t.content_enc IS NOT NULL
  THEN octet_length(t.content_enc) - ${ENVELOPE_OVERHEAD} ELSE octet_length(COALESCE(v.content, t.content)) END`;

/**
 * A stored text as a string: the sealed copy opened with `crypto` (its AAD
 * binds vault, doc and sha, so a swapped row fails), else the plaintext.
 */
export function resolveText(
  row: { content: string | null; content_enc?: Buffer | null },
  ids: { vaultId: string; docId: string; sha: string },
  crypto: DocCrypto | undefined,
): string | null {
  if (row.content_enc) {
    if (!crypto) throw new KeyRequiredError();
    return open(crypto.key, textAad(ids.vaultId, ids.docId, ids.sha), row.content_enc).toString("utf8");
  }
  return row.content;
}

/** A text unreferenced for less than this is never swept. */
export const TEXT_GC_GRACE_MS = 60 * 60_000;
/** Re-bump `last_ref_at` at most this often, so an unchanged note does not
 *  rewrite its row on every checkpoint. Must stay well under the grace. */
const TOUCH_INTERVAL = "10 minutes";

/** Join a `note_versions v` row to its stored text. */
export const VERSION_TEXT_JOIN =
  "LEFT JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256";
/** The resolved text of a `note_versions v` row (inline pre-038, else shared). */
export const VERSION_CONTENT = "COALESCE(v.content, t.content)";

/**
 * Make sure `(docId, sha)` is stored, and mark it as just referenced. The
 * caller inserts its referencing row AFTER this returns.
 */
export async function storeNoteText(
  db: Queryable,
  input: { vaultId: string; docId: string; sha: string; content: string },
  crypto?: DocCrypto,
): Promise<void> {
  // W3: a REQUEST passes its own key. Background capture passes none and gets
  // a cache COPY; a keyed vault with no key held refuses (nothing written), so
  // the caller defers rather than storing plaintext or an empty text.
  let c = crypto;
  let copy: Buffer | null = null;
  if (!c) {
    const resolved = await indexCryptoFor(input.vaultId, db);
    if (resolved === null) throw new KeyRequiredError();
    if (resolved) {
      c = resolved;
      copy = resolved.key;
    }
  }
  if (c) {
    try {
      const sealed = seal(c.key, textAad(input.vaultId, input.docId, input.sha), Buffer.from(input.content, "utf8"), c.generation);
      // An existing row for this (doc, sha) holds the SAME text: keep it as is
      // (never overwritten, never nulled) and only bump the reference time.
      await db.query(
        `INSERT INTO note_texts (doc_id, sha256, vault_id, content, content_enc)
         VALUES ($1, $2, $3, '', $4)
         ON CONFLICT (doc_id, sha256) DO UPDATE SET last_ref_at = now()
           WHERE note_texts.last_ref_at < now() - interval '${TOUCH_INTERVAL}'`,
        [input.docId, input.sha, input.vaultId, sealed],
      );
    } finally {
      copy?.fill(0);
    }
    return;
  }
  await db.query(
    `INSERT INTO note_texts (doc_id, sha256, vault_id, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, sha256) DO UPDATE SET last_ref_at = now()
       WHERE note_texts.last_ref_at < now() - interval '${TOUCH_INTERVAL}'`,
    [input.docId, input.sha, input.vaultId, input.content],
  );
}

/**
 * Drop a vault's texts that no version and no checkpoint references any more
 * and that nobody has pointed at for {@link TEXT_GC_GRACE_MS}. Both reference
 * checks are index probes (`note_versions_doc_idx`, the checkpoint-docs primary
 * key through the vault's handful of checkpoints). Returns the rows removed.
 */
export async function gcNoteTexts(db: Queryable, vaultId: string): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM note_texts t
      WHERE t.vault_id = $1
        AND t.last_ref_at < now() - ($2::bigint * interval '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM note_versions v WHERE v.doc_id = t.doc_id AND v.sha256 = t.sha256
        )
        AND NOT EXISTS (
          SELECT 1 FROM vault_checkpoint_docs d
            JOIN vault_checkpoints c ON c.id = d.checkpoint_id
           WHERE c.vault_id = t.vault_id AND d.doc_id = t.doc_id AND d.sha256 = t.sha256
        )`,
    [vaultId, TEXT_GC_GRACE_MS],
  );
  return rowCount ?? 0;
}
