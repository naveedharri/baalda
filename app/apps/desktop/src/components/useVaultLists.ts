/* The three chained hooks that answer "which vaults does this device/account
   know about". Shared by the account menu's popovers and by the (lazy)
   vault-settings dialog, so they live outside both. */
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../lib/ipc";
import type { RecentVault } from "../lib/ipc";
import { readKnownVaults, readOrgVaults, useStore } from "../store";
import { unboundRecents } from "../lib/vaultRows";

/** Every recently opened folder on this device, newest first. */
export function useRecentVaults(nonce = 0): RecentVault[] {
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // Re-fetch when the open folder changes (a switch/open reorders recents) and
  // when `nonce` is bumped (after a local remove/delete removes a row).
  const openPath = useStore((s) => s.vault?.path);
  useEffect(() => {
    let alive = true;
    ipc
      .getRecentVaults()
      .then((l) => {
        if (alive) setRecents(l);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nonce, openPath]);
  return recents;
}

/**
 * Vaults this account knows about: the ones it holds now, plus the cached list
 * (which survives sign-out and a dropped connection). Used to tell a folder
 * bound to a real vault from one bound to a vault that's gone — see
 * `unboundRecents` for why that distinction is what un-hides ghost vaults.
 */
export function useKnownOrgIds(): ReadonlySet<string> {
  const organizations = useStore((s) => s.organizations);
  return useMemo(
    () =>
      new Set([
        ...organizations.map((o) => o.id),
        ...readKnownVaults().map((v) => v.id),
      ]),
    [organizations],
  );
}

/**
 * Recent on-disk folders that aren't bound to a vault in this account — i.e.
 * the user's LOCAL vaults. A vault is one concept in two states; these are
 * the ones that just aren't syncing to a vault yet.
 */
export function useLocalVaults(nonce = 0): RecentVault[] {
  const recents = useRecentVaults(nonce);
  const knownOrgIds = useKnownOrgIds();
  return useMemo(
    () => unboundRecents(recents, readOrgVaults(), knownOrgIds),
    [recents, knownOrgIds],
  );
}
