// SPDX-License-Identifier: Apache-2.0
//
// Account-key churn brakes (`crypto/key-churn.ts`): key replacements per user
// per day, device registrations / approvals per user per hour. A refusal is
// 429 `rate_limited` with Retry-After and stores nothing.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import {
  MAX_DEVICE_APPROVALS_PER_HOUR,
  MAX_DEVICE_REGISTRATIONS_PER_HOUR,
  MAX_KEY_REPLACEMENTS,
  resetKeyChurn,
  takeKeyChurn,
} from "../src/crypto/key-churn.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";

const app = createApp(testAppDeps());
const key = () => randomBytes(32).toString("base64");

function call(user: TestUser, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...authHeaders(user), "content-type": "application/json", "x-baalda-version": VAULT_KEYS_MIN_DESKTOP },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("account-key churn brakes", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    resetKeyChurn();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyChurn();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("PUT /me/keys: first create and same-key re-PUTs are free; the 4th replacement in a day is 429 and changes nothing", async () => {
    const u = await signUp("churn@keys.test");
    const first = key();
    expect((await call(u, "PUT", "/me/keys", { publicKey: first })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call(u, "PUT", "/me/keys", { publicKey: first })).status).toBe(200);
    let current = first;
    for (let i = 0; i < MAX_KEY_REPLACEMENTS; i++) {
      current = key();
      const res = await call(u, "PUT", "/me/keys", { publicKey: current });
      expect(res.status).toBe(200);
      expect((await res.json()).replaced).toBe(true);
    }
    // Re-PUT of the current key is still idempotent, never counted or refused.
    expect((await call(u, "PUT", "/me/keys", { publicKey: current })).status).toBe(200);
    const refused = await call(u, "PUT", "/me/keys", { publicKey: key() });
    expect(refused.status).toBe(429);
    const retry = Number(refused.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(23 * 3600);
    expect(retry).toBeLessThanOrEqual(24 * 3600);
    const body = await refused.json();
    expect(body.code).toBe("rate_limited");
    expect(body.error).toMatch(/security key was replaced 3 times/);
    // Nothing stored: the current key stands, no extra history row.
    const { rows } = await pool.query("SELECT public_key FROM user_keys WHERE user_id = $1", [u.userId]);
    expect(rows[0].public_key.toString("base64")).toBe(current);
    const hist = await pool.query("SELECT count(*)::int AS n FROM user_key_history WHERE user_id = $1", [u.userId]);
    expect(hist.rows[0].n).toBe(MAX_KEY_REPLACEMENTS);
    // Another user is not affected.
    const other = await signUp("other@keys.test");
    expect((await call(other, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
    expect((await call(other, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
  });

  it("PUT /me/keys: replacements older than 24 h no longer count", async () => {
    const u = await signUp("old@keys.test");
    expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
    for (let i = 0; i < MAX_KEY_REPLACEMENTS; i++) {
      expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
    }
    expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(429);
    await pool.query("UPDATE user_key_history SET replaced_at = now() - interval '25 hours' WHERE user_id = $1", [u.userId]);
    expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
  });

  it("concurrent replacements cannot pass the last slot twice", async () => {
    const u = await signUp("race@keys.test");
    expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
    for (let i = 0; i < MAX_KEY_REPLACEMENTS - 1; i++) {
      expect((await call(u, "PUT", "/me/keys", { publicKey: key() })).status).toBe(200);
    }
    const statuses = (await Promise.all([0, 1, 2].map(() => call(u, "PUT", "/me/keys", { publicKey: key() })))).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const hist = await pool.query("SELECT count(*)::int AS n FROM user_key_history WHERE user_id = $1", [u.userId]);
    expect(hist.rows[0].n).toBe(MAX_KEY_REPLACEMENTS);
  });

  it("POST /me/devices: idempotent repeats are free; register/deny loops hit the hourly cap", async () => {
    const u = await signUp("dev@keys.test");
    const pk = key();
    expect((await call(u, "POST", "/me/devices", { deviceId: "d-0", publicKey: pk })).status).toBe(201);
    for (let i = 0; i < 20; i++) {
      expect((await call(u, "POST", "/me/devices", { deviceId: "d-0", publicKey: pk })).status).toBe(200);
    }
    for (let i = 1; i < MAX_DEVICE_REGISTRATIONS_PER_HOUR; i++) {
      expect((await call(u, "POST", "/me/devices", { deviceId: `d-${i}`, publicKey: key() })).status).toBe(201);
      // Deny it, so the pending cap (5) never answers first.
      expect((await call(u, "DELETE", `/me/devices/d-${i}`)).status).toBe(200);
    }
    const refused = await call(u, "POST", "/me/devices", { deviceId: "d-new", publicKey: key() });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await refused.json();
    expect(body.code).toBe("rate_limited");
    expect(body.error).toMatch(/Try again in/);
    const { rows } = await pool.query("SELECT 1 FROM user_device_registrations WHERE user_id = $1 AND device_id = 'd-new'", [
      u.userId,
    ]);
    expect(rows).toHaveLength(0);
    // The already-registered device still answers its idempotent repeat.
    expect((await call(u, "POST", "/me/devices", { deviceId: "d-0", publicKey: pk })).status).toBe(200);
  });

  it("PUT /me/devices/:id/key: new approvals are capped per hour; a repeat of an existing wrap is not", async () => {
    const u = await signUp("approve@keys.test");
    await pool.query(
      `INSERT INTO user_device_registrations (user_id, device_id, public_key)
       SELECT $1, 'a-' || g, '\\x01'::bytea FROM generate_series(0, $2) g`,
      [u.userId, MAX_DEVICE_APPROVALS_PER_HOUR],
    );
    const wrap = key();
    for (let i = 0; i < MAX_DEVICE_APPROVALS_PER_HOUR; i++) {
      expect((await call(u, "PUT", `/me/devices/a-${i}/key`, { privWrapped: wrap })).status).toBe(200);
    }
    expect((await call(u, "PUT", "/me/devices/a-0/key", { privWrapped: wrap })).status).toBe(200);
    const refused = await call(u, "PUT", `/me/devices/a-${MAX_DEVICE_APPROVALS_PER_HOUR}/key`, { privWrapped: wrap });
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe("rate_limited");
  });

  it("the in-process window frees a slot after an hour", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_DEVICE_REGISTRATIONS_PER_HOUR; i++) expect(takeKeyChurn("device-register", "u", t0).ok).toBe(true);
    const r = takeKeyChurn("device-register", "u", t0 + 1000);
    expect(r.ok).toBe(false);
    expect(takeKeyChurn("device-register", "u", t0 + 60 * 60_000 + 1).ok).toBe(true);
  });
});
