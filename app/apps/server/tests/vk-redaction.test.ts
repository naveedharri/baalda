// SPDX-License-Identifier: Apache-2.0
//
// A vault key presented on a request (`X-Baalda-VK`, or a sync token's
// `.<vk>` suffix) must never reach a log line, including the error path, and
// the per-call keys an MCP request unwraps are zeroed when it ends.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { redactToken, VK_HEADER } from "../src/crypto/transport.js";
import { zeroAuthKeys } from "../src/http/routes/mcp.js";
import { testAppDeps } from "./helpers/app.js";

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

  it("an MCP request's unwrapped keys are zeroed when it ends", () => {
    const key = randomBytes(32);
    const auth = { vaultKeys: new Map([["v1", { key, generation: 1 }]]) };
    zeroAuthKeys(auth);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(auth.vaultKeys.size).toBe(0);
    zeroAuthKeys(null);
  });
});
