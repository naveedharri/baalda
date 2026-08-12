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

export interface VaultRevertOutcome {
  docsChanged: number;
  docsRestored: number;
  docsDeleted: number;
  foldersCreated: number;
  /** Docs whose snapshot was empty while the live note has text — left alone. */
  docsKeptOverEmpty: number;
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

  const outcome = await withVaultCheckpointLock(
    vaultId,
    async (db): Promise<VaultRevertOutcome> => {
      const { rows: cpRows } = await db.query<{ structure: CheckpointStructure }>(
        "SELECT structure FROM vault_checkpoints WHERE id = $1 AND vault_id = $2",
        [checkpointId, vaultId],
      );
      if (!cpRows[0]) throw new RevertError("Unknown checkpoint");
      const structure: CheckpointStructure = {
        notes: cpRows[0].structure?.notes ?? [],
        folders: cpRows[0].structure?.folders ?? [],
      };

      const { rows: docRows } = await db.query<{
        doc_id: string;
        sha256: string;
        content: string;
      }>(
        "SELECT doc_id, sha256, content FROM vault_checkpoint_docs WHERE checkpoint_id = $1",
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
      let docsChanged = 0;
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
          await db.query(
            `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id)
             VALUES ($1, $2, $3, $4, $5, $1)
             ON CONFLICT (id) DO NOTHING`,
            [note.id, vaultId, folderId, note.title, note.rel_path],
          );
          docsRestored++;
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
                  SET deleted_at = NULL, rel_path = $2, title = $3, folder_id = $4,
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
        await docWriter.setContent(vaultId, note.id, snapshot.content, { userId });
        await stampLastEdited(note.id, userId, db);
        docsChanged++;
      }

      // ── notes created after the checkpoint ─────────────────────────────────
      // Soft-deleted, exactly as a user delete would: the row and the CRDT doc
      // survive, so a later revert to a newer checkpoint brings them back.
      const keepIds = structure.notes.map((n) => n.id);
      const { rows: removed } = await db.query<{ id: string }>(
        `UPDATE notes SET deleted_at = now()
          WHERE vault_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::text[]))
        RETURNING id`,
        [vaultId, keepIds],
      );
      if (removed.length > 0) {
        await purgeNoteIndex(
          removed.map((r) => r.id),
          db,
        );
      }

      return {
        docsChanged,
        docsRestored,
        docsDeleted: removed.length,
        foldersCreated,
        docsKeptOverEmpty,
        preRevertCheckpointId: preRevert.id,
      };
    },
    pool,
  );

  if (!outcome.acquired) return outcome;
  // After COMMIT, so a client that re-pulls on the broadcast sees the new tree.
  opts.onRegistryChanged?.(vaultId, null);
  return { acquired: true, result: outcome.value };
}
