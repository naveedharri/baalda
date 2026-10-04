import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { purgeNoteIndex } from "../index/indexer.js";
import type { DocWriter } from "../mcp/doc-writer.js";
import { sha256Hex, stampLastEdited } from "./capture.js";
import {
  captureCheckpoint,
  withVaultCheckpointLock,
  type CheckpointStructure,
} from "./checkpoints.js";
import { softDeleteSet } from "../trash/retention.js";

/**
 * Revert a whole vault to a checkpoint.
 *
 * Two rules shape everything here:
 *
 *  1. **Never move CRDT state backwards.** Restoring a note is not "replace the
 *     Y.Doc with the old one" (that resurrects deleted text and forks history);
 *     it is `docWriter.setContent(target)`, a FORWARD transaction that every
 *     connected editor merges like any other edit.
 *  2. **Convergent, not transactional-across-docs.** Structure lives in
 *     Postgres, content lives in the CRDT store, so the two cannot commit
 *     together. Instead every step is idempotent: re-running a revert converges
 *     on the same state, and the pre-revert checkpoint taken at the top is the
 *     undo for the whole operation.
 *
 * Attachments/blobs are deliberately untouched — out of scope for v1, and the
 * UI says so before the user confirms.
 */

/** The checkpoint disappeared (pruned/deleted) between the request and the lock. */
export class RevertError extends Error {}

/**
 * The revert would soft-delete more notes than a revert plausibly should, so it
 * did nothing at all.
 *
 * Every note not named by the checkpoint is treated as "created after it" and
 * soft-deleted — which for a checkpoint whose `structure.notes` came back EMPTY
 * (a capture that failed, a truncated row, a vault whose structure was never
 * recorded) means the whole vault. Same shape, and the same reasoning, as the
 * desktop's disk-delete cap: a plausible mass deletion and a corrupt input look
 * identical from here, so the large one is refused and REPORTED rather than
 * guessed at. The pre-revert checkpoint is not an excuse — it only exists if the
 * revert got far enough to take it.
 */
export class RevertTooDestructiveError extends RevertError {
  constructor(
    readonly wouldDelete: number,
    readonly cap: number,
  ) {
    super(
      `Refusing to revert: it would delete ${wouldDelete} note(s), over the ${cap} this vault allows in one revert. ` +
        `Restore a different checkpoint, or delete the extra notes yourself first.`,
    );
  }
}

/** Notes one revert may soft-delete. Mirrors the desktop's `max(5, ceil(mapped * 0.2))`. */
export function revertDeleteCap(liveNotes: number): number {
  return Math.max(5, Math.ceil(liveNotes * 0.2));
}

export interface VaultRevertOutcome {
  docsChanged: number;
  docsRestored: number;
  docsDeleted: number;
  foldersCreated: number;
  /** Docs whose snapshot was empty while the live note has text — left alone. */
  docsKeptOverEmpty: number;
  /** Tree files whose `files` row came back under its original id. */
  filesRestored: number;
  /** Files and attachments whose bytes were pointed back at the pinned version. */
  fileBytesRestored: number;
  preRevertCheckpointId: string;
}

export interface VaultRevertDeps {
  docWriter: Pick<DocWriter, "peekContent" | "setContent">;
  onRegistryChanged?: (vaultId: string, originId: string | null) => void;
  pool?: pg.Pool;
}

/** Root-first, so a parent folder exists before its children are re-created. */
function byDepth(a: { path: string }, b: { path: string }): number {
  const depth = (p: string) => p.split("/").length;
  return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
}

export async function revertVaultToCheckpoint(
  opts: {
    vaultId: string;
    checkpointId: string;
    userId: string;
  } & VaultRevertDeps,
): Promise<{ acquired: false } | { acquired: true; result: VaultRevertOutcome }> {
  const pool = opts.pool ?? defaultPool;
  const { vaultId, checkpointId, userId, docWriter } = opts;

  // Content writes commit through the GLOBAL pool (`docWriter.setContent`), not
  // through this transaction, so running them inline mixed two things that
  // cannot roll back together: a later failure — notably the 23505 the note
  // re-insert can still raise — rolled the STRUCTURE back while leaving every
  // already-rewritten note body reverted, with no record of which. They are
  // collected here and run after COMMIT, where a failure costs exactly itself.
  const pendingWrites: Array<{ docId: string; content: string }> = [];

  const outcome = await withVaultCheckpointLock(
    vaultId,
    async (db): Promise<Omit<VaultRevertOutcome, "docsChanged">> => {
      const { rows: cpRows } = await db.query<{ structure: CheckpointStructure }>(
        "SELECT structure FROM vault_checkpoints WHERE id = $1 AND vault_id = $2",
        [checkpointId, vaultId],
      );
      if (!cpRows[0]) throw new RevertError("Unknown checkpoint");
      const structure: CheckpointStructure = {
        notes: cpRows[0].structure?.notes ?? [],
        folders: cpRows[0].structure?.folders ?? [],
      };

      // Bodies are inline on checkpoints taken before migration 038 and
      // content-addressed in `note_texts` after it (#264). A row whose text
      // cannot be resolved is left out, i.e. treated like a structure-only
      // note: the revert leaves that note's current content alone.
      const { rows: docRows } = await db.query<{
        doc_id: string;
        sha256: string;
        content: string;
      }>(
        `SELECT d.doc_id, d.sha256, COALESCE(d.content, t.content) AS content
           FROM vault_checkpoint_docs d
           LEFT JOIN note_texts t ON t.doc_id = d.doc_id AND t.sha256 = d.sha256
          WHERE d.checkpoint_id = $1 AND COALESCE(d.content, t.content) IS NOT NULL`,
        [checkpointId],
      );
      const contentByDoc = new Map(docRows.map((r) => [r.doc_id, r]));

      // The undo for this whole operation, taken BEFORE anything moves. Excluded
      // from its own prune along with the checkpoint we are restoring.
      const preRevert = await captureCheckpoint({
        db,
        docWriter,
        vaultId,
        kind: "auto",
        label: "Before revert",
        createdBy: userId,
        excludeFromPrune: [checkpointId],
        gcTexts: false,
      });

      // ── folders ────────────────────────────────────────────────────────────
      // Ids are preserved where possible; a folder that was deleted comes back
      // with its ORIGINAL id so the notes' folder_id references still resolve.
      // When the id is gone but a folder already sits at that path, the two are
      // the same folder for our purposes and we map old id → existing id.
      const folderIdMap = new Map<string, string>();
      let foldersCreated = 0;
      for (const folder of [...structure.folders].sort(byDepth)) {
        const parentId = folder.parent_id
          ? (folderIdMap.get(folder.parent_id) ?? folder.parent_id)
          : null;

        const { rows: byId } = await db.query<{ id: string }>(
          "SELECT id FROM folders WHERE id = $1 AND vault_id = $2",
          [folder.id, vaultId],
        );
        if (byId[0]) {
          await db.query(
            "UPDATE folders SET parent_id = $2, name = $3, path = $4, sort = $5 WHERE id = $1",
            [folder.id, parentId, folder.name, folder.path, folder.sort],
          );
          continue;
        }

        const { rows: byPath } = await db.query<{ id: string }>(
          "SELECT id FROM folders WHERE vault_id = $1 AND path = $2 LIMIT 1",
          [vaultId, folder.path],
        );
        if (byPath[0]) {
          folderIdMap.set(folder.id, byPath[0].id);
          await db.query("UPDATE folders SET parent_id = $2, name = $3, sort = $4 WHERE id = $1", [
            byPath[0].id,
            parentId,
            folder.name,
            folder.sort,
          ]);
          continue;
        }

        await db.query(
          `INSERT INTO folders (id, vault_id, parent_id, name, path, sort)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [folder.id, vaultId, parentId, folder.name, folder.path, folder.sort],
        );
        foldersCreated++;
      }

      // ── notes ──────────────────────────────────────────────────────────────
      let docsRestored = 0;
      let docsKeptOverEmpty = 0;
      for (const note of structure.notes) {
        const folderId = note.folder_id
          ? (folderIdMap.get(note.folder_id) ?? note.folder_id)
          : null;

        const { rows: existing } = await db.query<{
          rel_path: string;
          title: string | null;
          folder_id: string | null;
          deleted_at: Date | null;
        }>(
          "SELECT rel_path, title, folder_id, deleted_at FROM notes WHERE id = $1 AND vault_id = $2",
          [note.id, vaultId],
        );
        const row = existing[0];
        if (!row) {
          // Hard-gone (or never existed on this server): re-create with the
          // original doc_id so its CRDT history and backlinks reattach.
          //
          // `ON CONFLICT (id)` covers the id, and NOT the two live-path unique
          // indexes (`notes_live_path_uq` m021, `notes_live_path_ci_uq` m023),
          // which raise a bare 23505 when a DIFFERENT doc already occupies this
          // note's old path. Skipping that one note is right: the path is taken
          // by something the user has since made, and the alternative — letting
          // the error out — used to abort a revert that had already rewritten
          // other notes' bodies.
          // Under a SAVEPOINT, because this runs inside ONE transaction
          // (`withVaultCheckpointLock`): a failed statement poisons it, and
          // every later query would fail with "current transaction is aborted"
          // — turning a single skippable note into a failed revert.
          await db.query("SAVEPOINT revert_note");
          try {
            await db.query(
              `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id)
               VALUES ($1, $2, $3, $4, $5, $1)
               ON CONFLICT (id) DO NOTHING`,
              [note.id, vaultId, folderId, note.title, note.rel_path],
            );
            await db.query("RELEASE SAVEPOINT revert_note");
            docsRestored++;
          } catch (err) {
            await db.query("ROLLBACK TO SAVEPOINT revert_note");
            await db.query("RELEASE SAVEPOINT revert_note");
            if ((err as { code?: string })?.code !== "23505") throw err;
            console.warn(
              `[revert] skipping ${note.id}: another live note already occupies its path`,
            );
            continue;
          }
        } else {
          const moved =
            row.rel_path !== note.rel_path ||
            row.title !== note.title ||
            row.folder_id !== folderId;
          if (row.deleted_at) docsRestored++;
          if (moved || row.deleted_at) {
            // The first `deleted_at = NULL` in the codebase: a soft-deleted note
            // comes back rather than being re-created, keeping its doc_id, its
            // Yjs history and every share row pointing at it.
            await db.query(
              `UPDATE notes
                  SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, rel_path = $2, title = $3, folder_id = $4,
                      updated_at = now()
                WHERE id = $1`,
              [note.id, note.rel_path, note.title, folderId],
            );
          }
        }

        const snapshot = contentByDoc.get(note.id);
        if (!snapshot) continue; // structure-only (doc skipped at capture time)
        const current = (await docWriter.peekContent(vaultId, note.id)) ?? "";
        if (sha256Hex(current) === snapshot.sha256) continue;
        // The data-loss firewall (same philosophy as the bridge's everHadContent
        // guard): a revert may rewrite text, but it must never bulldoze a note
        // that HAS text with emptiness. An empty snapshot row against a
        // non-empty live doc is far more likely a capture that ran before the
        // note's content reached the server than a note someone truly blanked —
        // and the cost of being wrong here is the user's words, unrecoverably.
        if (snapshot.content.length === 0 && current.length > 0) {
          console.warn(
            `[revert] keeping ${note.id}: checkpoint says empty, live doc has content`,
          );
          docsKeptOverEmpty++;
          continue;
        }
        pendingWrites.push({ docId: note.id, content: snapshot.content });
      }

      // ── files and attachments the checkpoint pinned (migration 047) ────────
      const files = await restorePinnedBlobs(db, vaultId, checkpointId, folderIdMap);

      // ── notes created after the checkpoint ─────────────────────────────────
      // Soft-deleted, exactly as a user delete would: the row and the CRDT doc
      // survive, so a later revert to a newer checkpoint brings them back.
      const keepIds = structure.notes.map((n) => n.id);
      // COUNT FIRST, refuse over the cap. An empty or truncated
      // `structure.notes` makes every live note in the vault a candidate, and
      // "delete everything" is indistinguishable here from a legitimate revert
      // of a vault that has since been filled — so the big one is refused.
      // Throwing rolls the whole transaction back, which is the point.
      const { rows: counts } = await db.query<{ live: number; doomed: number }>(
        `SELECT (SELECT count(*) FROM notes WHERE vault_id = $1 AND deleted_at IS NULL)::int AS live,
                (SELECT count(*) FROM notes
                  WHERE vault_id = $1 AND deleted_at IS NULL
                    AND NOT (id = ANY($2::text[])))::int AS doomed`,
        [vaultId, keepIds],
      );
      const doomed = counts[0]?.doomed ?? 0;
      const cap = revertDeleteCap(counts[0]?.live ?? 0);
      if (doomed > cap) {
        console.error(
          `[revert] refusing checkpoint ${checkpointId} for vault ${vaultId}: ${doomed} note(s) would be deleted (cap ${cap}, checkpoint names ${keepIds.length})`,
        );
        throw new RevertTooDestructiveError(doomed, cap);
      }
      const { rows: removed } = await db.query<{ id: string }>(
        `UPDATE notes SET ${softDeleteSet("$3")}
          WHERE vault_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::text[]))
        RETURNING id`,
        [vaultId, keepIds, userId],
      );
      if (removed.length > 0) {
        await purgeNoteIndex(
          removed.map((r) => r.id),
          db,
        );
      }

      return {
        docsRestored,
        docsDeleted: removed.length,
        foldersCreated,
        filesRestored: files.restored,
        fileBytesRestored: files.bytesRestored,
        docsKeptOverEmpty,
        preRevertCheckpointId: preRevert.id,
      };
    },
    pool,
  );

  if (!outcome.acquired) return outcome;

  // AFTER COMMIT. Each write is independent and idempotent (`setContent` is a
  // forward CRDT transaction), so one that fails costs one note and is fixed by
  // re-running the revert — rather than taking the committed structure with it.
  let docsChanged = 0;
  for (const write of pendingWrites) {
    try {
      await docWriter.setContent(vaultId, write.docId, write.content, { userId });
      await stampLastEdited(write.docId, userId, pool);
      docsChanged++;
    } catch (err) {
      console.error(`[revert] could not restore the body of ${write.docId}:`, err);
    }
  }

  // After COMMIT, so a client that re-pulls on the broadcast sees the new tree.
  opts.onRegistryChanged?.(vaultId, null);
  return { acquired: true, result: { ...outcome.value, docsChanged } };
}

interface PinRow {
  rel_path: string;
  file_id: string | null;
  folder_id: string | null;
  sha256: string;
  size: string | null;
  mime: string | null;
  storage_provider: string;
  storage_key: string | null;
}

/**
 * Bring back the binaries checkpoint `checkpointId` pinned, inside the revert's
 * transaction. Per pinned tree file:
 *   - live row whose ready blob has the pinned sha: nothing to do;
 *   - live row on different bytes: a ready blob row on the pinned bytes under
 *     the SAME files id, and the newer one retired (it is pinned by the
 *     revert's own undo checkpoint, so its bytes survive);
 *   - row gone: re-registered under the SAME id (a desktop that still holds it
 *     keeps its identity), its `file_tombstones` entry cleared — otherwise
 *     every desktop would move the restored file straight back to its trash —
 *     and its blob row recreated on the pinned bytes.
 * An `attachments/` pin only needs a ready row for its (vault, sha).
 *
 * Bytes come from the pin itself: on S3 the object the pin kept alive, on the
 * Postgres store any live row with the same content or the retired copy in
 * `checkpoint_blob_bytes`. A file whose bytes cannot be found, or whose path a
 * different file now occupies, is skipped and logged, never an error.
 */
async function restorePinnedBlobs(
  db: pg.PoolClient,
  vaultId: string,
  checkpointId: string,
  folderIdMap: Map<string, string>,
): Promise<{ restored: number; bytesRestored: number }> {
  const { rows: pins } = await db.query<PinRow>(
    `SELECT rel_path, file_id, folder_id, sha256, size, mime, storage_provider, storage_key
       FROM vault_checkpoint_blobs WHERE checkpoint_id = $1 ORDER BY rel_path`,
    [checkpointId],
  );
  if (pins.length === 0) return { restored: 0, bytesRestored: 0 };
  const { rows: vaultRows } = await db.query<{ organization_id: string }>(
    "SELECT organization_id FROM vaults WHERE id = $1",
    [vaultId],
  );
  const orgId = vaultRows[0]?.organization_id ?? null;

  let restored = 0;
  let bytesRestored = 0;
  for (const pin of pins) {
    if (pin.file_id) {
      const { rows: live } = await db.query<{ id: string }>(
        "SELECT id FROM files WHERE id = $1 AND vault_id = $2",
        [pin.file_id, vaultId],
      );
      if (!live[0]) {
        const folderId = pin.folder_id ? (folderIdMap.get(pin.folder_id) ?? pin.folder_id) : null;
        await db.query("SAVEPOINT revert_file");
        try {
          await db.query(
            `INSERT INTO files (id, vault_id, folder_id, path)
             VALUES ($1, $2, (SELECT id FROM folders WHERE id = $3 AND vault_id = $2), $4)
             ON CONFLICT (id) DO NOTHING`,
            [pin.file_id, vaultId, folderId, pin.rel_path],
          );
          await db.query("RELEASE SAVEPOINT revert_file");
        } catch (err) {
          await db.query("ROLLBACK TO SAVEPOINT revert_file");
          await db.query("RELEASE SAVEPOINT revert_file");
          if ((err as { code?: string })?.code !== "23505") throw err;
          console.warn(
            `[revert] skipping file ${pin.file_id}: another file already occupies its path`,
          );
          continue;
        }
        await db.query("DELETE FROM file_tombstones WHERE id = $1", [pin.file_id]);
        restored++;
      }
      const { rows: current } = await db.query<{ sha256: string }>(
        `SELECT sha256 FROM blobs
          WHERE vault_id = $1 AND doc_id = $2 AND status = 'ready'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [vaultId, pin.file_id],
      );
      if (current[0]?.sha256 === pin.sha256) continue;
      if (await insertPinnedBlob(db, vaultId, orgId, pin, pin.file_id)) {
        // One ready row per file, as a committed upload leaves it.
        await db.query(
          `DELETE FROM blobs
            WHERE vault_id = $1 AND doc_id = $2 AND status = 'ready' AND sha256 <> $3`,
          [vaultId, pin.file_id, pin.sha256],
        );
        bytesRestored++;
      }
    } else {
      const { rows: live } = await db.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM blobs
            WHERE vault_id = $1 AND sha256 = $2 AND doc_id IS NULL AND status = 'ready'
         ) AS ok`,
        [vaultId, pin.sha256],
      );
      if (live[0]?.ok) continue;
      if (await insertPinnedBlob(db, vaultId, orgId, pin, null)) bytesRestored++;
    }
  }
  return { restored, bytesRestored };
}

/** A ready `blobs` row on a pin's bytes. False when the bytes are gone. */
async function insertPinnedBlob(
  db: pg.PoolClient,
  vaultId: string,
  orgId: string | null,
  pin: PinRow,
  docId: string | null,
): Promise<boolean> {
  const filename = pin.rel_path.split("/").pop() ?? pin.rel_path;
  const provider = (pin.storage_provider ?? "postgres").toLowerCase();
  let data: Buffer | null = null;
  if (provider === "postgres") {
    const { rows } = await db.query<{ data: Buffer }>(
      `SELECT data FROM (
         SELECT data, 0 AS pref FROM blobs
          WHERE vault_id = $1 AND sha256 = $2 AND status = 'ready' AND data IS NOT NULL
         UNION ALL
         SELECT data, 1 AS pref FROM checkpoint_blob_bytes WHERE vault_id = $1 AND sha256 = $2
       ) src ORDER BY pref LIMIT 1`,
      [vaultId, pin.sha256],
    );
    data = rows[0]?.data ?? null;
    if (!data) {
      console.warn(`[revert] bytes for file ${pin.file_id ?? "attachment"} (${pin.sha256}) are gone; leaving it`);
      return false;
    }
  } else if (!pin.storage_key) {
    return false;
  }
  // A pending row for the same (vault, sha, doc) is an upload of these very
  // bytes in progress: leave it to finish rather than race it.
  await db.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename, data,
                        storage_provider, storage_key, status, doc_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', $12)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      vaultId,
      orgId,
      pin.sha256,
      pin.size == null ? null : Number(pin.size),
      pin.mime,
      pin.rel_path,
      filename,
      data,
      provider,
      provider === "postgres" ? null : pin.storage_key,
      docId,
    ],
  );
  const { rows: ready } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM blobs
        WHERE vault_id = $1 AND sha256 = $2 AND status = 'ready'
          AND doc_id IS NOT DISTINCT FROM $3
     ) AS ok`,
    [vaultId, pin.sha256, docId],
  );
  return ready[0]?.ok === true;
}
