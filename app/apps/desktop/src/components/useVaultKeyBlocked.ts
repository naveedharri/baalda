import { useEffect, useReducer } from "react";
import { useStore } from "../store";
import { syncManager } from "../lib/sync/docSession";
import { onVaultKeyBlockChange, openVaultKeyView } from "../lib/vaultKeys/runtime";

/**
 * True while the OPEN vault is keyed and this computer does not hold its key:
 * nothing syncs until a teammate shares it (`VaultKeyWaitingNotice`). Read
 * fresh for the vault open now, so a block of the vault we left never shows.
 */
export function useVaultKeyBlocked(): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useStore((s) => s.vault?.epoch);
  useEffect(() => onVaultKeyBlockChange(() => bump()), []);
  return openVaultKeyView(syncManager.registry.vaultId).blocked;
}
