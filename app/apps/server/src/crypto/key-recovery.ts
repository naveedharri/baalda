// SPDX-License-Identifier: Apache-2.0
//
// Launch safety net: a recovery copy of every vault key, sealed to an OFFLINE
// public key (decided 2026-11-01, on until the owner switches it off).
//
// While `KEY_RECOVERY_PUBLIC_KEY` is set, the first time this process holds a
// verified key for a vault (the key cache's acquire event), it seals that key
// to the recovery public key and stores it in `vault_key_recovery`. The
// matching private key never reaches the server: only `scripts/key-recovery.ts`
// on the owner's own computer opens a copy, then re-issues the key to a locked-
// out member through `POST /api/admin/key-recovery/:vaultId/grant`. A stolen
// database or backup holds sealed copies nobody can open.
//
// Unset the variable to switch it off: no new copies, and every row is deleted
// at boot and hourly. Honest limit while it is on: whoever holds the offline
// key can read any vault, which the website must say during the launch period.
// The sealing format lives in `recovery-seal.ts`.

import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeyCache } from "./key-cache.js";
import { recoveryKeyFingerprint, sealForRecovery } from "./recovery-seal.js";
import { loadVkCheck } from "./transport.js";
import { verifyVk } from "./vk-check.js";

export { openRecoveryCopy, recoveryKeyFingerprint, sealForRecovery } from "./recovery-seal.js";

type Queryable = Pick<pg.Pool, "query">;

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

let warnedBadKey = false;

/** The recovery public key (raw 32 bytes), or null when the safety net is off. */
export function recoveryPublicKey(): Buffer | null {
  const raw = (process.env.KEY_RECOVERY_PUBLIC_KEY ?? "").trim();
  if (!raw) return null;
  const buf = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (buf.length !== 32) {
    if (!warnedBadKey) {
      warnedBadKey = true;
      console.error("[key-recovery] KEY_RECOVERY_PUBLIC_KEY must be base64 of a 32-byte X25519 key; recovery is OFF");
    }
    return null;
  }
  return buf;
}

/** Copies stored this process lifetime, so a busy vault costs one query, not one per acquire. */
const deposited = new Set<string>();

/**
 * Store a recovery copy for this vault's cached key unless one exists for its
 * generation under the current recovery key. Re-verifies the key against
 * `vk_check` first, so a disagreeing key is never deposited. Never throws.
 */
export async function depositRecoveryCopy(vaultId: string, db: Queryable = defaultPool): Promise<boolean> {
  const recipient = recoveryPublicKey();
  if (!recipient) return false;
  const fp = recoveryKeyFingerprint(recipient);
  const held = vaultKeyCache.get(vaultId);
  if (!held) return false;
  const memo = `${vaultId}|${held.generation}|${fp}`;
  try {
    if (deposited.has(memo)) return false;
    const state = await loadVkCheck(vaultId, db);
    if (!state || state.generation !== held.generation || !verifyVk(held.key, vaultId, state.vkCheck)) return false;
    const sealed = sealForRecovery(held.key, recipient, vaultId, held.generation);
    const { rowCount } = await db.query(
      `INSERT INTO vault_key_recovery (vault_id, generation, recovery_key_fp, sealed_vk)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [vaultId, held.generation, fp, sealed],
    );
    deposited.add(memo);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error(`[key-recovery] deposit for vault ${vaultId} failed: ${(err as Error).message}`);
    return false;
  } finally {
    held.key.fill(0);
  }
}

/** Switched off: delete every copy. Returns how many were removed. */
export async function purgeRecoveryCopies(db: Queryable = defaultPool): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM vault_key_recovery");
  deposited.clear();
  return rowCount ?? 0;
}

let unsubscribe: (() => void) | null = null;
let purgeTimer: ReturnType<typeof setInterval> | null = null;

async function purgeIfOff(): Promise<void> {
  if (recoveryPublicKey()) return;
  try {
    const n = await purgeRecoveryCopies();
    if (n > 0) console.log(`[key-recovery] off: deleted ${n} recovery copies`);
  } catch (err) {
    console.error(`[key-recovery] purge failed: ${(err as Error).message}`);
  }
}

/** Started from index.ts: deposit on every key acquire while on; purge while off. */
export function startKeyRecovery(): void {
  const pub = recoveryPublicKey();
  if (pub) {
    console.log(`[key-recovery] ON (recovery key ${recoveryKeyFingerprint(pub)}): vault keys get a sealed recovery copy`);
    unsubscribe ??= vaultKeyCache.onAcquire((vaultId) => void depositRecoveryCopy(vaultId));
  }
  void purgeIfOff();
  purgeTimer ??= setInterval(() => void purgeIfOff(), PURGE_INTERVAL_MS);
  purgeTimer.unref?.();
}

export function stopKeyRecovery(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = null;
}
