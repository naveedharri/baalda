/**
 * Refusals the server gave a blob upload that retrying cannot change, kept
 * BEYOND one `AttachmentSync` instance.
 *
 * `AttachmentSync` is rebuilt on every session start (launch, vault open,
 * sign-in), and its own `permanentSkips` died with it — so a file over the
 * size cap (413), an intent the server can never accept (400), or extracted
 * text a view-only member may not write (403) was asked again on every start.
 * Production saw each of those ~100 times in 48 h from a handful of Macs.
 *
 * Keys carry the content identity (sha256, or the blob id for text, which
 * names bytes), so a changed file is a new key and is tried again at once.
 * Every entry also expires ({@link REFUSAL_TTL_MS}): a server limit or an
 * access level can change, and a refusal is never a verdict forever. The
 * user's Retry and an access change forget the relevant entries sooner.
 *
 * In the app the store is backed by `localStorage` (one JSON object, bounded).
 * Without it (vitest's node env, a blocked storage) {@link defaultRefusalStore}
 * hands each caller a private in-memory store, which is exactly the old
 * per-instance behaviour.
 */

/** How long a refusal stands before the next session may ask once more. */
export const REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on remembered refusals; the soonest-expiring go first. */
export const REFUSAL_MAX_ENTRIES = 2000;
// v2 (2026-11-22): v1 held `400 invalid_rel_path` refusals for files sent
// before the local index had given them an id, which kept most of a dropped
// repo from syncing for a day. Starting fresh asks each refusal once more.
const STORAGE_KEY = "context.blobRefusals.v2";

export interface RefusalStore {
  has(key: string): boolean;
  add(key: string): void;
  delete(key: string): void;
  /** Forget every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void;
}

/** The byte upload's verdict for these bytes (413/415/400/403 at intent). */
export function bytesRefusalKey(sha256: string): string {
  return `bytes:${sha256.toLowerCase()}`;
}

/** Extracted text refused for this blob (403: no write access to it). */
export function textRefusalKey(blobId: string): string {
  return `text:${blobId}`;
}
export const TEXT_REFUSAL_PREFIX = "text:";

interface Backing {
  load(): Record<string, number> | null;
  save(entries: Record<string, number>): void;
}

export function createRefusalStore(
  backing: Backing | null = null,
  now: () => number = () => Date.now(),
  ttlMs = REFUSAL_TTL_MS,
): RefusalStore {
  const entries = new Map<string, number>();
  if (backing) {
    try {
      const raw = backing.load();
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "number" && Number.isFinite(v)) entries.set(k, v);
        }
      }
    } catch {
      // Unreadable storage: start empty.
    }
  }
  const persist = () => {
    if (!backing) return;
    try {
      backing.save(Object.fromEntries(entries));
    } catch {
      // Storage full or blocked: the in-memory copy still answers.
    }
  };
  const live = (key: string): boolean => {
    const until = entries.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    entries.delete(key);
    persist();
    return false;
  };
  return {
    has: live,
    add(key) {
      entries.set(key, now() + ttlMs);
      if (entries.size > REFUSAL_MAX_ENTRIES) {
        const t = now();
        for (const [k, v] of entries) if (v <= t) entries.delete(k);
        const sorted = [...entries].sort((a, b) => a[1] - b[1]);
        while (entries.size > REFUSAL_MAX_ENTRIES && sorted.length) entries.delete(sorted.shift()![0]);
      }
      persist();
    },
    delete(key) {
      if (entries.delete(key)) persist();
    },
    deletePrefix(prefix) {
      let changed = false;
      for (const k of [...entries.keys()]) {
        if (k.startsWith(prefix)) {
          entries.delete(k);
          changed = true;
        }
      }
      if (changed) persist();
    },
  };
}

function localStorageBacking(): Backing | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    // Probe: a private window or blocked site data throws here.
    ls.getItem(STORAGE_KEY);
    return {
      load: () => {
        const s = ls.getItem(STORAGE_KEY);
        return s ? (JSON.parse(s) as Record<string, number>) : null;
      },
      save: (e) => ls.setItem(STORAGE_KEY, JSON.stringify(e)),
    };
  } catch {
    return null;
  }
}

/**
 * A view of `base` whose keys all carry `scope` (server URL + vault id): a 400
 * or a 403 is an answer from ONE server about ONE vault, and must not suppress
 * the same bytes or blob id against another server or vault for the TTL.
 */
export function scopedRefusalStore(base: RefusalStore, scope: string): RefusalStore {
  const p = `${scope}|`;
  return {
    has: (key) => base.has(p + key),
    add: (key) => base.add(p + key),
    delete: (key) => base.delete(p + key),
    deletePrefix: (prefix) => base.deletePrefix(p + prefix),
  };
}

let shared: RefusalStore | null = null;

/** The app-wide persistent store, or a private in-memory one without storage. */
export function defaultRefusalStore(): RefusalStore {
  const backing = localStorageBacking();
  if (!backing) return createRefusalStore();
  if (!shared) shared = createRefusalStore(backing);
  return shared;
}
