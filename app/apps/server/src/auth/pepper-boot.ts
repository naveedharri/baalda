// SPDX-License-Identifier: Apache-2.0
//
// Settles the account-key pepper once, at boot (decided 2026-11-01):
//
// - `ACCOUNT_KEY_PEPPER` set: use it (the strong setup: it never touches the
//   database, so a stolen database cannot test passwords).
// - Unset, vault keys on: generate a random one ONCE and keep it in
//   `server_secrets`, so a self-hosted password unlock works out of the box. A
//   container's own disk does not survive a redeploy, hence the database; the
//   cost is that a stolen database then includes it (docs/DEPLOY.md says so).
// - Unset, vault keys off, nothing stored: off, exactly as before.
//
// Either way a one-way fingerprint of the pepper in use is recorded, and the
// server REFUSES TO START when a later boot is given a different pepper, or
// none: every peppered (`p1$`) login would otherwise stop working without a
// word. Messages name the setting, never a value.

import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { vaultKeysEnabled } from "../crypto/config.js";
import { accountKeyPepper, useStoredPepper } from "./login-pepper.js";

type Queryable = Pick<pg.Pool, "query">;

const NAME = "account_key_pepper";

export function pepperFingerprint(pepper: Buffer): string {
  return createHmac("sha256", pepper).update("baalda-pepper-fingerprint-v1").digest("hex").slice(0, 32);
}

export class PepperMismatchError extends Error {}

async function readStored(db: Queryable): Promise<Buffer | null> {
  const { rows } = await db.query<{ value: Buffer }>("SELECT value FROM server_secrets WHERE name = $1", [NAME]);
  return rows[0]?.value ?? null;
}

async function readFingerprint(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM server_secret_fingerprints WHERE name = $1",
    [NAME],
  );
  return rows[0]?.fingerprint ?? null;
}

/**
 * Resolve the pepper for this process. Throws {@link PepperMismatchError} when
 * starting would break peppered logins; the caller lets that stop the boot.
 * Returns where the pepper came from, for one log line.
 */
export async function resolvePepperAtBoot(db: Queryable = defaultPool): Promise<"env" | "stored" | "generated" | "off"> {
  let stored: Buffer | null;
  let recorded: string | null;
  try {
    stored = await readStored(db);
    recorded = await readFingerprint(db);
  } catch (err) {
    // Migration 086 not applied yet: behave exactly as before this change.
    if ((err as { code?: string }).code === "42P01") return accountKeyPepper() ? "env" : "off";
    throw err;
  }
  const envSet = (process.env.ACCOUNT_KEY_PEPPER ?? "").trim() !== "";
  const env = envSet ? accountKeyPepper() : null;

  if (env && stored && !env.equals(stored)) {
    throw new PepperMismatchError(
      "ACCOUNT_KEY_PEPPER is set, but this server already uses an automatically generated pepper. Changing it would " +
        "break every password sign-in. Remove ACCOUNT_KEY_PEPPER to keep the generated one.",
    );
  }

  let source: "env" | "stored" | "generated" | "off" = env ? "env" : stored ? "stored" : "off";
  if (!env && !stored && !envSet && !recorded && vaultKeysEnabled()) {
    await db.query("INSERT INTO server_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [
      NAME,
      randomBytes(32),
    ]);
    // Another instance may have won the insert: everyone uses the stored row.
    stored = await readStored(db);
    source = "generated";
  }
  const effective = env ?? stored;

  if (recorded) {
    if (!effective) {
      throw new PepperMismatchError(
        "ACCOUNT_KEY_PEPPER is missing or unreadable, but this server has peppered sign-ins. Restore the original value: " +
          "without it nobody can sign in with a password.",
      );
    }
    if (pepperFingerprint(effective) !== recorded) {
      throw new PepperMismatchError(
        "ACCOUNT_KEY_PEPPER does not match the one this server has been using. Restore the original value: a different " +
          "one breaks every password sign-in.",
      );
    }
  } else if (effective) {
    await db.query(
      "INSERT INTO server_secret_fingerprints (name, fingerprint) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
      [NAME, pepperFingerprint(effective)],
    );
    const raced = await readFingerprint(db);
    if (raced && raced !== pepperFingerprint(effective)) {
      throw new PepperMismatchError("Another server instance started with a different ACCOUNT_KEY_PEPPER.");
    }
  }

  useStoredPepper(env ? null : stored);
  return source;
}
