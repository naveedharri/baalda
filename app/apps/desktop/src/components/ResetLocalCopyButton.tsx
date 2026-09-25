import { useState } from "react";
import { useStore } from "../store";
import { toast } from "../lib/toast";
import { ResetLocalCopyDialog } from "./VaultFolderMissing";

/**
 * "Reset local copy" (#228): discard this device's folder of the open synced
 * vault and sync a fresh copy down. Available only for a synced vault whose
 * folder is present (a missing folder has Restore here instead). The unsynced
 * list is read when the dialog opens, so the warning describes the moment of
 * asking.
 *
 * A hook so the trigger can live anywhere — a button in Health, an item in a
 * row's ⋯ menu — while the dialog stays mounted by the caller, outliving the
 * menu that closes on click.
 */
export function useResetLocalCopy(): {
  available: boolean;
  start: () => void;
  dialog: React.ReactNode;
} {
  const available = useStore(
    (s) =>
      s.syncEnabled &&
      !!s.session?.activeOrganizationId &&
      s.vault != null &&
      !s.structureNotice.rootMissing,
  );
  const [unsynced, setUnsynced] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setError(null);
    setUnsynced(useStore.getState().unsyncedNotePaths());
  };
  const dialog = unsynced ? (
    <ResetLocalCopyDialog
      unsynced={unsynced}
      error={error}
      onCancel={() => setUnsynced(null)}
      onConfirm={async () => {
        try {
          await useStore.getState().resetLocalVaultCopy();
          setUnsynced(null);
          toast("Vault reset on this device — downloading a fresh copy.", "neutral");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
    />
  ) : null;
  return { available: available || unsynced != null, start, dialog };
}

export function ResetLocalCopyButton({ className = "link-btn danger" }: { className?: string }) {
  const reset = useResetLocalCopy();
  if (!reset.available) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        title="Delete this device's copy of the vault and download a fresh one"
        onClick={reset.start}
      >
        Reset local copy
      </button>
      {reset.dialog}
    </>
  );
}
