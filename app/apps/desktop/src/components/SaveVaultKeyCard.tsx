// "Important: save your vault key" (owner decision 2026-11-01). Shown at the top
// of Vault Settings → General, only to the OWNER of an encrypted vault who would
// otherwise have no way back if this computer were lost: no password wrap of
// their account key, no other computer holding it, and no teammate holding the
// vault key. Not a popup: a card that stays until they act. Any action hides it
// (remembered on this device); setting a password removes the need entirely.
// Saving to a file or "I've saved it" is also recorded on the server
// (`reportSavedFlag.ts`); setting a password is not a key save.

import { useEffect, useState } from "react";
import { toast } from "../lib/toast";
import { api } from "../lib/auth/authManager";
import { currentVaultKeySession, onVaultKeyEvent, vaultKeysPasswordUnlock } from "../lib/vaultKeys/runtime";
import { recordVaultKeySaved, reportSavedFlagOnce, vaultKeySavedHere } from "../lib/vaultKeys/reportSavedFlag";
import { saveVaultKeyToFile } from "../lib/vaultKeys/saveKeyFile";
import { useStore } from "../store";
import { AsyncButton } from "./AsyncButton";
import { CopyField } from "./McpTab";

/** Local dev only (`VITE_PREVIEW_SAVE_KEY_CARD=1 pnpm run dev:desktop`): show the
 *  card on any vault this owner holds the key for, to review the design. */
const PREVIEW = import.meta.env.DEV && import.meta.env.VITE_PREVIEW_SAVE_KEY_CARD === "1";

export function SaveVaultKeyCard({ vaultId, vaultName }: { vaultId: string; vaultName: string }) {
  const userId = useStore((s) => s.session?.user.id ?? null);
  const [needed, setNeeded] = useState(false);
  const [canSetPassword, setCanSetPassword] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [settingPassword, setSettingPassword] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => onVaultKeyEvent(() => setRefresh((n) => n + 1)), []);

  useEffect(() => {
    let live = true;
    setNeeded(false);
    setShown(null);
    if (vaultKeySavedHere(vaultId) && !PREVIEW) {
      void reportSavedFlagOnce(vaultId);
      return;
    }
    void (async () => {
      const words = currentVaultKeySession()?.revealVaultKey(vaultId);
      if (!words) return; // not keyed here, or not the owner's device
      const [mine, me, hasPassword] = await Promise.all([
        api.getMyVaultKeys(vaultId).catch(() => null),
        api.getMyKeys().catch(() => null),
        api.hasPasswordLogin(),
      ]);
      if (!live || !mine || !mine.keyed || mine.pending || !me) return;
      const noWayBack =
        !me.privWrappedPassword && (me.devices?.length ?? 0) === 0 && (mine.otherKeyHolders ?? 1) === 0;
      setCanSetPassword(hasPassword === false || PREVIEW);
      setNeeded(noWayBack || PREVIEW);
    })();
    return () => {
      live = false;
    };
  }, [vaultId, refresh]);

  if (!needed) return null;

  const words = () => currentVaultKeySession()?.revealVaultKey(vaultId) ?? null;
  const saveToFile = async () => {
    if (await saveVaultKeyToFile(vaultId, vaultName)) setNeeded(false);
  };

  const confirmSaved = async () => {
    await recordVaultKeySaved(vaultId, "confirmed");
    setNeeded(false);
    toast("Got it.");
  };

  const setPassword = async () => {
    if (pw.length < 8) return toast("Use at least 8 characters.", "error");
    if (pw !== pw2) return toast("The two passwords don't match.", "error");
    try {
      await api.setAccountPassword(pw);
      if (userId) await vaultKeysPasswordUnlock(userId, pw);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      return;
    } finally {
      setPw("");
      setPw2("");
    }
    setSettingPassword(false);
    setNeeded(false);
    toast("Password set. It now also unlocks your vaults on a new computer.");
  };

  return (
    <section className="save-key-card" aria-label="Save your vault key">
      <div className="save-key-head">
        <span className="save-key-badge" aria-hidden="true">!</span>
        <div>
          <div className="save-key-title">Important: save your vault key</div>
          <p className="save-key-desc">
            Only your devices hold this vault&apos;s key. If you lose this computer, you&apos;ll need it to get back
            in. Keep a copy somewhere safe, like a password manager.
          </p>
          <p className="save-key-desc">
            To use it on a new computer, open the vault and choose Restore with vault key.
          </p>
        </div>
      </div>
      <div className="save-key-actions">
        <AsyncButton className="primary sm" onClick={saveToFile}>
          Save to file
        </AsyncButton>
        <button type="button" className="secondary sm" onClick={() => setShown(shown ? null : words())}>
          {shown ? "Hide key" : "Show key"}
        </button>
        {canSetPassword && (
          <button type="button" className="secondary sm" onClick={() => setSettingPassword((v) => !v)}>
            Set a password instead
          </button>
        )}
      </div>
      {shown && (
        <div className="save-key-panel">
          <CopyField value={shown} label="vault key" wrap sensitive />
          <AsyncButton className="ghost sm" onClick={confirmSaved}>
            I&apos;ve saved it
          </AsyncButton>
        </div>
      )}
      {settingPassword && (
        <div className="save-key-panel">
          <p className="save-key-desc">
            A Baalda password unlocks your vaults on a new computer. You can also sign in with it, as well as with Google.
          </p>
          <input type="password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <input type="password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          <AsyncButton className="primary sm" onClick={setPassword}>
            Set password
          </AsyncButton>
        </div>
      )}
    </section>
  );
}
