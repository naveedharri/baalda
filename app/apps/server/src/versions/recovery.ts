import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { recordVersion, sha256Hex, stampLastEdited } from "./capture.js";

/**
 * Reviewed recovery of notes damaged by past sync bugs (issue #200).
 *
 * Two kinds of damage are still in place on the server copy, which every
 * client writes back to disk:
 *
 *  - **shrunk** — the stale-copy wipe (#93) emptied a note or left it a few
 *    stray fragments, so its current text is far shorter than it once was;
 *  - **repeated** — the cold-apply loop (fixed in 0.1.58) re-inserted the same
 *    edit on every open, leaving runs like `,,,,,,` or `::::::`.
 *
 * Nothing here restores automatically. {@link listRecoveryCandidates} proposes,
 * for each damaged note, the newest version from before the damage and whether
 * restoring it is safe (`restore`) or would drop text the note gained since
 * (`review`). {@link applyRecovery} then restores only the (note, version)
 * pairs the reviewer passes back, each through the same forward write as a
 * per-note Version History revert: a `pre-revert` version first, then the old
 * text as a normal transaction — so every restore is itself undoable and syncs
 * like any other edit.
 */

type Queryable = Pick<pg.Pool, "query">;

/** A note must once have had at least this much text for a shrink to count. */
export const RECOVERY_MIN_CHARS = 200;
/** Current text at or under this share of its peak version counts as shrunk. */
export const RECOVERY_SHRUNK_RATIO = 0.5;
/** A version within this share of the peak is "good" enough to propose. */
export const RECOVERY_GOOD_RATIO = 0.8;
/**
 * One punctuation character repeated six or more times in a row — the loop's
 * signature (`,,,,,,`, `::::::`). Characters markdown legitimately repeats
 * (table rules, dividers, fences, emphasis, leaders) are left out.
 */
const REPEAT_RUN = /([^\p{L}\p{N}\s\-=_*#`~.|+])\1{5,}/u;
/** Most items one apply call accepts. */
export const RECOVERY_APPLY_MAX = 500;

export interface VersionText {
  id: number;
  createdAt: string;
  content: string;
}

export type DamageKind = "shrunk" | "repeated";

export interface Assessment {
  kind: DamageKind;
  /** `restore` = the proposal contains everything the note holds now; `review` = it doesn't. */
  status: "restore" | "review";
  proposedVersionId: number;
  proposedAt: string;
  proposedChars: number;
  /** Lines in the current text that the proposed version does not contain. */
  novelLines: string[];
}

function size(text: string): number {
  return text.trim().length;
}

function lineSet(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/** Lines of `current` worth keeping that `proposed` lacks (stray markers skipped). */
function novelLines(current: string, proposed: string): string[] {
  const have = lineSet(proposed);
  const out: string[] = [];
  for (const line of lineSet(current)) {
    if (have.has(line)) continue;
    // A bare marker or two (`**:`, `#`, `/`) is the residue of the damage, not
    // content someone added.
    if (line.replace(/[^\p{L}\p{N}]/gu, "").length < 3) continue;
    out.push(line);
  }
  return out;
}

/**
 * Judge one note: is its current text damaged, and which version would restore
 * it? `versions` in any order. Pure, for tests.
 */
export function assessNote(current: string, versions: VersionText[]): Assessment | null {
  if (versions.length === 0) return null;
  const ordered = [...versions].sort((a, b) => a.id - b.id);
  const currentSha = sha256Hex(current);

  // ── shrunk ────────────────────────────────────────────────────────────────
  const peak = Math.max(...ordered.map((v) => size(v.content)));
  if (peak >= RECOVERY_MIN_CHARS && size(current) <= peak * RECOVERY_SHRUNK_RATIO) {
    const good = [...ordered].reverse().find((v) => size(v.content) >= peak * RECOVERY_GOOD_RATIO);
    if (good && sha256Hex(good.content) !== currentSha) {
      const novel = novelLines(current, good.content);
      return {
        kind: "shrunk",
        status: novel.length === 0 ? "restore" : "review",
        proposedVersionId: good.id,
        proposedAt: good.createdAt,
        proposedChars: size(good.content),
        novelLines: novel,
      };
    }
  }

  // ── repeated ──────────────────────────────────────────────────────────────
  // Only runs that appeared at some point — some earlier version lacks them. A
  // divider the note always had is not damage (and a later one is still only
  // proposed for review).
  const runs = new Set(current.match(new RegExp(REPEAT_RUN.source, "gu")) ?? []);
  const introduced = [...runs].filter((r) => ordered.some((v) => !v.content.includes(r)));
  if (introduced.length > 0) {
    const clean = [...ordered]
      .reverse()
      .find((v) => introduced.every((r) => !v.content.includes(r)) && size(v.content) > 0);
    if (clean && sha256Hex(clean.content) !== currentSha) {
      return {
        kind: "repeated",
        // The loop's output IS novel text, so this is always a judgement call.
        status: "review",
        proposedVersionId: clean.id,
        proposedAt: clean.createdAt,
        proposedChars: size(clean.content),
        novelLines: novelLines(current, clean.content),
      };
    }
  }
  return null;
}

export interface RecoveryCandidate extends Assessment {
  docId: string;
  path: string;
  currentChars: number;
}

/**
 * Every damaged note in a vault that `canEdit` allows, with its proposal.
 * Reads each candidate's live text through the doc writer, so an open note is
 * judged on what editors see, not on the stored log alone.
 */
export async function listRecoveryCandidates(
  vaultId: string,
  deps: {
    docWriter: Pick<DocWriter, "peekContent">;
    canEdit: (docId: string) => Promise<boolean>;
    db?: Queryable;
  },
): Promise<RecoveryCandidate[]> {
  const db = deps.db ?? defaultPool;
  const { rows: notes } = await db.query<{ id: string; rel_path: string }>(
    `SELECT n.id, n.rel_path FROM notes n
      WHERE n.vault_id = $1 AND n.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM note_versions v WHERE v.doc_id = n.id)
      ORDER BY n.rel_path`,
    [vaultId],
  );
  const out: RecoveryCandidate[] = [];
  for (const note of notes) {
    if (!(await deps.canEdit(note.id))) continue;
    const current = (await deps.docWriter.peekContent(vaultId, note.id)) ?? "";
    const { rows } = await db.query<{ id: string; created_at: Date; content: string }>(
      "SELECT id, created_at, content FROM note_versions WHERE doc_id = $1",
      [note.id],
    );
    const verdict = assessNote(
      current,
      rows.map((r) => ({ id: Number(r.id), createdAt: new Date(r.created_at).toISOString(), content: r.content })),
    );
    if (verdict) {
      out.push({ docId: note.id, path: note.rel_path, currentChars: size(current), ...verdict });
    }
  }
  return out;
}

export interface RecoveryItem {
  docId: string;
  versionId: number;
}

export type RecoveryResult =
  | { docId: string; ok: true; preRevertVersionId: number | null }
  | { docId: string; ok: false; error: "unknown_note" | "no_write_access" | "unknown_version" };

/**
 * Restore each reviewed (note, version) pair, forward-only. The caller has
 * already checked the vault role; `canEdit` is the per-note gate.
 */
export async function applyRecovery(
  vaultId: string,
  items: RecoveryItem[],
  userId: string,
  deps: {
    docWriter: Pick<DocWriter, "readContent" | "setContent">;
    canEdit: (docId: string) => Promise<boolean>;
    db?: Queryable;
  },
): Promise<RecoveryResult[]> {
  const db = deps.db ?? defaultPool;
  const results: RecoveryResult[] = [];
  for (const { docId, versionId } of items) {
    const { rows: note } = await db.query(
      "SELECT 1 FROM notes WHERE id = $1 AND vault_id = $2 AND deleted_at IS NULL",
      [docId, vaultId],
    );
    if (!note[0]) {
      results.push({ docId, ok: false, error: "unknown_note" });
      continue;
    }
    if (!(await deps.canEdit(docId))) {
      results.push({ docId, ok: false, error: "no_write_access" });
      continue;
    }
    const { rows } = await db.query<{ content: string }>(
      "SELECT content FROM note_versions WHERE id = $1 AND doc_id = $2",
      [versionId, docId],
    );
    if (!rows[0]) {
      results.push({ docId, ok: false, error: "unknown_version" });
      continue;
    }
    const target = rows[0].content;
    const current = await deps.docWriter.readContent(vaultId, docId);
    const preRevertVersionId = await recordVersion(
      { vaultId, docId, content: current, cause: "pre-revert", authorId: userId },
      db,
    );
    if (sha256Hex(current) !== sha256Hex(target)) {
      await deps.docWriter.setContent(vaultId, docId, target, { userId });
    }
    await stampLastEdited(docId, userId, db);
    results.push({ docId, ok: true, preRevertVersionId });
  }
  return results;
}
