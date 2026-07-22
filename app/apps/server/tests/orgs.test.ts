import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp } from "./helpers/auth.js";

const app = createApp(testAppDeps());

function getJoinCode(token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(new Request("http://local/api/orgs/join-code", { headers }));
}

function join(token: string | null, code: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.fetch(
    new Request("http://local/api/orgs/join", {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
    }),
  );
}

describe("vault join codes", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("owner lazily generates an 8-char unambiguous code, stable across calls", async () => {
    const owner = await signUp("owner@join.com");
    await createOrg(owner, "Acme", "acme-join1");

    const res = await getJoinCode(owner.token);
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(code).not.toMatch(/[01OI]/);

    // Second call returns the same persisted code.
    const again = (await (await getJoinCode(owner.token)).json()) as { code: string };
    expect(again.code).toBe(code);
  });

  it("rejects a plain member from reading the code (403) and anon (401)", async () => {
    const owner = await signUp("owner@join2.com");
    const org = await createOrg(owner, "Acme", "acme-join2");
    const code = ((await (await getJoinCode(owner.token)).json()) as { code: string }).code;

    // A member (joined via code) is not owner/admin → 403.
    const member = await signUp("member@join2.com");
    await join(member.token, code);
    expect((await getJoinCode(member.token)).status).toBe(403);
    expect((await getJoinCode(null)).status).toBe(401);
    expect(org.id).toBeTruthy();
  });

  it("join flow: unknown code 404; first join adds a member; repeat is idempotent", async () => {
    const owner = await signUp("owner@join3.com");
    const org = await createOrg(owner, "Acme", "acme-join3");
    const code = ((await (await getJoinCode(owner.token)).json()) as { code: string }).code;

    expect((await join(owner.token, "ZZZZZZZZ")).status).toBe(404);

    const joiner = await signUp("joiner@join3.com");
    const first = await join(joiner.token, code);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      organizationId: org.id,
      name: "Acme",
      alreadyMember: false,
    });

    // Member row created with role 'member'.
    const { rows } = await pool.query(
      `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, joiner.userId],
    );
    expect(rows[0].role).toBe("member");

    // Repeat join is idempotent (no duplicate row).
    const second = await join(joiner.token, code);
    expect((await second.json())).toEqual({
      organizationId: org.id,
      name: "Acme",
      alreadyMember: true,
    });
    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS c FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, joiner.userId],
    );
    expect(after[0].c).toBe(1);
  });
});
