// SPDX-License-Identifier: Apache-2.0
import { pool as defaultPool } from "../db/pool.js";
import { listDeletedReadableDocsInVault, listReadableDocsInVault } from "./vault-docs.js";

type Queryable = Pick<typeof defaultPool, "query">;

/**
 * A short-lived cache of one user's readable sets for one vault — for the
 * Activity feed's DISPLAY listings ONLY (#261): `GET /vaults/:id/trash` and
 * `GET /vaults/:id/shrink-events`. Building a set costs 0.6–2 s on a large vault
 * under load, and those two routes asked for one (or both) every minute from
 * every open app.
 *
 * What it must NEVER serve, and why the API makes that hard:
 *
 *  - Anything that drives a client to remove or keep files: the vault channel's
 *    readable set / `ready.revoked` / `drop`, `GET /api/notes` and its tombstone
 *    answer, `POST /access-check`, the folder tree. A set that is narrower than
 *    the truth reaches the desktop there as a REVOCATION, and a revocation is
 *    removed outright. Those call `listReadableDocsInVault` directly and always
 *    will; nothing here is exported under that name.
 *  - A write gate. Restore, revert and reads of content keep their own
 *    per-doc resolver checks.
 *
 * The opposite risk — a set WIDER than the truth for a moment after a share is
 * revoked — would show a row (a path, a timestamp) the reader just lost. So:
 *
 *  - entries live {@link READABLE_CACHE_TTL_MS} at most;
 *  - every ACL change and every registry change on this instance drops the
 *    vault's entries at once ({@link invalidateReadableCache}, wired in
 *    index.ts beside the broadcasts), so only another instance's change can be
 *    served stale, and only for the TTL;
 *  - membership is NOT cached: both routes check the caller's role first,
 *    uncached, so a removed member is refused immediately.
 */
export const READABLE_CACHE_TTL_MS = 10_000;
/**
 * The TTL in force. Off under vitest by default: the suites write shares with
 * plain SQL (no invalidation hook) and expect the very next listing to see
 * them, which is the "no cache" contract. The cache's own tests turn it on.
 */
let ttlMs = process.env.VITEST ? 0 : READABLE_CACHE_TTL_MS;

/** Tests only: set the TTL (0 disables caching). */
export function setReadableCacheTtl(ms: number): void {
  ttlMs = ms;
}
/** Bound on entries; the oldest go first. A set is a few hundred KB at worst. */
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  value: Promise<Set<string>>;
  /** Bumped by invalidation, so a build that started before it is not stored. */
  generation: number;
}

const entries = new Map<string, Entry>();
const generations = new Map<string, number>();

function genOf(vaultId: string): number {
  return generations.get(vaultId) ?? 0;
}

async function cached(
  kind: "live" | "deleted",
  userId: string,
  vaultId: string,
  db: Queryable,
  now: number,
): Promise<Set<string>> {
  const build = () =>
    kind === "live" ? listReadableDocsInVault(userId, vaultId, db) : listDeletedReadableDocsInVault(userId, vaultId, db);
  if (ttlMs <= 0) return build();
  const key = `${kind}\u0000${vaultId}\u0000${userId}`;
  const gen = genOf(vaultId);
  const hit = entries.get(key);
  if (hit && hit.generation === gen && now - hit.at < ttlMs) return hit.value;
  const value = build();
  const entry: Entry = { at: now, value, generation: gen };
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  // A failed build is never served to the next caller.
  value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return value;
}

/** Live readable set, Activity listings only — see the module comment. */
export function readableDocsForActivity(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
  now: number = Date.now(),
): Promise<Set<string>> {
  return cached("live", userId, vaultId, db, now);
}

/** Deleted-readable set, Activity listings only — see the module comment. */
export function deletedReadableDocsForActivity(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
  now: number = Date.now(),
): Promise<Set<string>> {
  return cached("deleted", userId, vaultId, db, now);
}

/** Drop every cached set for a vault (ACL or structure changed). */
export function invalidateReadableCache(vaultId: string): void {
  generations.set(vaultId, genOf(vaultId) + 1);
  const suffix = `\u0000${vaultId}\u0000`;
  for (const key of [...entries.keys()]) {
    if (key.includes(suffix)) entries.delete(key);
  }
}

/** Tests only. */
export function clearReadableCache(): void {
  entries.clear();
  generations.clear();
}
