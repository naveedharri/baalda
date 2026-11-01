// SPDX-License-Identifier: Apache-2.0
//
// Seamless keys F: a person's password unlocks their account key, so a stolen
// database alone must not be enough to test passwords offline. Login hashes
// are peppered with a server-only secret, ACCOUNT_KEY_PEPPER (base64, >= 32
// bytes), never stored in the database and never derived from JWT_SECRET.
//
// UNSET: everything here is off and login hashing is byte-for-byte as before
// (plain argon2id). SET: new hashes are `p1$` + argon2id(password, secret =
// HKDF(pepper, "baalda-login-pepper-v1")); old unpeppered hashes still verify
// and are rehashed in place after a successful sign-in. The pepper must never
// rotate: changing or losing it breaks every `p1$` login.
//
// Never log a password, a hash, the pepper or an unlock key.
import { createHmac, hkdfSync } from "node:crypto";
import { Algorithm, hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { pool } from "../db/pool.js";

const argonOpts = { algorithm: Algorithm.Argon2id } as const;
export const PEPPERED_PREFIX = "p1$";
export const PASSWORD_UNLOCK_OFF = "password_unlock_off";

let warnedBadPepper = false;

/** The pepper, or null when F is off. Read per call so tests can stub the env. */
export function accountKeyPepper(): Buffer | null {
  const raw = (process.env.ACCOUNT_KEY_PEPPER ?? "").trim();
  if (!raw) return null;
  const buf = /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)
    ? Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    : Buffer.alloc(0);
  if (buf.length < 32) {
    // Fail safe: an unusable pepper is treated as unset (old hashing, unlock
    // off) rather than hashing passwords under a weak or garbled secret.
    if (!warnedBadPepper) {
      warnedBadPepper = true;
      console.error("[auth] ACCOUNT_KEY_PEPPER must be base64 of at least 32 bytes; password unlock is OFF");
    }
    return null;
  }
  return buf;
}

function loginSecret(pepper: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.alloc(0), "baalda-login-pepper-v1", 32));
}

/** Better Auth's `password.hash`. Pepper unset: exactly the previous hash. */
export async function hashPassword(password: string): Promise<string> {
  const pepper = accountKeyPepper();
  if (!pepper) return argonHash(password, argonOpts);
  return PEPPERED_PREFIX + (await argonHash(password, { ...argonOpts, secret: loginSecret(pepper) }));
}

/** Better Auth's `password.verify`. A `p1$` hash cannot verify without the pepper. */
export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (hash.startsWith(PEPPERED_PREFIX)) {
    const pepper = accountKeyPepper();
    if (!pepper) return false;
    return argonVerify(hash.slice(PEPPERED_PREFIX.length), password, { secret: loginSecret(pepper) });
  }
  return argonVerify(hash, password);
}

/**
 * After a successful password check: an unpeppered credential hash is
 * replaced by a `p1$` one, only if it still is the hash that was checked.
 * Best-effort; pepper unset does nothing.
 */
export async function upgradeLoginHash(by: { email?: string; userId?: string }, password: string): Promise<boolean> {
  if (!accountKeyPepper()) return false;
  try {
    const { rows } = await pool.query<{ id: string; password: string | null }>(
      by.userId
        ? `SELECT id, password FROM account WHERE "userId" = $1 AND "providerId" = 'credential' LIMIT 1`
        : `SELECT a.id, a.password FROM account a JOIN "user" u ON u.id = a."userId"
            WHERE lower(u.email) = lower($1) AND a."providerId" = 'credential' LIMIT 1`,
      [by.userId ?? by.email],
    );
    const row = rows[0];
    if (!row?.password || row.password.startsWith(PEPPERED_PREFIX)) return false;
    if (!(await argonVerify(row.password, password))) return false;
    const next = await hashPassword(password);
    const { rowCount } = await pool.query(
      `UPDATE account SET password = $3, "updatedAt" = now() WHERE id = $1 AND password = $2`,
      [row.id, row.password, next],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.error(`[auth] login hash upgrade failed: ${(err as Error).name}`);
    return false;
  }
}

/**
 * The password changed (change-password, reset, admin set): the account key's
 * password wrap sits under the OLD password's unlock key and can never open
 * again. Clear it, so `GET /me/keys` never reports a dead wrap as the "lost
 * laptop is recoverable by password" fact the desktop's conversion rule reads;
 * a device holding the key writes a fresh one at its next password sign-in.
 * Never called by `upgradeLoginHash` (same password, same unlock key).
 */
export async function clearPasswordWrap(userId: string, db: Pick<typeof pool, "query"> = pool): Promise<void> {
  await db.query(
    `UPDATE user_keys SET priv_wrapped_password = NULL, password_wrap_at = NULL
      WHERE user_id = $1 AND priv_wrapped_password IS NOT NULL`,
    [userId],
  );
}

/**
 * unlockKey = HKDF-SHA256(ikm = HMAC-SHA256(pepper, utf8(password)),
 * salt = utf8(userId), info = utf8("baalda-account-unlock-v1")), 32 bytes.
 */
export function deriveUnlockKey(pepper: Buffer, userId: string, password: string): Buffer {
  const ikm = createHmac("sha256", pepper).update(password, "utf8").digest();
  const out = Buffer.from(hkdfSync("sha256", ikm, Buffer.from(userId, "utf8"), "baalda-account-unlock-v1", 32));
  ikm.fill(0);
  return out;
}
