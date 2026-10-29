import { useEffect, useState } from "react";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./ConfirmDialog";
import { useStore } from "../store";
import { useNoticeSlot } from "./useNoticeSlot";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import {
  currentVaultKeySession,
  isVaultKeyBlocked,
  onVaultKeyBlockChange,
  vaultKeysNudge,
} from "../lib/vaultKeys/runtime";

/**
 * W3: this computer does not hold the open vault's key yet, so sync is paused
 * (nothing on disk is touched). Informational: a teammate's device shares the
 * key automatically. Owners can restore it with their 24-word vault key.
 */
export function VaultKeyWaitingNotice() {
  const [blocked, setBlocked] = useState(() => isVaultKeyBlocked(syncManager.registry.vaultId));
  const [restoring, setRestoring] = useState(false);
  const [words, setWords] = useState("");
  const isOwner = useStore((s) => s.members.find((m) => m.userId === s.session?.user.id)?.role === "owner");

  useEffect(
    () =>
      onVaultKeyBlockChange((vaultId, now) => {
        if (vaultId === syncManager.registry.vaultId) setBlocked(now);
      }),
    [],
  );

  const visible = useNoticeSlot("vault-key-waiting", blocked);
  const vaultId = syncManager.registry.vaultId;

  return (
    <>
      <Banner show={visible}>
        <span>
          This vault is locked on this computer until a teammate shares its key. Your files here are untouched;
          sync resumes on its own.
        </span>
        <div className="banner-actions">
          {isOwner && (
            <button className="primary" onClick={() => setRestoring(true)}>
              Restore with vault key
            </button>
          )}
          <button className="ghost-pill" onClick={() => vaultKeysNudge()}>
            Check again
          </button>
        </div>
      </Banner>
      {restoring && vaultId && (
        <ConfirmDialog
          title="Restore with vault key"
          tone="accent"
          confirmLabel="Restore"
          confirmDisabled={!words.trim()}
          onCancel={() => setRestoring(false)}
          onConfirm={async () => {
            const result = await currentVaultKeySession()?.restoreWithVaultKey(vaultId, words);
            if (result === "restored") {
              toast("Vault key restored on this computer.");
              setWords("");
              setRestoring(false);
              vaultKeysNudge();
            } else {
              toast(
                result === "wrong-key"
                  ? "That key does not belong to this vault. Nothing was changed."
                  : result === "invalid-words"
                    ? "Those are not 24 valid key words. Check each word."
                    : "The key could not be checked right now. Try again later.",
                "error",
              );
            }
          }}
        >
          <p>Paste the 24 words of this vault's key.</p>
          <textarea
            value={words}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setWords(e.target.value)}
          />
        </ConfirmDialog>
      )}
    </>
  );
}
