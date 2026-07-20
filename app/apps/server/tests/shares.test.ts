import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { memoryDocWriter } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

/**
 * POST /api/shares must force-close live sockets for every affected doc whenever
 * a change lowers access to read-only, so open editors reconnect and re-mint a
 * read-only token immediately (realtime enforcement). Downgrades land as
 * permission 'view' (per-user edit→view, workspace Open→Read-only) or 'locked'.
 * A plain 'edit' grant only widens access and must NOT kick sockets.
 */

const mem = memoryDocWriter();
let disconnected: Array<{ vaultId: string; docId: string }> = [];
const app = createApp({
  docWriter: mem,
  disconnectDoc: (vaultId, docId) => disconnected.push({ vaultId, docId }),
});

async function postShare(user: TestUser, body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://local/api/shares", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /shares — realtime read-only enforcement", () => {
  let owner: TestUser;
  let orgId: string;
  let vault: string;
  let docId: string;
  let memberId: string;

  beforeEach(async () => {
    await resetDb();
    disconnected = [];
    owner = await signUp("owner@shares.test");
    orgId = (await createOrg(owner, "Shares Co", "shares-co")).id;
    vault = await seedVault(orgId);
    docId = await seedNote(vault, null, "note.md");
    const member = await signUp("member@shares.test");
    memberId = member.userId;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("a per-user view (edit→view downgrade) kicks live sockets for the doc", async () => {
    const res = await postShare(owner, {
      resourceType: "file",
      resourceId: docId,
      principalType: "user",
      principalId: memberId,
      permission: "view",
    });
    expect(res.status).toBe(201);
    expect(disconnected).toContainEqual({ vaultId: vault, docId });
  });

  it("a per-user edit grant does NOT kick sockets (access only widens)", async () => {
    const res = await postShare(owner, {
      resourceType: "file",
      resourceId: docId,
      principalType: "user",
      principalId: memberId,
      permission: "edit",
    });
    expect(res.status).toBe(201);
    expect(disconnected).toHaveLength(0);
  });

  it("a lock still kicks live sockets", async () => {
    const res = await postShare(owner, {
      resourceType: "file",
      resourceId: docId,
      principalType: "user",
      principalId: memberId,
      permission: "locked",
    });
    expect(res.status).toBe(201);
    expect(disconnected).toContainEqual({ vaultId: vault, docId });
  });

  it("workspace Open→Read-only (org-wide view) kicks every doc in the workspace", async () => {
    const res = await postShare(owner, {
      resourceType: "workspace",
      resourceId: orgId,
      principalType: "org",
      permission: "view",
    });
    expect(res.status).toBe(201);
    expect(disconnected).toContainEqual({ vaultId: vault, docId });
  });

  // Issue #5: an Everyone/org lock subsumes per-user locks on the same resource.
  async function lockRows(type: "org" | "user") {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM shares
        WHERE resource_type = 'file' AND resource_id = $1
          AND principal_type = $2 AND permission = 'locked'`,
      [docId, type],
    );
    return Number(rows[0].n);
  }

  it("a per-user lock is a no-op when an org lock already covers the resource", async () => {
    // Everyone lock first.
    expect(
      (
        await postShare(owner, {
          resourceType: "file",
          resourceId: docId,
          principalType: "org",
          permission: "locked",
        })
      ).status,
    ).toBe(201);
    // Now try to add a redundant per-user lock for the member.
    const res = await postShare(owner, {
      resourceType: "file",
      resourceId: docId,
      principalType: "user",
      principalId: memberId,
      permission: "locked",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ principalType: "org", subsumed: true });
    // No per-user lock row was written; the single org lock remains authoritative.
    expect(await lockRows("user")).toBe(0);
    expect(await lockRows("org")).toBe(1);
  });

  it("creating an Everyone lock removes subsumed per-user locks (single Unlock)", async () => {
    // A per-user lock exists first …
    expect(
      (
        await postShare(owner, {
          resourceType: "file",
          resourceId: docId,
          principalType: "user",
          principalId: memberId,
          permission: "locked",
        })
      ).status,
    ).toBe(201);
    expect(await lockRows("user")).toBe(1);
    // … then the whole resource is locked for everyone.
    expect(
      (
        await postShare(owner, {
          resourceType: "file",
          resourceId: docId,
          principalType: "org",
          permission: "locked",
        })
      ).status,
    ).toBe(201);
    // The redundant per-user lock is dropped, leaving one authoritative org lock.
    expect(await lockRows("user")).toBe(0);
    expect(await lockRows("org")).toBe(1);
  });
});
