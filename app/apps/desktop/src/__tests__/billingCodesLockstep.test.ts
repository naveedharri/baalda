// The desktop classifies 402 billing refusals by their contract token
// (`lib/billing.ts LIMIT_CODES`). The server is a separate package, so this test
// READS its source files, like `lib/__tests__/formatsLockstep.test.ts`, and fails
// when the desktop classifies a token no server source still emits.
//
// `PENDING_SERVER` lists tokens the Team-billing server work has not landed yet.
// They are reported, not failed; remove an entry once the server emits it, and
// the test then fails if the entry is left behind.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIMIT_CODES } from "../lib/billing";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = resolve(here, "../../../server/src");

const SOURCES = [
  "auth/auth.ts",
  "http/routes/orgs.ts",
  "http/routes/members.ts",
  "http/routes/blobs.ts",
  "http/routes/housekeeper.ts",
  "http/routes/billing.ts",
  "permissions/resolver.ts",
  "permissions/http-gates.ts",
  // Every billing module (plan.ts, seats.ts, note-quota.ts, …) as it lands.
  ...(existsSync(resolve(serverSrc, "billing"))
    ? readdirSync(resolve(serverSrc, "billing"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `billing/${f}`)
    : []),
];

/** Tokens the desktop already understands ahead of the server. */
const PENDING_SERVER = new Set<string>([]);

const serverText = SOURCES.map((rel) => resolve(serverSrc, rel))
  .filter((p) => existsSync(p))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

describe("billing 402 codes stay in lockstep with the server", () => {
  it("finds the server sources", () => {
    expect(serverText.length).toBeGreaterThan(0);
  });

  const codes = [...new Set(LIMIT_CODES.map(([code]) => code))];
  for (const code of codes) {
    it(`server emits ${code}`, () => {
      const present = serverText.includes(code);
      if (PENDING_SERVER.has(code)) {
        if (!present) console.warn(`[billingCodesLockstep] pending server: ${code}`);
        else expect.fail(`${code} is in the server now; drop it from PENDING_SERVER`);
        return;
      }
      expect(present, `${code} is classified by the desktop but no server source emits it`).toBe(true);
    });
  }
});
