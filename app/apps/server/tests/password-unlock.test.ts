// SPDX-License-Identifier: Apache-2.0
//
// Seamless keys F: the password unlocks the account key. Peppered login
// hashes (`p1$`), in-place rehash after sign-in, `POST /me/keys/unlock`
// sharing the sign-in throttle, and `PUT /me/keys/password-wrap`.
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { memoryOutbox } from "../src/email/mailer.js";
import { __clearResetThrottle } from "../src/http/routes/password-reset.js";
import { MAX_FAILURES } from "../src/auth/signin-throttle.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signIn, signUp, type TestUser } from "./helpers/auth.js";

const app = createApp(testAppDeps());
const PEPPER = randomBytes(32);
const b64 = (b: Buffer) => b.toString("base64");

function call(user: TestUser | null, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...(user ? authHeaders(user) : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function storedHash(userId: string): Promise<string> {
  const { rows } = await pool.query<{ password: string }>(
    `SELECT password FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
    [userId],
  );
  return rows[0].password;
}

function expectedUnlockKey(userId: string, password: string): string {
  const ikm = createHmac("sha256", PEPPER).update(password, "utf8").digest();
  return b64(Buffer.from(hkdfSync("sha256", ikm, Buffer.from(userId, "utf8"), "baalda-account-unlock-v1", 32)));
}

describe("password unlocks the account key (F)", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("ACCOUNT_KEY_PEPPER", b64(PEPPER));
    await resetDb();
    memoryOutbox.length = 0;
    __clearResetThrottle();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.end();
  });

  it("pepper unset: login hashing is plain argon2id and unlock / password-wrap answer 503", async () => {
    vi.stubEnv("ACCOUNT_KEY_PEPPER", "");
    const u = await signUp("plain@unlock.test", "password-plain-1");
    const h = await storedHash(u.userId);
    expect(h.startsWith("$argon2id$")).toBe(true);
    await signIn("plain@unlock.test", "password-plain-1");
    expect(await storedHash(u.userId)).toBe(h); // no rehash
    const res = await call(u, "POST", "/api/me/keys/unlock", { password: "password-plain-1" });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("password_unlock_off");
    expect((await call(u, "PUT", "/api/me/keys/password-wrap", { privWrapped: b64(randomBytes(80)) })).status).toBe(503);
  });

  it("sign-up and password reset store p1$ hashes that sign in", async () => {
    const u = await signUp("pep@unlock.test", "password-pep-1");
    expect((await storedHash(u.userId)).startsWith("p1$$argon2id$")).toBe(true);
    await signIn("pep@unlock.test", "password-pep-1");

    expect((await call(null, "POST", "/api/password-reset/request", { email: "pep@unlock.test" })).status).toBe(200);
    const mail = [...memoryOutbox].reverse().find((m) => m.to === "pep@unlock.test" && /reset/i.test(m.subject))!;
    const token = mail.text.match(/\/reset-password\?token=([A-Za-z0-9._-]+)/)![1];
    const before = await storedHash(u.userId);
    expect((await call(null, "POST", "/api/auth/reset-password", { newPassword: "password-pep-2", token })).status).toBe(200);
    const after = await storedHash(u.userId);
    expect(after).not.toBe(before);
    expect(after.startsWith("p1$")).toBe(true);
    await signIn("pep@unlock.test", "password-pep-2");

    // A p1$ hash never verifies without the pepper (fails closed, no crash).
    vi.stubEnv("ACCOUNT_KEY_PEPPER", "");
    await expect(signIn("pep@unlock.test", "password-pep-2")).rejects.toThrow();
  });

  it("an old unpeppered hash still signs in and is rehashed to p1$ after success; a failure never rehashes", async () => {
    const u = await signUp("old@unlock.test", "password-old-1");
    const legacy = await argonHash("password-old-1", { algorithm: Algorithm.Argon2id });
    await pool.query(`UPDATE account SET password = $2 WHERE "userId" = $1 AND "providerId" = 'credential'`, [
      u.userId,
      legacy,
    ]);
    const bad = await call(null, "POST", "/api/auth/sign-in/email", { email: "old@unlock.test", password: "nope-nope-1" });
    expect(bad.status).toBe(401);
    expect(await storedHash(u.userId)).toBe(legacy);
    const ok = await call(null, "POST", "/api/auth/sign-in/email", { email: "Old@Unlock.test", password: "password-old-1" });
    expect(ok.status).toBe(200);
    const upgraded = await storedHash(u.userId);
    expect(upgraded.startsWith("p1$")).toBe(true);
    await signIn("old@unlock.test", "password-old-1");
  });

  it("unlock: right password → the contract's unlockKey; wrong one counts in the sign-in throttle and locks", async () => {
    const u = await signUp("lock@unlock.test", "password-lock-1");
    const ok = await call(u, "POST", "/api/me/keys/unlock", { password: "password-lock-1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ unlockKey: expectedUnlockKey(u.userId, "password-lock-1") });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const bad = await call(u, "POST", "/api/me/keys/unlock", { password: `wrong-${i}` });
      expect(bad.status).toBe(401);
      expect((await bad.json()).code).toBe("wrong_password");
    }
    const locked = await call(u, "POST", "/api/me/keys/unlock", { password: "password-lock-1" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    // The same lock applies to email sign-in (shared throttle).
    const signin = await call(null, "POST", "/api/auth/sign-in/email", { email: "lock@unlock.test", password: "password-lock-1" });
    expect(signin.status).toBe(429);
  });


  it("50 simultaneous wrong unlocks get at most 5 password checks; the rest 429", async () => {
    const u = await signUp("burst@unlock.test", "password-burst-1");
    const statuses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => call(u, "POST", "/api/me/keys/unlock", { password: `wrong-${i}` }).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(45);
  });
  it("unlock: Google-only account → 409 no_password; no session → 401", async () => {
    const u = await signUp("google@unlock.test", "password-g-1");
    await pool.query(`DELETE FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`, [u.userId]);
    const res = await call(u, "POST", "/api/me/keys/unlock", { password: "password-g-1" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_password");
    expect((await call(null, "POST", "/api/me/keys/unlock", { password: "x" })).status).toBe(401);
  });

  it("password-wrap: needs an account key; round-trips in GET /me/keys; moves to history on key replacement", async () => {
    const u = await signUp("wrap@unlock.test", "password-wrap-1");
    const wrap = b64(randomBytes(96));
    const none = await call(u, "PUT", "/api/me/keys/password-wrap", { privWrapped: wrap });
    expect(none.status).toBe(409);
    expect((await call(u, "PUT", "/api/me/keys", { publicKey: b64(randomBytes(32)) })).status).toBe(200);
    expect(await (await call(u, "GET", "/api/me/keys")).json()).toMatchObject({ privWrappedPassword: null });
    const stored = await call(u, "PUT", "/api/me/keys/password-wrap", { privWrapped: wrap });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ stored: true });
    expect(await (await call(u, "GET", "/api/me/keys")).json()).toMatchObject({ privWrappedPassword: wrap });

    // Lost every device: the account key is replaced. The old password wrap
    // is kept in history and cleared on the live row.
    expect((await call(u, "PUT", "/api/me/keys", { publicKey: b64(randomBytes(32)) })).status).toBe(200);
    expect(await (await call(u, "GET", "/api/me/keys")).json()).toMatchObject({ privWrappedPassword: null });
    const { rows } = await pool.query("SELECT priv_wrapped_password FROM user_key_history WHERE user_id = $1", [u.userId]);
    expect(rows.map((r) => r.priv_wrapped_password?.toString("base64"))).toEqual([wrap]);
  });
});
