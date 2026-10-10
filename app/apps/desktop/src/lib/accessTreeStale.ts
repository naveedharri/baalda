import type { AccessTreeResponse } from "./api";

/**
 * "The vault's structure on the server may have moved" — the signal that keeps
 * an open person Access tab (Board and List) in step with new files, folders
 * and notes. The tab used to load its tree once on mount, so a file dropped
 * into the vault (registered seconds later, after its upload) or a teammate's
 * new folder stayed invisible until the page was reopened.
 *
 * Fired by this device's own registrations (`registry.ts`: a note mapped, a
 * tree binary's `files` id recorded, a folder created) and by every
 * structural `registry-changed` frame from the vault channel (teammates, MCP).
 * Paint only: a listener re-reads; nothing here authorises anything.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function markAccessTreeStale(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (e) {
      console.warn("[access] stale listener failed", e);
    }
  }
}

export function onAccessTreeStale(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Debounce for the re-read: a dropped batch of files is one reload. */
export const ACCESS_TREE_STALE_DEBOUNCE_MS = 1000;
/** A storm (a big import) still reloads at least this often. */
export const ACCESS_TREE_STALE_MAX_WAIT_MS = 5000;

export interface StaleReloader {
  poke(): void;
  dispose(): void;
}

/** Trailing debounce with a ceiling, so a steady stream still lands. */
export function createStaleReloader(
  run: () => void,
  opts: {
    delayMs?: number;
    maxWaitMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  } = {},
): StaleReloader {
  const delay = opts.delayMs ?? ACCESS_TREE_STALE_DEBOUNCE_MS;
  const maxWait = opts.maxWaitMs ?? ACCESS_TREE_STALE_MAX_WAIT_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let firstAt = 0;
  let disposed = false;
  const fire = () => {
    timer = null;
    firstAt = 0;
    if (!disposed) run();
  };
  return {
    poke() {
      if (disposed) return;
      const t = now();
      if (timer !== null) {
        clearTimer(timer);
      } else {
        firstAt = t;
      }
      const wait = Math.max(0, Math.min(delay, firstAt + maxWait - t));
      timer = setTimer(fire, wait);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * True when two listings name the same items at the same paths. A background
 * re-read that finds nothing new is dropped, so it can never overwrite an
 * optimistic mode a write just painted.
 */
export function sameAccessTreeItems(a: AccessTreeResponse | null, b: AccessTreeResponse | null): boolean {
  if (!a || !b) return a === b;
  const key = (t: AccessTreeResponse): string[] => [
    ...t.folders.map((f) => `d:${f.id}:${f.path}`),
    ...t.notes.map((n) => `n:${n.id}:${n.relPath}`),
    ...(t.files ?? []).map((f) => `f:${f.id}:${f.path}`),
  ];
  const ka = key(a);
  const kb = key(b);
  if (ka.length !== kb.length) return false;
  const set = new Set(ka);
  return kb.every((k) => set.has(k));
}
