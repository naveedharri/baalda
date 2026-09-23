// The Health nav entry's count. Reads `syncManager.syncFailures()` on the same
// store signals `useVaultHealth` re-reads it on, so the badge and the page can
// never disagree about whether something is waiting on the user.

import { useMemo } from "react";
import { useStore } from "../../store";
import { syncManager } from "../sync/docSession";
import { actionNeededCount } from "./attention";
import { DEMO_FAILURES, healthDemoEnabled } from "./demoFixture";

export function useHealthAttentionCount(): number {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const syncProgress = useStore((s) => s.syncProgress);
  const docSyncState = useStore((s) => s.docSyncState);
  return useMemo(() => {
    if (import.meta.env.DEV && healthDemoEnabled()) return actionNeededCount(DEMO_FAILURES);
    if (!syncEnabled) return 0;
    try {
      return actionNeededCount(syncManager.syncFailures());
    } catch {
      return 0;
    }
    // Deps are the fields that MOVE when a failure appears or clears — the
    // same list `useVaultHealth` uses; `syncManager` is a stable singleton.
  }, [syncProgress, docSyncState, syncStatus, syncEnabled]);
}
