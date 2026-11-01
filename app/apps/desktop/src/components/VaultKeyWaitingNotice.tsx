import { useEffect, useReducer, useState } from "react";
import { Banner } from "./Banner";
import { LostDevicesFlow, RestoreVaultKeyDialog } from "./VaultKeyRecovery";
import { useStore } from "../store";
import { useNoticeSlot } from "./useNoticeSlot";
import { syncManager } from "../lib/sync/docSession";
import {
  accountKeyStateNow,
  freshAccountKeyCode,
  onVaultKeyBlockChange,
  onVaultKeyEvent,
  openVaultKeyView,
  vaultKeysNudge,
} from "../lib/vaultKeys/runtime";
import {
  FRESH_KEY_WAITING_PREFIX,
  LOST_DEVICES_LABEL,
  offersLostDevices,
  waitingNoticeCode,
} from "../lib/vaultKeys/recovery";

/**
 * W3: this computer does not hold the open vault's key yet, so sync is paused
 * (nothing on disk is touched). Informational: a teammate's device shares the
 * key automatically. Owners can restore it with their 24-word vault key.
 * While this computer waits for another device's approval it also offers
 * "I don't have my other devices" (a fresh account key); after that, it shows
 * the new key's code for teammates to confirm.
 */
export function VaultKeyWaitingNotice() {
  const [restoring, setRestoring] = useState(false);
  const [lostDevices, setLostDevices] = useState(false);
  const [account, setAccount] = useState(accountKeyStateNow);
  const [freshCode, setFreshCode] = useState(freshAccountKeyCode);
  const isOwner = useStore((s) => s.members.find((m) => m.userId === s.session?.user.id)?.role === "owner");
  // Re-render on any key event or vault switch; what shows is read for the
  // vault open NOW, so a block of the vault we left never shows on the next.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useStore((s) => s.vault?.epoch);
  useEffect(() => onVaultKeyBlockChange(() => bump()), []);
  useEffect(
    () =>
      onVaultKeyEvent((e) => {
        if (e.kind === "account") {
          setAccount(e.state);
          setFreshCode(freshAccountKeyCode());
        } else if (e.kind === "fresh-key") setFreshCode(e.code);
        bump();
      }),
    [],
  );
  const vaultId = syncManager.registry.vaultId;
  const { blocked, state: vaultState } = openVaultKeyView(vaultId);
  const code = waitingNoticeCode({ freshCode, vaultState });

  const visible = useNoticeSlot("vault-key-waiting", blocked);

  return (
    <>
      <Banner show={visible}>
        {code ? (
          <span>
            {FRESH_KEY_WAITING_PREFIX} <strong>{code}</strong>. Your files here are untouched; sync resumes on its
            own.
          </span>
        ) : (
          <span>
            This vault is locked on this computer until a teammate shares its key. Your files here are untouched;
            sync resumes on its own.
          </span>
        )}
        <div className="banner-actions">
          {isOwner && (
            <button className="primary" onClick={() => setRestoring(true)}>
              Restore with vault key
            </button>
          )}
          {offersLostDevices(account) && (
            <button className="ghost-pill" onClick={() => setLostDevices(true)}>
              {LOST_DEVICES_LABEL}
            </button>
          )}
          <button className="ghost-pill" onClick={() => vaultKeysNudge()}>
            Check again
          </button>
        </div>
      </Banner>
      {restoring && vaultId && <RestoreVaultKeyDialog vaultId={vaultId} onClose={() => setRestoring(false)} />}
      {lostDevices && <LostDevicesFlow isOwner={isOwner} vaultId={vaultId} onClose={() => setLostDevices(false)} />}
    </>
  );
}
