import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { buildGraph, type Graph } from "./buildGraph";
import { onFileChanged } from "../ipc";
import { useStore } from "../../store";

/** Delay before rebuilding after a file-changed event, so bursts of edits
 *  (e.g. an AI rewrite touching many notes) collapse into one rebuild. */
const REBUILD_DEBOUNCE_MS = 250;

export interface GraphDataState {
  graph: Graph | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Loads the note link-graph and keeps it live. It rebuilds on three triggers:
 *  1. mount,
 *  2. the open vault or its indexed note count changing — so the graph reflects
 *     the current vault even if this hook mounted before the index was ready
 *     (e.g. right after a vault switch or an app reload; otherwise the first,
 *     empty build would stick, since a view-only session fires no edits), and
 *  3. `file-changed` from the Rust watcher, debounced, for live edits.
 */
export function useGraphData(): GraphDataState {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards async callbacks that outlive the component.
  const isMountedRef = useRef(true);
  // Holds the pending debounced rebuild so we can coalesce/cancel it.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Monotonic id of the most recently ISSUED build. Only the latest build is
  // allowed to update state — but CRUCIALLY, the latest build ALWAYS clears
  // `loading` when it settles. (The old design gated the loading-reset on a
  // per-build `cancelled` flag, so a build superseded before it resolved never
  // cleared `loading`; when builds kept getting superseded — e.g. the note
  // count settling as a big vault indexes — `loading` stuck `true` forever and
  // the graph hung on "Loading…". Latest-wins-by-id can't strand it.)
  const buildIdRef = useRef(0);

  // Readiness signals: which vault is open, and how many notes it has indexed.
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const noteCount = useStore((s) => s.titles.length);

  const applyBuild = useCallback((showLoading: boolean) => {
    const id = ++buildIdRef.current;
    const isLatest = () => isMountedRef.current && buildIdRef.current === id;
    if (showLoading) setLoading(true);
    buildGraph()
      .then((g) => {
        if (!isLatest()) return;
        setGraph(g);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!isLatest()) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, []);

  // Immediate rebuild for the header refresh button.
  const refresh = useCallback(() => {
    applyBuild(true);
  }, [applyBuild]);

  // Track mount for the async callbacks above/below.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // (Re)build on mount and whenever the vault or its note count changes.
  useEffect(() => {
    applyBuild(true);
  }, [applyBuild, vaultPath, noteCount]);

  // Live updates: debounce file-changed events into one silent rebuild (no
  // loading flash, so the view updates in place).
  useEffect(() => {
    const rebuildSilently = () => applyBuild(false);

    // Effect body can't be async; capture the unlisten fn when it resolves,
    // and tear down immediately if we already unmounted before it did.
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    onFileChanged(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(rebuildSilently, REBUILD_DEBOUNCE_MS);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      clearTimeout(timerRef.current);
    };
  }, [applyBuild]);

  return { graph, loading, error, refresh };
}
