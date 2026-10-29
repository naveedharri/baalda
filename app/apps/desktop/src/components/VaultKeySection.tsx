// Vault Settings → General → Vault key (owner only).
//
// Hidden by default; "Show vault key" reveals the 24 words inline with Copy
// and Save to file. Never emailed or sent anywhere: the words leave this
// screen only through the clipboard or a file the owner picks.
// When this device has no verified key for the vault, the same place offers
// "Restore with vault key" (a wrong key is refused, never stored).

import { useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import { currentVaultKeySession } from "../lib/vaultKeys/runtime";
import { vaultKeyFileText, wordsToVaultKey } from "../lib/vaultKeys/crypto";
import { AsyncButton } from "./AsyncButton";

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
  const [restoreText, setRestoreText] = useState("");
  const [, bump] = useState(0);
  if (!vaultId || !session) return null;
  const words = session.revealVaultKey(vaultId);

  return (
    <>
      <div className="menu-sep" />
      <div className="subhead">Vault key</div>
      {words ? (
        <>
          <p className="muted">
            The 24 words that unlock this vault. Anyone who has them can read it. Keep them somewhere safe.
          </p>
          {shown ? (
            <>
              <div className="join-code-row">
                <code>{shown}</code>
              </div>
              <div className="join-code-row">
                <button
                  type="button"
                  className="ghost-pill"
                  onClick={() => void navigator.clipboard?.writeText(shown).then(() => toast("Vault key copied."))}
                >
                  Copy
                </button>
                <AsyncButton
                  className="ghost-pill"
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
                <button type="button" className="ghost-pill" onClick={() => setShown(null)}>
                  Hide
                </button>
              </div>
            </>
          ) : (
            <div className="join-code-row">
              <button type="button" className="ghost-pill" onClick={() => setShown(words)}>
                Show vault key
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted">This computer does not hold the key for this vault. Paste the 24 words to restore it.</p>
          <textarea
            value={restoreText}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRestoreText(e.target.value)}
          />
          <div className="join-code-row">
            <AsyncButton
              className="primary"
              disabled={!restoreText.trim()}
              onClick={async () => {
                const result = await session.restoreWithVaultKey(vaultId, restoreText);
                toast(RESTORE_MESSAGES[result] ?? result, result === "restored" ? "success" : "error");
                if (result === "restored") {
                  setRestoreText("");
                  bump((n) => n + 1);
                }
              }}
            >
              Restore with vault key
            </AsyncButton>
          </div>
        </>
      )}
    </>
  );
}
