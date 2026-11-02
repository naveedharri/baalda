// Save this vault's key to a text file the owner picks (Vault Settings →
// Security, the Save your vault key card, the save-your-key message). The words
// are read from this device's key session; the raw key is zeroed after writing.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../ipc";
import { toast } from "../toast";
import { vaultKeyFileText, wordsToVaultKey } from "./crypto";
import { currentVaultKeySession } from "./runtime";
import { recordVaultKeySaved } from "./reportSavedFlag";

/** True when the file was written; false when there is no key here or the dialog was cancelled. */
export async function saveVaultKeyToFile(vaultId: string, vaultName: string): Promise<boolean> {
  const words = currentVaultKeySession()?.revealVaultKey(vaultId);
  const vk = words ? wordsToVaultKey(words) : null;
  if (!vk) return false;
  try {
    const dest = await saveDialog({
      defaultPath: `${vaultName} vault key.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return false;
    await ipc.saveTextFile(dest, vaultKeyFileText(vaultName, vaultId, vk));
  } catch (e) {
    // The refusal (inside a vault folder, a link) is plain words.
    toast(e instanceof Error ? e.message : String(e), "error");
    return false;
  } finally {
    vk.fill(0);
  }
  toast("Vault key saved.");
  void recordVaultKeySaved(vaultId, "file");
  return true;
}
