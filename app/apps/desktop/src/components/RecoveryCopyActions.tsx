/* Row actions for one local recovery copy, shared by Vault Health's
   "Reconciled on reconnect" rows and its "Recovery copies" list: Open copy,
   Compare, a Restore menu (replace the current note, or a sibling), Delete
   copy. After a restore it offers to delete the copy. */
import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { noteLabel } from "../lib/notePath";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { RowActionsMenu, type RowAction } from "./RowActionsMenu";
import { copyActions, originalPathOf, siblingRecoveredPath, type CopyRef } from "./recoveryCopies";
import {
  compareCopy,
  deleteCopy,
  openCopy,
  restoreCopyAsSibling,
  restoreCopyReplace,
} from "./recoveryActions";

/** Does a note exist at `path` right now? null while unknown. */
export function useNoteExists(path: string | null, nonce = 0): boolean | null {
  const epoch = useStore((s) => s.vault?.epoch);
  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    if (!path) {
      setExists(false);
      return;
    }
    let cancelled = false;
    ipc.noteExists(path, epoch).then(
      (v) => !cancelled && setExists(v),
      () => !cancelled && setExists(false),
    );
    return () => {
      cancelled = true;
    };
  }, [path, epoch, nonce]);
  return exists;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RecoveryCopyActions({
  copy,
  notePath,
  modified,
  onChanged,
}: {
  copy: CopyRef;
  /** The live note this copy belongs to; defaults to the copy's original path. */
  notePath?: string;
  modified?: number;
  /** After a delete or restore, so the parent list can refresh. */
  onChanged?: () => void;
}) {
  const target = notePath ?? originalPathOf(copy.relPath);
  const [nonce, setNonce] = useState(0);
  const exists = useNoteExists(target, nonce);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "afterRestore">(null);
  const [restoredTo, setRestoredTo] = useState<string | null>(null);
  // A read-only note refuses the edit itself (liveEditorViews), with its own
  // message, so write access is not second-guessed here.
  const avail = copyActions({ hasCopy: true, liveNoteExists: exists === true, canWrite: true });

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
      throw e;
    }
  };

  const restoreActions: RowAction[] = [];
  if (avail.restoreReplace) {
    restoreActions.push({
      key: "replace",
      label: "Replace current note",
      title: `Put this copy's text into ${noteLabel(target)}. It syncs like an edit.`,
      onSelect: () =>
        run(async () => {
          await restoreCopyReplace(copy, target);
          setRestoredTo(target);
          setConfirm("afterRestore");
        }).catch(() => {}),
    });
  }
  if (avail.restoreSibling) {
    const sibling = siblingRecoveredPath(target, () => false);
    restoreActions.push({
      key: "sibling",
      label: `Restore as “${noteLabel(sibling)}”`,
      title: "Create a new note beside the original with this copy's text.",
      onSelect: () =>
        run(async () => {
          const created = await restoreCopyAsSibling(copy);
          setRestoredTo(created);
          setConfirm("afterRestore");
          setNonce((n) => n + 1);
        }).catch(() => {}),
    });
  }
  restoreActions.push({
    key: "delete",
    label: "Delete copy",
    danger: true,
    separated: true,
    onSelect: () => setConfirm("delete"),
  });

  const doDelete = () =>
    run(async () => {
      await deleteCopy(copy);
      setConfirm(null);
      onChanged?.();
    });

  return (
    <>
      <span className="health-missing-actions">
        <button type="button" className="ghost-pill sm" onClick={() => openCopy(copy, modified)}>
          Open copy
        </button>
        {avail.compare && (
          <button
            type="button"
            className="ghost-pill sm"
            onClick={() => compareCopy(copy, target, modified)}
          >
            Compare
          </button>
        )}
        <RowActionsMenu actions={restoreActions} ariaLabel="Restore or delete this copy" />
      </span>
      {error && (
        <p role="alert" className="auth-error health-missing-error">
          {error}
        </p>
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title="Delete this copy?"
          confirmLabel="Delete copy"
          tone="danger"
          onConfirm={doDelete}
          onCancel={() => setConfirm(null)}
        >
          The copy in .context/trash is removed from this device. The current note is not
          changed.
        </ConfirmDialog>
      )}
      {confirm === "afterRestore" && (
        <ConfirmDialog
          title="Restored. Delete the copy?"
          confirmLabel="Delete copy"
          cancelLabel="Keep copy"
          onConfirm={doDelete}
          onCancel={() => {
            setConfirm(null);
            onChanged?.();
          }}
        >
          {`The copy's text is now in ${restoredTo ? noteLabel(restoredTo) : "the note"}. You can delete the copy, or keep it in .context/trash.`}
        </ConfirmDialog>
      )}
    </>
  );
}

/** Preview (and Compare, when a live note sits at the same path) for one
 *  server Trash row. */
export function TrashPreviewActions({
  docId,
  relPath,
  onPreview,
  onCompare,
}: {
  docId: string;
  relPath: string;
  onPreview: (docId: string, relPath: string) => void;
  onCompare: (docId: string, relPath: string) => void;
}) {
  const exists = useNoteExists(relPath);
  return (
    <>
      <AsyncButton className="ghost-pill sm" onClick={() => onPreview(docId, relPath)}>
        Preview
      </AsyncButton>
      {exists && (
        <AsyncButton className="ghost-pill sm" onClick={() => onCompare(docId, relPath)}>
          Compare
        </AsyncButton>
      )}
    </>
  );
}
