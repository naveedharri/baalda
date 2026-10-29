// SPDX-License-Identifier: Apache-2.0
//
// Per-process, in-memory vault key cache (W3). Keys are NEVER persisted.
//
// A connection that presented a verified key `acquire`s it and calls the
// returned release when it closes. While any holder remains, plus a grace
// period after the last release, `get` returns the key — for SERVER-INTERNAL
// background work only (index queue, compaction, checkpoints, backfill). A user
// request must present its own key and have it checked against `vk_check`; it
// must never be served from this cache, or a session forged through database
// access could read content.
//
// The cache holds its own copy of each key and zeroes it (`fill(0)`) on evict.
import { KEY_BYTES } from "./envelope.js";

export const KEY_CACHE_GRACE_MS = 10 * 60 * 1000;

interface Entry {
  key: Buffer;
  generation: number;
  refs: number;
  /** Set when refs reaches 0; the entry is evicted at or after this time. */
  expiresAt: number | null;
}

export interface KeyCacheOptions {
  graceMs?: number;
  now?: () => number;
}

export class VaultKeyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(opts: KeyCacheOptions = {}) {
    this.graceMs = opts.graceMs ?? KEY_CACHE_GRACE_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Hold `key` for `vaultId` until the returned release is called (idempotent).
   * A higher generation replaces the cached key (rotation); a lower one is
   * held but does not replace it. The caller must have verified the key.
   */
  acquire(vaultId: string, key: Buffer, generation = 1): () => void {
    if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
    this.sweep();
    let entry = this.entries.get(vaultId);
    if (!entry) {
      entry = { key: Buffer.from(key), generation, refs: 0, expiresAt: null };
      this.entries.set(vaultId, entry);
    } else if (generation > entry.generation) {
      entry.key.fill(0);
      entry.key = Buffer.from(key);
      entry.generation = generation;
    } else if (generation === entry.generation && !entry.key.equals(key)) {
      throw new Error("key-cache: a different key for the same generation");
    }
    entry.refs += 1;
    entry.expiresAt = null;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // The entry may have been evicted and replaced; only touch our own.
      if (this.entries.get(vaultId) !== held) return;
      held.refs = Math.max(0, held.refs - 1);
      if (held.refs === 0) held.expiresAt = this.now() + this.graceMs;
    };
  }

  /** INTERNAL background work only — see the header note. */
  get(vaultId: string): { key: Buffer; generation: number } | null {
    this.sweep();
    const entry = this.entries.get(vaultId);
    return entry ? { key: entry.key, generation: entry.generation } : null;
  }

  /** Evict every entry whose grace period has passed. */
  sweep(): void {
    const t = this.now();
    for (const [vaultId, entry] of this.entries) {
      if (entry.refs === 0 && entry.expiresAt !== null && t >= entry.expiresAt) this.evict(vaultId);
    }
  }

  /** Drop a vault's key at once, holders or not (rotation, vault deleted). */
  evict(vaultId: string): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    entry.key.fill(0);
    this.entries.delete(vaultId);
  }

  clear(): void {
    for (const vaultId of [...this.entries.keys()]) this.evict(vaultId);
  }

  get size(): number {
    return this.entries.size;
  }
}

export const vaultKeyCache = new VaultKeyCache();
