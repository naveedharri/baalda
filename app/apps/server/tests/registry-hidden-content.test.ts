import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFile, seedMember, seedNote, seedShare, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * `hiddenContent` / `canCreateRoot` on the notes listing: the signal the
 * desktop uses to tell "nothing is shared with you yet" from "this vault is
 * empty" (owner decision 2026-10-09). Booleans only, last page only.
 */

const app = createApp(testAppDeps());

interface Listing {
  notes: Array<{ id: string }>;
  hiddenContent?: boolean;
  canCreateRoot?: boolean;
  nextAfter?: string | null;
}

async function list(user: TestUser, vault: string, query = ""): Promise<Listing> {
  const res = await app.fetch(
    new Request(`http://local/api/notes?vaultId=${vault}${query}`, { headers: authHeaders(user) }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Listing;
}

async function denyVault(org: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, 'vault', $2, 'user', $3, 'denied')`,
    [randomUUID(), org, userId],
  );
}

describe("notes listing hiddenContent", () => {
  let owner: TestUser;
  let member: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@hidden.test");
    member = await signUp("member@hidden.test");
    org = (await createOrg(owner, "Hidden Co", "hidden-co")).id;
    await seedMember(org, member.userId, "member");
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("is true for a member with a per-user vault deny while the owner has notes", async () => {
    await seedNote(vault, null, "plan.md", owner.userId);
    await denyVault(org, member.userId);
    const body = await list(member, vault);
    expect(body.notes).toEqual([]);
    expect(body.hiddenContent).toBe(true);
    expect(body.canCreateRoot).toBe(false);
    // The owner reads everything: nothing hidden, and the root is theirs.
    const own = await list(owner, vault);
    expect(own.hiddenContent).toBe(false);
    expect(own.canCreateRoot).toBe(true);
  });

  it("counts a hidden file, not only notes", async () => {
    await seedFile(vault, null, "deck.pdf");
    await denyVault(org, member.userId);
    expect((await list(member, vault)).hiddenContent).toBe(true);
  });

  it("is false for an empty vault", async () => {
    await denyVault(org, member.userId);
    const body = await list(member, vault);
    expect(body.notes).toEqual([]);
    expect(body.hiddenContent).toBe(false);
  });

  it("ignores soft-deleted notes", async () => {
    const gone = await seedNote(vault, null, "gone.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);
    await denyVault(org, member.userId);
    expect((await list(member, vault)).hiddenContent).toBe(false);
  });

  it("is false when the member can read the only note", async () => {
    const doc = await seedNote(vault, null, "shared.md", owner.userId);
    await denyVault(org, member.userId);
    await seedShare(org, "file", doc, member.userId, "view");
    const body = await list(member, vault);
    expect(body.notes.map((n) => n.id)).toEqual([doc]);
    expect(body.hiddenContent).toBe(false);
  });

  it("rides the last page only", async () => {
    for (let i = 0; i < 3; i++) await seedNote(vault, null, `n${i}.md`, owner.userId);
    const first = await list(owner, vault, "&limit=2");
    expect(first.nextAfter).toBeTruthy();
    expect(first.hiddenContent).toBeUndefined();
    const last = await list(owner, vault, `&limit=2&after=${encodeURIComponent(first.nextAfter!)}`);
    expect(last.hiddenContent).toBe(false);
    expect(last.canCreateRoot).toBe(true);
  });
});
