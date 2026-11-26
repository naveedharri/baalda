// SPDX-License-Identifier: Apache-2.0
// Hash-named `attachments/` blobs have no doc of their own. A reader who cannot
// see every item is judged by the notes that embed them, like a scoped member.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { replaceBlobRefs } from "../src/blobs/refs.js";
import { canReadAttachment, filterReadableBlobs } from "../src/permissions/http-gates.js";
import { readsWholeVault } from "../src/permissions/vault-docs.js";
import { memoryDocWriter } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedBlob,
  seedBlobText,
  seedDeny,
  seedFolder,
  seedItemPrivate,
  seedMember,
  seedNote,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

const app = createApp({
  docWriter: memoryDocWriter(),
  disconnectDoc: () => {},
  evictDoc: () => {},
});

async function indexNote(docId: string, vaultId: string, md: string): Promise<void> {
  await pool.query(
    "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $1, $3)",
    [docId, vaultId, md],
  );
  await replaceBlobRefs(docId, vaultId, md);
}

async function searchHits(user: TestUser, vaultId: string, q: string): Promise<string> {
  const res = await app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/search?q=${encodeURIComponent(q)}&k=20`, {
      headers: authHeaders(user),
    }),
  );
  expect(res.status).toBe(200);
  return res.text();
}

describe("attachments embedded in a folder the reader is denied", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let restricted: string;
  const hidden = "attachments/salaries.png";
  const shared = "attachments/team-photo.png";
  const hiddenText = `payroll-${randomUUID()}`;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp(`owner-${randomUUID()}@att.test`);
    orgId = (await createOrg(owner, "Att", `att-${randomUUID()}`)).id;
    member = await signUp(`member-${randomUUID()}@att.test`);
    vault = await seedVault(orgId, "V");
    await seedMember(orgId, member.userId, "member");
    // Content below is created strictly after the join.
    await new Promise((r) => setTimeout(r, 20));
    await seedVaultGrant(orgId, "edit");
    restricted = await seedFolder(vault, null, "HR", "HR", owner.userId);
    const hrNote = await seedNote(vault, restricted, "HR/pay.md", owner.userId);
    await indexNote(hrNote, vault, `![pay](${hidden})`);
    const openNote = await seedNote(vault, null, "welcome.md", owner.userId);
    await indexNote(openNote, vault, `![team](${shared})`);
    const blob = await seedBlob(vault, orgId, hidden);
    await seedBlobText(blob, vault, null, hiddenText);
    await seedBlob(vault, orgId, shared);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function expectHidden(): Promise<void> {
    expect(await readsWholeVault(pool, member.userId, vault)).toBe(false);
    expect(await canReadAttachment(member.userId, vault, hidden)).toBe(false);
    expect(await canReadAttachment(member.userId, vault, shared)).toBe(true);
    const listed = await filterReadableBlobs(member.userId, vault, [
      { id: "h", rel_path: hidden },
      { id: "s", rel_path: shared },
    ]);
    expect(listed.map((b) => b.rel_path)).toEqual([shared]);
    expect(await searchHits(member, vault, hiddenText)).not.toContain(hidden);
  }

  it("a vault-wide reader with no deny still reads every attachment", async () => {
    expect(await readsWholeVault(pool, member.userId, vault)).toBe(true);
    expect(await canReadAttachment(member.userId, vault, hidden)).toBe(true);
    expect(await searchHits(member, vault, hiddenText)).toContain(hidden);
  });

  it("a per-user folder deny hides what only that folder embeds", async () => {
    await seedDeny(orgId, "folder", restricted, member.userId);
    await expectHidden();
  });

  it("a folder set to Private for the team hides it from members too", async () => {
    await seedItemPrivate(orgId, "folder", restricted);
    await expectHidden();
    // Item Private withdraws the owner/admin shortcut too: no note, no image.
    expect(await canReadAttachment(owner.userId, vault, hidden)).toBe(false);
  });

  it("a member who joined under New members = No access is not a whole-vault reader", async () => {
    // `member` joined before any content existed, so the snapshot hides
    // nothing; `later` joins after it, so the existing notes stay hidden.
    const later = await signUp(`later-${randomUUID()}@att.test`);
    await seedMember(orgId, later.userId, "member");
  // Joined before 2026-11-25 under New members = No access: the trigger took
  // this snapshot then (migration 100 stopped taking new ones).
  await pool.query(
    `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
     VALUES ($1, $2, 'private', 0, now()) ON CONFLICT DO NOTHING`,
    [orgId, later.userId],
  );
    expect(await readsWholeVault(pool, later.userId, vault)).toBe(false);
    expect(await canReadAttachment(later.userId, vault, hidden)).toBe(false);
    expect(await canReadAttachment(later.userId, vault, shared)).toBe(false);
  });
});
