// SPDX-License-Identifier: Apache-2.0
//
// A vault key presented on a request (`X-Baalda-VK`, or a sync token's
// `.<vk>` suffix) must never reach a log line, including the error path, and
// the per-call keys an MCP request unwraps are zeroed when it ends.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { redactKeyFragments, redactToken, VK_HEADER } from "../src/crypto/transport.js";
import { zeroAuthKeys } from "../src/http/routes/mcp.js";
import { __setMailerForTests } from "../src/email/mailer.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp } from "./helpers/auth.js";
import { markEncryptionRequested, seedVault } from "./helpers/seed.js";

function captureLogs(): string[] {
  const logged: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(
        a
          .map((x) =>
            x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === "string" ? x : JSON.stringify(x),
          )
          .join(" "),
      );
    });
  }
  return logged;
}

function forms(vk: Buffer): string[] {
  return [vk.toString("base64"), vk.toString("base64url"), vk.toString("hex")];
}

describe("vault keys never reach the logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("a request carrying x-baalda-vk that throws logs the error, never the key", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    const app = createApp(testAppDeps());
    app.get("/api/__vk-boom", () => {
      throw new Error("boom");
    });
    const logged = captureLogs();
    const vk = randomBytes(32);
    const res = await app.request("/api/__vk-boom", { headers: { [VK_HEADER]: vk.toString("base64") } });
    expect(res.status).toBe(500);
    const all = logged.join("\n");
    expect(all).toContain("boom");
    for (const s of forms(vk)) expect(all.includes(s)).toBe(false);
    expect((await res.text()).includes(vk.toString("base64"))).toBe(false);
  });

  it("redactToken drops a sync token's key suffix and the token itself", () => {
    const vk = randomBytes(32);
    const jwt = [randomBytes(12), randomBytes(30), randomBytes(32)].map((b) => b.toString("base64url")).join(".");
    const out = redactToken(`${jwt}.${vk.toString("base64url")}`);
    for (const s of [...forms(vk), jwt]) expect(out.includes(s)).toBe(false);
    expect(redactToken(undefined)).toBe("<none>");
  });

  it("redactKeyFragments hides #k= / &k= / ?k= secrets in any text", () => {
    const s = "0123456789ABCDEFGHJKMNPQRS";
    const out = redactKeyFragments(
      `https://x/invite/i1#k=${s} baalda://invite/i1?server=https%3A%2F%2Fx&k=${s} baalda://invite/i1?k=${s}&server=y`,
    );
    expect(out.includes(s)).toBe(false);
    expect(out).toContain("#k=<redacted>");
    expect(out).toContain("&k=<redacted>");
    expect(out).toContain("?k=<redacted>&server=y");
    expect(redactKeyFragments(undefined)).toBe("");
  });

  it("an invite with vaultKeys never logs or echoes the secret or the wrap, even when the email fails", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    const app = createApp(testAppDeps());
    const owner = await signUp("owner@redact.test");
    const org = await createOrg(owner, "Redact", `redact-${Date.now()}`);
    const vaultId = await seedVault(org.id);
    await markEncryptionRequested(vaultId, owner.userId);
    const vk = randomBytes(32);
    const h = {
      ...authHeaders(owner),
      "x-baalda-version": VAULT_KEYS_MIN_DESKTOP,
      [VK_HEADER]: vk.toString("base64"),
    };
    expect(
      (
        await app.request(`/api/vaults/${vaultId}/keys/init`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            vkCheck: makeVkCheck(vk, vaultId).toString("base64"),
            generation: 1,
            sealedVkForSelf: randomBytes(80).toString("base64"),
          }),
        })
      ).status,
    ).toBe(201);
    // A transport whose error message echoes the whole email (link included).
    __setMailerForTests({
      kind: "memory",
      async send(msg) {
        throw new Error(`smtp refused: ${msg.text}`);
      },
    });
    const logged = captureLogs();
    const secret = "7ABCDEFGHJKMNPQRSTVWXYZ012";
    const wrappedVk = randomBytes(72).toString("base64");
    try {
      const res = await app.request(`/api/orgs/${org.id}/invitations`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          emails: ["new@redact.test"],
          vaultKeys: { vaultId, generation: 1, items: [{ email: "new@redact.test", wrappedVk, secret }] },
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.includes(secret)).toBe(false);
      expect(text.includes(wrappedVk)).toBe(false);
    } finally {
      __setMailerForTests(null);
    }
    const all = logged.join("\n");
    expect(all).toContain("[email] invitation");
    for (const s of [secret, wrappedVk, ...forms(vk)]) expect(all.includes(s)).toBe(false);
  });

  it("unlock and password-wrap never log the password, the unlock key or the wrap", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    vi.stubEnv("ACCOUNT_KEY_PEPPER", randomBytes(32).toString("base64"));
    await resetDb();
    const app = createApp(testAppDeps());
    const password = "unlock-redaction-pass-77";
    const u = await signUp("unlock@redact.test", password);
    const logged = captureLogs();
    const post = (path: string, method: string, body: unknown) =>
      app.request(path, { method, headers: authHeaders(u), body: JSON.stringify(body) });
    const ok = await post("/api/me/keys/unlock", "POST", { password });
    const { unlockKey } = (await ok.json()) as { unlockKey: string };
    expect(unlockKey).toBeTruthy();
    expect((await post("/api/me/keys/unlock", "POST", { password: "wrong-redaction-pass" })).status).toBe(401);
    await post("/api/me/keys", "PUT", { publicKey: randomBytes(32).toString("base64") });
    const privWrapped = randomBytes(96).toString("base64");
    expect((await post("/api/me/keys/password-wrap", "PUT", { privWrapped })).status).toBe(200);
    const all = logged.join("\n");
    for (const s of [password, "wrong-redaction-pass", unlockKey, privWrapped]) expect(all.includes(s)).toBe(false);
  });

  it("an MCP request's unwrapped keys are zeroed when it ends", () => {
    const key = randomBytes(32);
    const auth = { vaultKeys: new Map([["v1", { key, generation: 1 }]]) };
    zeroAuthKeys(auth);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(auth.vaultKeys.size).toBe(0);
    zeroAuthKeys(null);
  });
});
