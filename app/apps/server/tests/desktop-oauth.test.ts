import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleEnabled } from "../src/auth/auth.js";
import { desktopOauthRoutes } from "../src/http/routes/desktop-oauth.js";
import {
  __clearDesktopCodes,
  mintDesktopCode,
  redeemDesktopCode,
} from "../src/tokens/desktop-code.js";

// Mounts the handoff routes in isolation — these paths (exchange, auth-methods,
// redirect validation) don't touch the DB, so no Postgres is needed.
const app = new Hono().route("/api", desktopOauthRoutes);

describe("desktop one-time code store", () => {
  beforeEach(() => __clearDesktopCodes());

  it("mints then redeems a code exactly once", () => {
    const code = mintDesktopCode({ token: "tok", userId: "u1", email: "a@b.co" });
    expect(code).toBeTruthy();

    const first = redeemDesktopCode(code);
    expect(first).toEqual({ token: "tok", userId: "u1", email: "a@b.co" });

    // Single-use: a second redeem finds nothing.
    expect(redeemDesktopCode(code)).toBeNull();
  });

  it("rejects an unknown code", () => {
    expect(redeemDesktopCode("nope")).toBeNull();
  });

  it("expires a code after its TTL", () => {
    vi.useFakeTimers();
    try {
      const code = mintDesktopCode({ token: "t", userId: "u", email: "e" });
      vi.advanceTimersByTime(61_000); // TTL is 60s
      expect(redeemDesktopCode(code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("desktop-oauth routes", () => {
  beforeEach(() => __clearDesktopCodes());
  afterEach(() => vi.useRealTimers());

  it("exchanges a valid code for the token + user", async () => {
    const code = mintDesktopCode({ token: "sess-tok", userId: "u9", email: "x@y.co" });
    const res = await app.request("/api/desktop-auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: "sess-tok",
      user: { id: "u9", email: "x@y.co" },
    });
  });

  it("rejects an invalid/expired code with 400", async () => {
    const res = await app.request("/api/desktop-auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires a code in the body", async () => {
    const res = await app.request("/api/desktop-auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a non-loopback redirect target (no open redirector)", async () => {
    const res = await app.request(
      "/api/desktop-auth/finish?redirect=" +
        encodeURIComponent("https://evil.example.com/steal"),
    );
    expect(res.status).toBe(400);
  });

  it("reports available auth methods (google gated on server config)", async () => {
    const res = await app.request("/api/auth-methods");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emailPassword: boolean; google: boolean };
    expect(body.emailPassword).toBe(true);
    // google mirrors the server's config (creds present ⇒ true), not a fixed
    // value — so this holds whether or not the dev .env sets GOOGLE_CLIENT_ID.
    expect(body.google).toBe(googleEnabled);
  });
});
