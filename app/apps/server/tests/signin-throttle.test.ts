import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { clearThrottle } from "../src/auth/signin-throttle.js";

/** Issue #237: failed sign-ins are throttled per account, from any IP. */
const app = createApp(testAppDeps());

function attempt(email: string, password: string, ip: string) {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip, origin: "http://localhost" },
    body: JSON.stringify({ email, password }),
  });
}

async function failN(email: string, n: number) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await attempt(email, "wrong-password-x", `10.0.0.${i + 1}`)).status);
  return statuses;
}

describe("sign-in throttle", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("locks the account after 5 failures; the 6th from a different IP gets 429 + Retry-After", async () => {
    await signUp("victim@example.com", "correct-horse-battery");
    expect(await failN("victim@example.com", 5)).toEqual([401, 401, 401, 401, 401]);

    // Even the RIGHT password from a fresh IP is refused while locked.
    const res = await attempt("Victim@Example.com", "correct-horse-battery", "192.168.99.99");
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it("escalates the lockout 1 min → 5 min → 15 min", async () => {
    const email = "ladder@example.com";
    const expected = [60, 300, 900, 900];
    for (const cap of expected) {
      await failN(email, 5);
      const res = await attempt(email, "x-wrong-pass", "10.9.9.9");
      expect(res.status).toBe(429);
      const retry = Number(res.headers.get("retry-after"));
      expect(retry).toBeGreaterThan(cap - 5);
      expect(retry).toBeLessThanOrEqual(cap);
      // Expire the lock (but keep its lockout count) to try the next rung.
      await pool.query(`UPDATE signin_throttle SET locked_until = now() - interval '1 second'`);
    }
  });

  it("a successful sign-in resets the failure count", async () => {
    await signUp("reset@example.com", "correct-horse-battery");
    await failN("reset@example.com", 4);
    expect((await attempt("reset@example.com", "correct-horse-battery", "10.1.1.1")).status).toBe(200);
    // The count restarted: four more failures still do not lock.
    expect(await failN("reset@example.com", 4)).toEqual([401, 401, 401, 401]);
    expect((await attempt("reset@example.com", "correct-horse-battery", "10.1.1.2")).status).toBe(200);
  });

  it("clearing (password reset) lifts an active lockout", async () => {
    await signUp("forgot@example.com", "correct-horse-battery");
    await failN("forgot@example.com", 5);
    expect((await attempt("forgot@example.com", "correct-horse-battery", "10.2.2.2")).status).toBe(429);
    await clearThrottle("forgot@example.com");
    expect((await attempt("forgot@example.com", "correct-horse-battery", "10.2.2.3")).status).toBe(200);
  });

  it("an unknown email behaves identically to a real one", async () => {
    await signUp("real@example.com", "correct-horse-battery");
    const real = await failN("real@example.com", 5);
    const ghost = await failN("ghost@example.com", 5);
    expect(ghost).toEqual(real);

    const a = await attempt("real@example.com", "whatever-pass", "172.16.0.1");
    const b = await attempt("ghost@example.com", "whatever-pass", "172.16.0.2");
    expect(b.status).toBe(a.status);
    expect(a.status).toBe(429);
    expect(b.headers.get("retry-after")).toBe(a.headers.get("retry-after"));
    const ab = (await a.json()) as Record<string, unknown>;
    const bb = (await b.json()) as Record<string, unknown>;
    expect(bb).toEqual(ab);
  });
});
