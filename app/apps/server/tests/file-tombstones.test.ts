import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, signUp, type TestUser } from "./helpers/auth.js";
import { seedBlob, seedFile, seedFolder, seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * `GET /api/vaults/:vaultId/file-tombstones` (#215): the ids of deleted tree
 * files, so a teammate's stale copy is set aside instead of re-uploaded.
 */
const app = createApp(testAppDeps());

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let orgId = "";
let vaultId = "";
let folderId = "";

const list = (user: TestUser) =>
  app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/file-tombstones`, { headers: authHeaders(user) }),
  );
const del = (user: TestUser, id: string) =>
  app.fetch(new Request(`http://local/api/files/${id}`, { method: "DELETE", headers: authHeaders(user) }));

afterAll(async () => {
  await pool.end();
});

describe("GET /api/vaults/:vaultId/file-tombstones", () => {
  beforeEach(async () => {
    await resetDb();
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@tomb.test`);
    member = await signUp(`member+${tag}@tomb.test`);
    outsider = await signUp(`out+${tag}@tomb.test`);
    orgId = await seedOrg("Tomb Co", `tomb-${tag}`);
    await seedMember(orgId, owner.userId, "owner");
    await seedMember(orgId, member.userId, "member");
    vaultId = await seedVault(orgId);
    await seedVaultGrant(orgId, "edit");
    folderId = await seedFolder(vaultId, null, "Team", "Team", owner.userId);
  });

  it("names a deleted file's id to a member", async () => {
    const gone = await seedFile(vaultId, folderId, "Team/old.pdf");
    await seedBlob(vaultId, orgId, "Team/old.pdf", { docId: gone });
    const kept = await seedFile(vaultId, folderId, "Team/kept.pdf");
    expect((await del(owner, gone)).status).toBe(204);

    const res = await list(member);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: string[] };
    expect(body.ids).toEqual([gone]);
    expect(body.ids).not.toContain(kept);
  });

  it("omits a tombstone whose id has a live row again", async () => {
    const id = await seedFile(vaultId, folderId, "Team/back.pdf");
    await pool.query(
      "INSERT INTO file_tombstones (id, vault_id, path) VALUES ($1, $2, 'Team/back.pdf')",
      [id, vaultId],
    );
    const body = (await (await list(owner)).json()) as { ids: string[] };
    expect(body.ids).toEqual([]);
  });

  it("refuses a non-member", async () => {
    expect((await list(outsider)).status).toBe(403);
  });
});
