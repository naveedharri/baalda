/**
 * The per-vault property type registry, cached in memory.
 *
 * Lives in `.context/types.json` beside the doc-id map, so it travels with the
 * vault folder and never enters the `.md` file, the CRDT or the server — the
 * CLAUDE.md rule for per-vault UI config. The consequence, worth knowing: a
 * teammate on another machine infers types from the YAML's shape until they set
 * their own. That is what Obsidian does too, and it is called out in the release
 * notes rather than hidden.
 *
 * Writes are rare (an explicit type change) so a short debounce is enough; no
 * checkpoint machinery. Reads are served from the cache, which every open panel
 * subscribes to, so a change in one note repaints the panel in another.
 */

import * as ipc from "../ipc";
import type { PropertyType } from "./infer";
import { inferType, isFixedType } from "./infer";
import type { PropValue } from "./parse";

interface TypesFile {
  version: 1;
  types: Record<string, PropertyType>;
}

const VALID: ReadonlySet<string> = new Set([
  "text",
  "list",
  "number",
  "checkbox",
  "date",
  "datetime",
  "tags",
  "aliases",
]);

const WRITE_DEBOUNCE_MS = 400;

let cache: Record<string, PropertyType> = {};
/** The vault epoch the cache belongs to; a switch invalidates it. */
let loadedEpoch: number | null = null;
let loading: Promise<void> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const fn of [...listeners]) fn();
}

/** Re-render every open panel when the registry changes. */
export function subscribeTypes(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function parseFile(raw: string | null): Record<string, PropertyType> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<TypesFile>;
    const out: Record<string, PropertyType> = {};
    for (const [key, value] of Object.entries(parsed?.types ?? {})) {
      if (typeof value === "string" && VALID.has(value)) {
        out[key] = value as PropertyType;
      }
    }
    return out;
  } catch {
    // A corrupt registry is a cosmetic loss (types fall back to inference), so
    // it must never surface as an error over the note.
    return {};
  }
}

/**
 * Load the registry for `epoch` if it isn't cached already. Safe to call on
 * every panel mount: concurrent callers share one in-flight read.
 */
export function loadTypes(epoch: number | undefined): Promise<void> {
  const at = epoch ?? null;
  if (loadedEpoch === at && !loading) return Promise.resolve();
  if (loading) return loading;
  loading = ipc
    .getVaultTypes(epoch)
    .then((raw) => {
      cache = parseFile(raw);
      loadedEpoch = at;
      announce();
    })
    .catch(() => {
      cache = {};
      loadedEpoch = at;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Forget everything — called when the open vault changes. */
export function resetTypes(): void {
  cache = {};
  loadedEpoch = null;
  announce();
}

/**
 * The type to render a property with: the registry's answer, else the YAML's
 * shape. `tags` is pinned (see `isFixedType`) because Rust's tag index reads it.
 */
export function typeFor(key: string, value: PropValue): PropertyType {
  if (isFixedType(key)) return "tags";
  const set = cache[key];
  return set ?? inferType(key, value);
}

/** Has this key been typed explicitly (rather than inferred)? */
export function hasExplicitType(key: string): boolean {
  return cache[key] !== undefined;
}

/** Record a type for a key and schedule the write. Optimistic: the cache (and
 *  therefore the panel) updates now, the file catches up. */
export function setType(key: string, type: PropertyType, epoch?: number): void {
  if (isFixedType(key)) return;
  if (cache[key] === type) return;
  cache = { ...cache, [key]: type };
  announce();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const body: TypesFile = { version: 1, types: cache };
    void ipc
      .setVaultTypes(JSON.stringify(body, null, 2), epoch)
      .catch((e) => console.warn("[properties] could not save types.json", e));
  }, WRITE_DEBOUNCE_MS);
}

/** Test seam: the whole registry as it currently stands. */
export function typesSnapshot(): Record<string, PropertyType> {
  return { ...cache };
}
