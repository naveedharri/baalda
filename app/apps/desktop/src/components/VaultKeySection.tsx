// Vault Settings → General → Vault key (owner only).
//
// Hidden by default; "Show vault key" reveals the 24 words inline with Copy
// and Save to file. Never emailed or sent anywhere: the words leave this
// screen only through the clipboard or a file the owner picks.
// When the vault is keyed but this device has no verified key for it, the same
// place offers "Restore with vault key" (a wrong key is refused, never stored).
// A vault that is not keyed yet shows one line; an unknown state shows nothing.

import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import { blocksStructure, currentVaultKeySession, onVaultKeyEvent, vaultKeyStateFor } from "../lib/vaultKeys/runtime";
import { vaultKeyFileText, wordsToVaultKey } from "../lib/vaultKeys/crypto";
import { AsyncButton } from "./AsyncButton";
import { CopyField } from "./McpTab";

const RESTORE_MESSAGES: Record<string, string> = {
  restored: "Vault key restored on this computer.",
  "invalid-words": "Those are not 24 valid key words. Check each word.",
  "wrong-key": "That key does not belong to this vault. Nothing was changed.",
  "cannot-verify": "The server could not confirm the key right now. Try again later.",
  "security-warning": "Your security key does not match this computer. Keys are paused.",
  disabled: "This server does not support vault keys yet.",
};

export function VaultKeySection({ vaultName }: { vaultName: string }) {
  const vaultId = syncManager.registry.vaultId;
  const session = currentVaultKeySession();
  const [shown, setShown] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [, bump] = useState(0);
  useEffect(() => {
    const off = onVaultKeyEvent((e) => {
      if (e.kind === "vault") bump((n) => n + 1);
    });
    return () => void off();
  }, []);
  if (!vaultId || !session) return null;
  const words = session.revealVaultKey(vaultId);
  const state = vaultKeyStateFor(vaultId);

  if (!words) {
    if (state?.state === "unkeyed") {
      return (
        <>
          <div className="menu-sep" />
          <div className="muted">Encryption is being set up for this vault.</div>
        </>
      );
    }
    // Keyed, but this computer cannot open it (a security warning has its own notice).
    if (!state || !blocksStructure(state) || state.state === "security-warning") return null;
  }

  return (
    <>
      <div className="menu-sep" />
      <div className="menu-row vault-key-row">
        <span className="menu-row-label">
          Vault key
          <span className="field-hint">
            {words
              ? "The 24 words that unlock this vault. Keep them somewhere safe; anyone with them can read it."
              : "This computer doesn't have this vault's key yet. A teammate's computer usually shares it automatically."}
          </span>
        </span>
        {words && !shown && (
          <button type="button" className="secondary sm" onClick={() => setShown(words)}>
            Show vault key
          </button>
        )}
        {!words && !restoring && (
          <button type="button" className="secondary sm" onClick={() => setRestoring(true)}>
            Restore with vault key
          </button>
        )}
      </div>

      {words && shown && (
        <div className="vault-key-panel">
          <CopyField value={shown} label="vault key" wrap />
          <div className="row">
            <AsyncButton
              className="secondary sm"
              onClick={async () => {
                const vk = wordsToVaultKey(shown);
                if (!vk) return;
                const dest = await saveDialog({
                  defaultPath: `${vaultName} vault key.txt`,
                  filters: [{ name: "Text", extensions: ["txt"] }],
                });
                if (!dest) return;
                await ipc.saveTextFile(dest, vaultKeyFileText(vaultName, vaultId, vk));
                toast("Vault key saved.");
              }}
            >
              Save to file
            </AsyncButton>
            <button type="button" className="secondary sm" onClick={() => setShown(null)}>
              Hide
            </button>
          </div>
        </div>
      )}

      {!words && restoring && (
        <div className="vault-key-panel">
          <textarea
            className="vault-key-input"
            value={restoreText}
            rows={3}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the 24 words of this vault's key"
            aria-label="Vault key"
            onChange={(e) => setRestoreText(e.target.value)}
          />
          <div className="row">
            <AsyncButton
              className="primary sm"
              disabled={!restoreText.trim()}
              onClick={async () => {
                const result = await session.restoreWithVaultKey(vaultId, restoreText);
                toast(RESTORE_MESSAGES[result] ?? result, result === "restored" ? "success" : "error");
                if (result === "restored") {
                  setRestoreText("");
                  setRestoring(false);
                  bump((n) => n + 1);
                }
              }}
            >
              Restore
            </AsyncButton>
            <button
              type="button"
              className="secondary sm"
              onClick={() => {
                setRestoring(false);
                setRestoreText("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
