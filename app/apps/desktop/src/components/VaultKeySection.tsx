// Vault Settings → General → Vault key / Encryption (owners and admins).
//
// Hidden by default; "Show vault key" reveals the 24 words inline with Copy
// and Save to file (owner only). Never emailed or sent anywhere: the words
// leave this screen only through the clipboard or a file the owner picks.
// When the vault is keyed but this device has no verified key for it, the same
// place offers the owner "Restore with vault key" (a wrong key is refused,
// never stored).
// Every vault is encrypted automatically (no opt-in, no review): an unkeyed
// vault shows nothing here. What to show is decided by
// `vaultKeySectionView`; an unknown state shows nothing. While a keyed vault's
// older content is still being converted (the server's `fullyEncrypted:
// false`), one more line says so (`conversionLine`); once sealed, none.

import { useEffect, useState, type ReactNode } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import { api } from "../lib/auth/authManager";
import {
  currentVaultKeySession,
  onVaultKeyEvent,
  vaultKeyStateFor,
} from "../lib/vaultKeys/runtime";
import { conversionLine, vaultKeySectionView } from "../lib/vaultKeys/sectionView";
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

export function VaultKeySection({
  vaultName,
  isOwner,
  canManage,
}: {
  vaultName: string;
  isOwner: boolean;
  canManage: boolean;
}) {
  const vaultId = syncManager.registry.vaultId;
  const session = currentVaultKeySession();
  const [shown, setShown] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [fullyEncrypted, setFullyEncrypted] = useState<boolean | undefined>(undefined);
  const [, bump] = useState(0);
  // Revealed words belong to ONE vault: a vault switch hides them (they must
  // never be shown under another vault's name).
  useEffect(() => {
    setShown(null);
    setRestoreText("");
    setRestoring(false);
  }, [vaultId]);
  useEffect(() => {
    const off = onVaultKeyEvent((e) => {
      if (e.kind === "vault") bump((n) => n + 1);
    });
    return () => void off();
  }, []);
  const keyedState = vaultId ? vaultKeyStateFor(vaultId)?.state : undefined;
  useEffect(() => {
    // Conversion progress, read once per open of this section (the server
    // reports what its background worker last recorded).
    setFullyEncrypted(undefined);
    if (!vaultId || !keyedState || keyedState === "unkeyed" || keyedState === "disabled") return;
    let live = true;
    api
      .getMyVaultKeys(vaultId)
      .then((mine) => {
        if (live && mine.keyed && !mine.pending) setFullyEncrypted(mine.fullyEncrypted);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vaultId, keyedState]);
  if (!vaultId || !session) return null;
  const words = isOwner ? session.revealVaultKey(vaultId) : null;
  const state = vaultKeyStateFor(vaultId);
  const view = vaultKeySectionView({ hasWords: !!words, state, isOwner, canManage });
  const converting = conversionLine({ state, isOwner, canManage, fullyEncrypted });

  if (view === "hidden") {
    // An admin (not the owner) of an encrypted vault still sees its status.
    return state?.state === "ready" ? <EncryptionCard converting={converting} /> : null;
  }
  const saveKeyFile = async (keyWords: string) => {
    const vk = wordsToVaultKey(keyWords);
    if (!vk) return;
    const dest = await saveDialog({
      defaultPath: `${vaultName} vault key.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) {
      vk.fill(0);
      return;
    }
    try {
      await ipc.saveTextFile(dest, vaultKeyFileText(vaultName, vaultId, vk));
    } catch (e) {
      // The refusal (inside a vault folder, a link) is plain words.
      toast(e instanceof Error ? e.message : String(e), "error");
      return;
    } finally {
      vk.fill(0);
    }
    toast("Vault key saved.");
  };

  return (
    <EncryptionCard converting={converting}>
      <div className="encryption-key-row">
        <KeyIcon />
        <span className="encryption-key-text">
          <b>Vault key</b>
          <span>
            {words
              ? "24 words that unlock this vault on a new computer. Anyone with them can read it."
              : "This computer doesn't have this vault's key yet. A teammate's computer usually shares it automatically."}
          </span>
        </span>
        {words && !shown && (
          <>
            <AsyncButton className="secondary sm" onClick={() => saveKeyFile(words)}>
              Save to file
            </AsyncButton>
            <button type="button" className="encryption-ink-btn" onClick={() => setShown(words)}>
              Show vault key
            </button>
          </>
        )}
        {!words && !restoring && (
          <button type="button" className="encryption-ink-btn" onClick={() => setRestoring(true)}>
            Restore with vault key
          </button>
        )}
      </div>

      {words && shown && (
        <div className="vault-key-panel">
          <CopyField value={shown} label="vault key" wrap sensitive />
          <div className="row">
            <AsyncButton className="secondary sm" onClick={() => saveKeyFile(shown)}>
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
    </EncryptionCard>
  );
}

function KeyIcon() {
  return (
    <svg className="encryption-key-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
    </svg>
  );
}

/**
 * The encrypted vault's status card: what is encrypted, what is not, and the
 * conversion line while older content is still being checked. `children` is
 * the owner's key row (and its reveal or restore panel), at the card's foot.
 * Copy rule: never "end-to-end" or "zero-knowledge" (docs/VAULT_KEYS.md).
 */
function EncryptionCard({ converting, children }: { converting: string | null; children?: ReactNode }) {
  return (
    <section className="encryption-card" aria-label="Encryption">
      <div className="encryption-card-main">
        <span className="encryption-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
            <circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <div className="encryption-card-body">
          <div className="encryption-card-title">
            Encrypted <span className="encryption-pill">Key held by your team</span>
          </div>
          <p className="encryption-card-desc">
            This vault is encrypted with a key that only your team&apos;s devices hold. Baalda&apos;s database and
            backups store scrambled data.
          </p>
          {converting && <p className="encryption-card-converting">{converting}</p>}
          <ul className="encryption-covered">
            <li>Notes</li>
            <li>Search</li>
            <li>Version history</li>
            <li className="not">Titles, folder names and attachment files stay readable</li>
          </ul>
        </div>
      </div>
      {children && <div className="encryption-card-foot">{children}</div>}
    </section>
  );
}
