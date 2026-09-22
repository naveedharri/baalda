/**
 * Which notes reference which attachments (`blob_refs`, migration 027).
 *
 * The question "is this attachment still used?" had no cheap answer. The
 * authorization gate in `permissions/http-gates.ts` asks a related one —
 * "does a note I can read mention this path?" — with a `LIKE '%path%'` per
 * (path, readable note), which is acceptable for a yes/no on the request path
 * and is NOT something to delete files on the strength of: it matches a path
 * appearing in a code fence, in prose, or as a prefix of a longer name.
 *
 * So references are extracted once, when the note is indexed, from the same
 * markdown `note_index.content` is written from, and stored as rows. Two
 * consumers in this PR:
 *
 *   · `DELETE /api/blobs/:id` — 409 `blob_referenced` with the doc ids, unless
 *     the caller says `?force=1`;
 *   · the orphan sweep in `gc.ts` — a blob nothing references, older than the
 *     grace period, is collectable.
 *
 * NOT a consumer, deliberately: `canReadAttachment` / `filterReadableBlobs`.
 * Those are the AUTHORIZATION path, and moving them off the `LIKE` heuristic
 * changes who can read what — a separate change, gated by a parity test, not a
 * side effect of adding a table.
 *
 * Like `note_index`, this is a derived cache: rebuildable from note text at any
 * time ({@link rebuildBlobRefs}), and everything that deletes it is a purge, not
 * a loss.
 */
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { relAssetPath } from "../render/note-html.js";

type Queryable = Pick<pg.Pool, "query">;

/** Attachments live here and nowhere else (`isSafeAttachmentRelPath`,
 *  `ensure_attachment_rel`, and the blob routes' own `safeAttachmentRelPath`). */
const ATTACHMENT_DIR = "attachments";

/** `![alt](src)` — an image embed. Mirrors `render/note-html.ts`'s own rule. */
const IMAGE_RE = /!\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

/** `[text](src)` — a plain link. Every attachment that is not an image (a PDF,
 *  a docx, a zip) is embedded as one of these by the desktop, so a reference
 *  extractor that only read images would call every one of them an orphan. */
const LINK_RE = /\[[^\]\n]+\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

/**
 * The attachment paths a note's markdown references, lowercased and deduped.
 *
 * A target counts only when `relAssetPath` accepts it (no scheme, no `..`, no
 * backslash — the same filter the public-link renderer uses to decide what is a
 * vault path at all) AND it lands under `attachments/`. Anything else is an
 * external URL or a link to another note, neither of which owns a blob.
 *
 * Percent-encoded forms are recorded ALONGSIDE the decoded one rather than
 * instead of it. A blob's `rel_path` is whatever the uploader sent, a note's
 * link is whatever the editor wrote, and the two may disagree about `%20`.
 * Recording both makes the reference set a superset — which is the safe
 * direction for something whose only job is to stop a deletion.
 */
export function assetRefsFromMarkdown(markdown: string): string[] {
  const out = new Set<string>();
  const take = (raw: string) => {
    const rel = relAssetPath(raw);
    if (rel === null) return;
    const segments = rel.split("/");
    if (segments.length < 2 || segments[0].toLowerCase() !== ATTACHMENT_DIR) return;
    out.add(rel.toLowerCase());
    try {
      const decoded = decodeURIComponent(rel);
      if (decoded !== rel) out.add(decoded.toLowerCase());
    } catch {
      /* a stray `%` is not an encoding — keep the literal form only */
    }
  };

  // Images first; the link pattern would otherwise also match `![](…)`'s tail,
  // but both funnel into the same set, so an overlap costs nothing.
  for (const m of markdown.matchAll(IMAGE_RE)) take(m[1]);
  for (const m of markdown.matchAll(LINK_RE)) take(m[1]);
  return [...out];
}

/**
 * Replace one doc's references with the ones its current text holds.
 *
 * ONE statement, on purpose: the indexer calls this on every note write, and a
 * delete-then-insert pair would leave a window where the note appears to
 * reference nothing — which is exactly the state the orphan sweep reads as
 * "collectable".
 *
 * The DELETE and the INSERT are kept off each other's keys (`NOT IN
 * (incoming)`, `DO NOTHING`) rather than being a blind delete-all + re-insert.
 * Data-modifying CTEs all see the same snapshot, so an INSERT whose key a
 * sibling DELETE is removing in the same command hits the still-live index
 * entry and is silently dropped by `DO NOTHING`. Disjoint key sets make that
 * impossible.
 */
export async function replaceBlobRefs(
  docId: string,
  vaultId: string,
  markdown: string,
  db: Queryable = defaultPool,
): Promise<number> {
  const paths = assetRefsFromMarkdown(markdown);
  await db.query(
    `WITH incoming AS (
       SELECT DISTINCT unnest($3::text[]) AS rel_path
     ), del AS (
       DELETE FROM blob_refs
        WHERE doc_id = $1
          AND (vault_id <> $2 OR rel_path NOT IN (SELECT rel_path FROM incoming))
     )
     INSERT INTO blob_refs (vault_id, rel_path, doc_id)
     SELECT $2, i.rel_path, $1 FROM incoming i
     ON CONFLICT (vault_id, rel_path, doc_id) DO NOTHING`,
    [docId, vaultId, paths],
  );
  return paths.length;
}

/** Drop the references of docs that no longer exist. Paired with
 *  `purgeNoteIndex`, for the same reason: the row is derived from a note, so it
 *  dies with it. */
export async function purgeBlobRefs(
  docIds: string[],
  db: Queryable = defaultPool,
): Promise<void> {
  if (docIds.length === 0) return;
  await db.query("DELETE FROM blob_refs WHERE doc_id = ANY($1::text[])", [docIds]);
}

/** How many docs' texts are pulled per round trip during a rebuild. Note bodies
 *  cross the wire here, so the batch is small — this is an operator/GC path,
 *  never a request path. */
const REBUILD_BATCH = 100;

/**
 * Rebuild every reference in one vault from `note_index.content`.
 *
 * The GC's guard: a vault whose notes are indexed but whose `blob_refs` are
 * empty has not been through an indexer that knows about this table, and every
 * attachment in it would look like an orphan. Rather than skip such a vault
 * forever, the sweep builds the refs first and then re-asks.
 *
 * Reads `note_index` rather than re-decoding Yjs state: it is the same text
 * (`indexDoc` writes both from one string), and it costs one query instead of
 * loading and replaying every doc in the vault.
 */
export async function rebuildBlobRefs(
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<number> {
  let after = "";
  let docs = 0;
  for (;;) {
    const { rows } = await db.query<{ doc_id: string; content: string }>(
      `SELECT ni.doc_id, ni.content
         FROM note_index ni
         JOIN notes n ON n.id = ni.doc_id AND n.deleted_at IS NULL
        WHERE ni.vault_id = $1 AND ni.doc_id > $2
        ORDER BY ni.doc_id
        LIMIT $3`,
      [vaultId, after, REBUILD_BATCH],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await replaceBlobRefs(row.doc_id, vaultId, row.content ?? "", db);
      docs++;
    }
    after = rows[rows.length - 1].doc_id;
    if (rows.length < REBUILD_BATCH) break;
  }
  return docs;
}

/**
 * The docs that reference `relPath` in `vaultId`, for the DELETE endpoint's
 * 409 body. Case-insensitive on the caller's side too — the stored column is
 * already normalised, so the argument has to be.
 */
export async function docsReferencing(
  vaultId: string,
  relPath: string | null,
  db: Queryable = defaultPool,
): Promise<string[]> {
  if (!relPath) return [];
  const { rows } = await db.query<{ doc_id: string }>(
    "SELECT doc_id FROM blob_refs WHERE vault_id = $1 AND rel_path = $2 ORDER BY doc_id",
    [vaultId, relPath.toLowerCase()],
  );
  return rows.map((r) => r.doc_id);
}
