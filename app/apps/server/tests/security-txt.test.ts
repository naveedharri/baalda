import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp, securityTxt } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";

const app = createApp(testAppDeps());

describe("/.well-known/security.txt", () => {
  const prev = process.env.SECURITY_CONTACT;
  afterEach(() => {
    if (prev === undefined) delete process.env.SECURITY_CONTACT;
    else process.env.SECURITY_CONTACT = prev;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("404s when SECURITY_CONTACT is unset", async () => {
    delete process.env.SECURITY_CONTACT;
    const res = await app.request("/.well-known/security.txt");
    expect(res.status).toBe(404);
  });

  it("serves the RFC 9116 fields when configured", async () => {
    process.env.SECURITY_CONTACT = "mailto:security@example.com";
    const res = await app.request("/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Contact: mailto:security@example.com");
    expect(body).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
    expect(body).toContain("Policy: https://github.com/");
    expect(body).toContain("Preferred-Languages: en");
  });

  it("expires one year out and ignores a blank contact", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(securityTxt("mailto:a@b.c", now)).toContain("Expires: 2027-01-01T00:00:00.000Z");
    expect(securityTxt("  ", now)).toBeNull();
  });
});
