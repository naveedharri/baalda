import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessTreeResponse } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import {
  loadAccessMap,
  readCachedAccessMap,
  writeCachedAccessMap,
  type SummaryMode,
} from "../lib/accessBoardLoad";
import { createStaleReloader, onAccessTreeStale, sameAccessTreeItems } from "../lib/accessTreeStale";

/** The person Access tab's shared load, used by Board and List alike. */
export interface AccessMap {
  tree: AccessTreeResponse | null;
  /** Every row's mode from one request; null = old server (read per row). */
  modes: ReadonlyMap<string, SummaryMode> | null;
  /** True when `modes` covers the whole tree, so a reload refreshes every row. */
  complete: boolean;
  error: string | null;
  /** Bumps on every finished load: consumers re-seed their modes from it. */
  seq: number;
  /** Load again (after a large write, a reset, back online). Resolves true when it landed. */
  reload: () => Promise<boolean>;
}

/** Global so a seq never repeats across vaults or people. */
let loads = 0;

export function useAccessMap(vaultId: string | null, userId: string, enabled = true): AccessMap {
  const [state, setState] = useState<Omit<AccessMap, "reload">>({
    tree: null, modes: null, complete: false, error: null, seq: 0,
  });
  const token = useRef(0);
  const bgToken = useRef(0);
  const treeRef = useRef<AccessTreeResponse | null>(null);
  treeRef.current = state.tree;

  /** `structural`: a background re-read after a registry change. It lands only
   *  when the listing gained, lost or moved an item, so it never overwrites an
   *  optimistic mode a write just painted on an unchanged tree. */
  const load = useCallback(async (initial: boolean, structural = false): Promise<boolean> => {
    if (!vaultId) return false;
    // A background re-read never cancels a write's own reload: it takes its own
    // token and yields to any load that starts after it.
    const mine = structural ? token.current : ++token.current;
    const bg = ++bgToken.current;
    const current = () => mine === token.current && (!structural || bg === bgToken.current);
    try {
      const { tree, modes } = await loadAccessMap(authManager.api, vaultId, userId);
      if (!current()) return false;
      if (structural && sameAccessTreeItems(treeRef.current, tree)) return false;
      writeCachedAccessMap(authManager.getServerUrl(), vaultId, userId, { tree, modes });
      setState(() => ({ tree, modes, complete: modes !== null, error: null, seq: ++loads }));
      return true;
    } catch {
      if (!current() || structural) return false;
      // A failed first load shows the existing error line; a failed reload
      // keeps what is on screen.
      if (initial) setState((s) => ({ ...s, error: "Couldn't load this vault's folders." }));
      return false;
    }
  }, [vaultId, userId]);

  useEffect(() => {
    if (!enabled) return;
    // A map seen earlier this session paints at once (paint only); the load
    // below replaces it (#307).
    const seen = vaultId ? readCachedAccessMap(authManager.getServerUrl(), vaultId, userId) : null;
    setState(
      seen
        ? { tree: seen.tree, modes: seen.modes, complete: seen.modes !== null, error: null, seq: ++loads }
        : { tree: null, modes: null, complete: false, error: null, seq: 0 },
    );
    void load(!seen);
    return () => { token.current++; };
  }, [enabled, load, vaultId, userId]);

  // New files, folders and notes appear while the tab is open: this device's
  // own registrations and teammates' registry frames mark the tree stale.
  useEffect(() => {
    if (!enabled || !vaultId) return;
    const reloader = createStaleReloader(() => { void load(false, true); });
    const off = onAccessTreeStale(() => reloader.poke());
    return () => { off(); reloader.dispose(); };
  }, [enabled, load, vaultId]);

  const reload = useCallback(() => load(false), [load]);
  return { ...state, reload };
}
