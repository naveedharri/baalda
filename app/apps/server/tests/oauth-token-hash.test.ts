import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import {
  findAccessRow,
  hashIssuedRow,
  hashOAuthToken,
  isHashedForm,
  storedRefreshValue,
} from "../src/mcp/oauth-token-hash.js";
import { ensureMigrated } from "./helpers/db.js";

const client = `c-${randomUUID()}`;
const letters = () => randomUUID().replace(/[^a-z]/g, "x").slice(0, 32);

async function insertRow(access: string, refresh: string, scopes = "openid offline_access"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "oauthAccessToken" ("id","accessToken","refreshToken","accessTokenExpiresAt",
       "refreshTokenExpiresAt","clientId","userId","scopes")
     VALUES ($1,$2,$3,now()+interval '1 hour',now()+interval '7 days',$4,NULL,$5)`,
    [id, access, refresh, client, scopes],
  );
  return id;
}

beforeAll(async () => {
  await ensureMigrated();
  await pool.query(
    `INSERT INTO "oauthApplication" ("id","name","clientId","redirectUrls","type")
     VALUES ($1,'t',$1,'http://x/cb','public')`,
    [client],
  );
});
afterAll(async () => {
  await pool.query(`DELETE FROM "oauthApplication" WHERE "clientId" = $1`, [client]);
});

describe("OAuth tokens stored as hashes", () => {
  it("hash form is prefixed and never itself a credential", async () => {
    const h = hashOAuthToken("abc");
    expect(isHashedForm(h)).toBe(true);
    expect(isHashedForm("abc")).toBe(false);
    expect(await findAccessRow(pool, h)).toBeNull();
  });

  it("a legacy plaintext row keeps working (no reconnect)", async () => {
    const a = letters();
    const r = letters();
    const id = await insertRow(a, r);
    const row = await findAccessRow(pool, a);
    expect(row?.id).toBe(id);
    expect(row?.legacyPlaintext).toBe(true);
    expect(await storedRefreshValue(pool, r)).toBe(r);
  });

  it("a freshly issued row is rewritten to hashes and still resolves", async () => {
    const a = letters();
    const r = letters();
    const id = await insertRow(a, r);
    expect(await hashIssuedRow(pool, a, r)).toBe(id);
    const { rows } = await pool.query(`SELECT * FROM "oauthAccessToken" WHERE id = $1`, [id]);
    expect(rows[0].accessToken).toBe(hashOAuthToken(a));
    expect(rows[0].refreshToken).toBe(hashOAuthToken(r));
    expect(JSON.stringify(rows[0])).not.toContain(a);
    expect((await findAccessRow(pool, a))?.legacyPlaintext).toBe(false);
    expect(await storedRefreshValue(pool, r)).toBe(hashOAuthToken(r));
    expect(await hashIssuedRow(pool, a, r)).toBeNull(); // idempotent
  });

  it("hashes an unreturned refresh token too (no offline_access)", async () => {
    const a = letters();
    const r = letters();
    const id = await insertRow(a, r, "openid");
    expect(await hashIssuedRow(pool, a, undefined)).toBe(id);
    const { rows } = await pool.query(`SELECT "refreshToken" FROM "oauthAccessToken" WHERE id = $1`, [id]);
    expect(rows[0].refreshToken).toBe(hashOAuthToken(r));
  });

  it("unknown tokens resolve to nothing", async () => {
    expect(await findAccessRow(pool, letters())).toBeNull();
    expect(await storedRefreshValue(pool, letters())).toBeNull();
  });
});
