// Vault Settings → General → Vault key / Encryption (owners and admins).
//
// Hidden by default; "Show vault key" reveals the 24 words inline with Copy
// and Save to file (owner only). Never emailed or sent anywhere: the words
// leave this screen only through the clipboard or a file the owner picks.
// When the vault is keyed but this device has no verified key for it, the same
// place offers the owner "Restore with vault key" (a wrong key is refused,
// never stored).
// An EXISTING vault is encrypted only when an owner/admin clicks "Encrypt this
// vault" (one-way, confirmed); new vaults are requested at creation. Once
// requested but not keyed yet it shows one line. What to show is decided by
// `vaultKeySectionView`; an unknown state shows nothing. While a keyed vault's
// older content is still being converted (the server's `fullyEncrypted:
// false`), one more line says so (`conversionLine`); once sealed, none.

import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import { api } from "../lib/auth/authManager";
import {
  currentVaultKeySession,
  onVaultKeyEvent,
  pendingConversionReview,
  submitConversionReview,
  vaultKeysNudge,
  vaultKeyStateFor,
} from "../lib/vaultKeys/runtime";
import { ConversionReviewDialog } from "./ConversionReviewDialog";
import { conversionLine, vaultKeySectionView } from "../lib/vaultKeys/sectionView";
import { vaultKeyFileText, wordsToVaultKey } from "../lib/vaultKeys/crypto";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
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
  const [confirmEncrypt, setConfirmEncrypt] = useState(false);
  const [reviewing, setReviewing] = useState(false);
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
      if (e.kind === "vault" || e.kind === "conversion-review") bump((n) => n + 1);
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
    return converting ? (
      <>
        <div className="menu-sep" />
        <div className="muted">{converting}</div>
      </>
    ) : null;
  }
  if (view === "setting-up") {
    const review = pendingConversionReview(vaultId);
    return (
      <>
        <div className="menu-sep" />
        {review ? (
          <div className="menu-row vault-key-row">
            <span className="menu-row-label">
              Encryption
              <span className="field-hint">
                Encryption is waiting for you to review the connected AI tools and public links.
              </span>
            </span>
            <button type="button" className="secondary sm" onClick={() => setReviewing(true)}>
              Review connections
            </button>
          </div>
        ) : (
          <div className="muted">Encryption is being set up for this vault.</div>
        )}
        {review && reviewing && (
          <ConversionReviewDialog
            candidates={review}
            onSubmit={(keep) => {
              setReviewing(false);
              submitConversionReview(vaultId, keep);
              bump((n) => n + 1);
            }}
            onLater={() => setReviewing(false)}
          />
        )}
      </>
    );
  }
  if (view === "encrypt-offer") {
    return (
      <>
        <div className="menu-sep" />
        <div className="menu-row vault-key-row">
          <span className="menu-row-label">
            Encryption
            <span className="field-hint">
              Encrypt this vault with a key only your team&apos;s devices hold. Baalda&apos;s database, backups and
              admins will only see scrambled data. This can&apos;t be undone.
            </span>
          </span>
          <button type="button" className="secondary sm" onClick={() => setConfirmEncrypt(true)}>
            Encrypt this vault
          </button>
        </div>
        {confirmEncrypt && (
          <ConfirmDialog
            tone="accent"
            title={`Encrypt ${vaultName}?`}
            confirmLabel="Encrypt this vault"
            onCancel={() => setConfirmEncrypt(false)}
            onConfirm={async () => {
              try {
                await api.requestVaultEncryption(vaultId);
              } catch {
                // Nothing changed on the server; the dialog stays open to retry.
                toast("Couldn't start encrypting this vault. Try again.", "error");
                return;
              }
              setConfirmEncrypt(false);
              toast("Encryption is being set up for this vault.");
              vaultKeysNudge();
            }}
          >
            <p>
              Its notes, search index and version history will be stored encrypted with a key that only your
              team&apos;s devices hold. Everything keeps working as it does today.
            </p>
            <p>
              New edits are encrypted right away. Older content is encrypted in the background, and its earlier
              unencrypted copies are removed only after each one has been checked.
            </p>
            <p>
              <strong>This is one-way.</strong> Once a vault is encrypted it can&apos;t be turned back off.
            </p>
          </ConfirmDialog>
        )}
      </>
    );
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
            {converting && <> {converting}</>}
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
          <CopyField value={shown} label="vault key" wrap sensitive />
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
