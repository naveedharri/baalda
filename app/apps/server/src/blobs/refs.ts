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

/**
 * A link destination as CommonMark reads it: `<…>` (the form a path with
 * spaces takes, title allowed after it), or a bare run holding at most one
 * level of balanced parentheses (`pic(1).png`). Group 1 or group 2.
 * Missing any of these left a picture a note shows unrecorded, and the purge
 * of ANOTHER note embedding it the plain way deleted it for everyone.
 */
const DEST = String.raw`\s*(?:<([^<>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+[^)]*)?\)`;

/** `![alt](src)` — an image embed. */
const IMAGE_RE = new RegExp(String.raw`!\[[^\]\n]*\]\(` + DEST, "g");

/** `[text](src)` — a plain link. Every attachment that is not an image (a PDF,
 *  a docx, a zip) is embedded as one of these by the desktop, so a reference
 *  extractor that only read images would call every one of them an orphan. */
const LINK_RE = new RegExp(String.raw`\[[^\]\n]+\]\(` + DEST, "g");

/** `[label]: src` — the definition a reference-style `![alt][label]` uses. */
const REFDEF_RE = /^[ ]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^<>\n]+)>|(\S+))/gm;

/** `![[target]]` / `[[target|alias]]` — the wiki form Obsidian vaults (and
 *  notes written by AI tools) use. Missing it left every such note referencing
 *  nothing, so its attachments read as unused. */
const WIKI_RE = /\[\[([^\]\n|#^]+)(?:[|#^][^\]\n]*)?\]\]/g;

/** `<img src="…">` and friends in inline HTML. */
const SRC_RE = /\b(?:src|href)\s*=\s*(?:"([^"\n>]+)"|'([^'\n>]+)')/gi;

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
    // `../attachments/x.png` from a note in a folder: attachments live at the
    // root, so leading parent steps are dropped (a superset, which is the safe
    // direction for a reference).
    const rel = relAssetPath(raw.trim().replace(/^(?:\.\.?\/)+/, ""));
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
  for (const m of markdown.matchAll(IMAGE_RE)) take(m[1] ?? m[2]);
  for (const m of markdown.matchAll(LINK_RE)) take(m[1] ?? m[2]);
  for (const m of markdown.matchAll(REFDEF_RE)) take(m[1] ?? m[2]);
  for (const m of markdown.matchAll(SRC_RE)) take(m[1] ?? m[2]);
  for (const m of markdown.matchAll(WIKI_RE)) {
    const target = m[1].trim();
    if (target.includes("/")) {
      take(target);
      continue;
    }
    // A bare name resolves by file name, and drops live in `attachments/`.
    // Only names with a file extension: `[[Some Note]]` links a note.
    if (/\.[a-z0-9]{1,8}$/i.test(target) && !/\.(md|markdown|mdx|txt|canvas)$/i.test(target)) {
      take(`${ATTACHMENT_DIR}/${target}`);
    }
  }
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
  opts: { announce?: boolean } = {},
): Promise<number> {
  const paths = assetRefsFromMarkdown(markdown);
  const { rows: moved } = await db.query<{ rel_path: string }>(
    `WITH incoming AS (
       SELECT DISTINCT unnest($3::text[]) AS rel_path
     ), del AS (
       DELETE FROM blob_refs
        WHERE doc_id = $1
          AND (vault_id <> $2 OR rel_path NOT IN (SELECT rel_path FROM incoming))
       RETURNING rel_path
     ), ins AS (
       INSERT INTO blob_refs (vault_id, rel_path, doc_id)
       SELECT $2, i.rel_path, $1 FROM incoming i
       ON CONFLICT (vault_id, rel_path, doc_id) DO NOTHING
       RETURNING rel_path
     )
     SELECT rel_path FROM ins UNION ALL SELECT rel_path FROM del`,
    [docId, vaultId, paths],
  );
  // Gained OR lost: either can change which drops a member sees through this
  // note (a lost one leaves their disk, #408), and neither says so otherwise.
  if (opts.announce && moved.length > 0) await announceGainedRefs(vaultId, moved.map((r) => r.rel_path), db);
  return paths.length;
}

// ── telling the vault a note now shows a picture that is already there ──

let refsNotifier: ((vaultId: string) => void) | null = null;
/** Who tells a vault's devices to list attachments again (`registry-changed`). */
export function setBlobRefsNotifier(fn: ((vaultId: string) => void) | null): void {
  refsNotifier = fn;
}

/** Frames for one vault within this window go out as one. */
const ANNOUNCE_COALESCE_MS = 1_500;
const announceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A note just started (or stopped) embedding an `attachments/` drop the server
 * already holds. A member who reads that note but not the whole vault may see the
 * drop only from now on, and nothing else says so: the upload's own frame went
 * out when its bytes landed, usually BEFORE the edit embedding it was indexed,
 * so their list then did not include it and their device never asked again
 * (an embed added to an existing shared note stayed missing for them). One
 * frame per vault per {@link ANNOUNCE_COALESCE_MS}; a failure only costs the
 * shortcut.
 */
async function announceGainedRefs(vaultId: string, added: string[], db: Queryable): Promise<void> {
  if (!refsNotifier || announceTimers.has(vaultId)) return;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM blobs
        WHERE vault_id = $1 AND status = 'ready' AND doc_id IS NULL AND lower(rel_path) = ANY($2::text[])
        LIMIT 1`,
      [vaultId, added],
    );
    if (rows.length === 0 || announceTimers.has(vaultId)) return;
    const t = setTimeout(() => {
      announceTimers.delete(vaultId);
      try {
        refsNotifier?.(vaultId);
      } catch (err) {
        console.warn(`[blob-refs] vault=${vaultId} broadcast failed:`, err);
      }
    }, ANNOUNCE_COALESCE_MS);
    if (typeof t.unref === "function") t.unref();
    announceTimers.set(vaultId, t);
  } catch (err) {
    console.warn(`[blob-refs] vault=${vaultId} checking new references failed:`, (err as Error).message);
  }
}

/** Test hook: send every pending frame now. */
export function flushBlobRefsAnnouncements(): void {
  for (const [vaultId, t] of announceTimers) {
    clearTimeout(t);
    announceTimers.delete(vaultId);
    refsNotifier?.(vaultId);
  }
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
