// SPDX-License-Identifier: Apache-2.0
// The account-key pepper is settled at boot: env wins, a self-host with vault
// keys on gets a generated one kept in the database, and a changed or missing
// pepper stops the boot instead of breaking every peppered sign-in.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { accountKeyPepper, useStoredPepper } from "../src/auth/login-pepper.js";
import { PepperMismatchError, resolvePepperAtBoot } from "../src/auth/pepper-boot.js";
import { resetDb } from "./helpers/db.js";

const b64 = (b: Buffer) => b.toString("base64");
const secrets = async () => (await pool.query("SELECT 1 FROM server_secrets")).rowCount;

describe("account-key pepper at boot", () => {
  beforeEach(async () => {
    await resetDb();
    useStoredPepper(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    useStoredPepper(null);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("vault keys off, nothing set: stays off and generates nothing (self-host default)", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect(await resolvePepperAtBoot()).toBe("off");
    expect(accountKeyPepper()).toBeNull();
    expect(await secrets()).toBe(0);
  });

  it("vault keys on, nothing set: generates one once, keeps it across boots, never on a later boot again", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    expect(await resolvePepperAtBoot()).toBe("generated");
    const first = accountKeyPepper();
    expect(first?.length).toBe(32);
    useStoredPepper(null);
    expect(await resolvePepperAtBoot()).toBe("stored");
    expect(accountKeyPepper()!.equals(first!)).toBe(true);
    expect(await secrets()).toBe(1);
    // Vault keys switched off later: the stored pepper still verifies p1$ logins.
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    useStoredPepper(null);
    expect(await resolvePepperAtBoot()).toBe("stored");
    expect(accountKeyPepper()!.equals(first!)).toBe(true);
  });

  it("env pepper: used, fingerprinted, never stored; a changed or removed one refuses to boot", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    const env = randomBytes(32);
    vi.stubEnv("ACCOUNT_KEY_PEPPER", b64(env));
    expect(await resolvePepperAtBoot()).toBe("env");
    expect(accountKeyPepper()!.equals(env)).toBe(true);
    expect(await secrets()).toBe(0);
    const fp = await pool.query("SELECT fingerprint FROM server_secret_fingerprints");
    expect(fp.rows[0].fingerprint).not.toContain(b64(env));

    vi.stubEnv("ACCOUNT_KEY_PEPPER", b64(randomBytes(32)));
    await expect(resolvePepperAtBoot()).rejects.toBeInstanceOf(PepperMismatchError);
    vi.stubEnv("ACCOUNT_KEY_PEPPER", "");
    await expect(resolvePepperAtBoot()).rejects.toBeInstanceOf(PepperMismatchError);
    vi.stubEnv("ACCOUNT_KEY_PEPPER", "not-base64-and-too-short");
    await expect(resolvePepperAtBoot()).rejects.toBeInstanceOf(PepperMismatchError);
    // Nothing was generated over the missing env pepper.
    expect(await secrets()).toBe(0);
    vi.stubEnv("ACCOUNT_KEY_PEPPER", b64(env));
    expect(await resolvePepperAtBoot()).toBe("env");
  });

  it("an env pepper set over a generated one refuses to boot", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resolvePepperAtBoot();
    vi.stubEnv("ACCOUNT_KEY_PEPPER", b64(randomBytes(32)));
    await expect(resolvePepperAtBoot()).rejects.toThrow(/automatically generated/);
  });
});
