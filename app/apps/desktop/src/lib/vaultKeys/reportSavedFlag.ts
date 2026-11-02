// The owner's "I kept this vault's key" record. The server holds it
// (`POST /api/vaults/:id/keys/saved`, what the save-your-key message reads);
// this device also keeps the older local flag, which hides the Save your vault
// key card even when the server could not be told. A flag set before the
// server record existed is reported once, at launch or when the card mounts.

import { api, authManager } from "../auth/authManager";

const scope = (vaultId: string) => `${authManager.getServerUrl()}|${vaultId}`;
const savedKey = (vaultId: string) => `context.vaultKeySaved:${scope(vaultId)}`;
const reportedKey = (vaultId: string) => `context.vaultKeySavedReported:${scope(vaultId)}`;

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function write(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* storage unavailable: the card shows again, the report retries */
  }
}

export function vaultKeySavedHere(vaultId: string): boolean {
  return read(savedKey(vaultId));
}

/** Record a save on this device and on the server; never throws. */
export async function recordVaultKeySaved(vaultId: string, method: "file" | "confirmed"): Promise<void> {
  write(savedKey(vaultId));
  try {
    await api.markVaultKeySaved(vaultId, method);
    write(reportedKey(vaultId));
  } catch {
    /* best effort: an unreported local flag is sent again next launch */
  }
}

/** A local flag the server has not heard about yet: tell it once. */
export async function reportSavedFlagOnce(vaultId: string): Promise<void> {
  if (!read(savedKey(vaultId)) || read(reportedKey(vaultId))) return;
  try {
    await api.markVaultKeySaved(vaultId, "confirmed");
    write(reportedKey(vaultId));
  } catch {
    /* retried on the next launch or card mount */
  }
}
