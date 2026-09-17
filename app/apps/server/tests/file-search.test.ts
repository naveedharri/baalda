import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { searchNoteIndex } from "../src/index/indexer.js";
import { listReadableDocsInVault, vaultAccess } from "../src/permissions/vault-docs.js";
import { resetDb } from "./helpers/db.js";
import {
  seedBlob,
  seedBlobText,
  seedFile,
  seedFolder,
  seedMember,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * Search over `blob_text`: a file's extracted words rank beside a note's, and
 * a file the caller cannot read is never SCORED — not filtered afterwards.
 *
 * The distinction matters: a hit list you filter still lets an unreadable file
 * influence which readable things surface and how high, which is a slow read of
 * its contents ("my query scored differently once I added a word that appears
 * only in a file I cannot open"). So the visibility rule lives in the WHERE
 * clause, and the oracle test below is what pins it there.
 */

async function search(userId: string, vaultId: string, query: string, k = 10) {
  const readable = await listReadableDocsInVault(userId, vaultId);
  const access = await vaultAccess(pool, userId, vaultId);
  return searchNoteIndex({
    vaultId,
    query,
    k,
    readableDocIds: readable,
    vaultWideReader: access?.vaultWide === true,
  });
}

describe("search over extracted file text", () => {
  let org: string;
  let owner: string;
  let member: string;
  let vault: string;
  let teamFolder: string;
  let secretFolder: string;
  let readableDoc: string;
  let secretDoc: string;

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg("Search Co", `search-${randomUUID().slice(0, 8)}`);
    owner = await seedUser(`owner+${randomUUID()}@filesearch.test`);
    await seedMember(org, owner, "owner");
    member = await seedUser(`member+${randomUUID()}@filesearch.test`);
    await seedMember(org, member, "member");
    vault = await seedVault(org);

    teamFolder = await seedFolder(vault, null, "Team", "Team", owner);
    secretFolder = await seedFolder(vault, null, "Board", "Board", owner);

    readableDoc = await seedFile(vault, teamFolder, "Team/q3.xlsx");
    const readableBlob = await seedBlob(vault, org, "Team/q3.xlsx", { docId: readableDoc });
    await seedBlobText(readableBlob, vault, readableDoc, "quarterly pipeline forecast");

    secretDoc = await seedFile(vault, secretFolder, "Board/comp.xlsx");
    const secretBlob = await seedBlob(vault, org, "Board/comp.xlsx", { docId: secretDoc });
    await seedBlobText(secretBlob, vault, secretDoc, "acquisition severance pipeline");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("returns a kind:'file' hit for a file the caller can read", async () => {
    await seedShare(org, "folder", teamFolder, member, "view");
    const hits = await search(member, vault, "quarterly pipeline forecast");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: "file",
      docId: readableDoc,
      relPath: "Team/q3.xlsx",
      ext: "xlsx",
    });
    expect(hits[0].blobId).toBeTruthy();
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("never lets an unreadable file's words reach the ranking (content oracle)", async () => {
    await seedShare(org, "folder", teamFolder, member, "view");

    // A query made of words that appear ONLY in the file the member cannot
    // read. If that file were scored at all it would be the top hit.
    const blind = await search(member, vault, "acquisition severance");
    expect(blind.map((h) => h.relPath)).not.toContain("Board/comp.xlsx");

    // And the readable file's own score must not move when the unreadable one
    // shares a word with the query — i.e. nothing about it is being consulted.
    const withShared = await search(member, vault, "pipeline");
    expect(withShared.map((h) => h.relPath)).toEqual(["Team/q3.xlsx"]);

    // The owner, who can read both, sees both — so the absence above is the
    // ACL and not an indexing accident.
    await seedVaultGrant(org, "edit");
    const all = await search(owner, vault, "pipeline");
    expect(all.map((h) => h.relPath).sort()).toEqual(["Board/comp.xlsx", "Team/q3.xlsx"]);
  });

  it("only a vault-wide reader can match a doc-less attachments/ blob", async () => {
    const loose = await seedBlob(vault, org, "attachments/deadbeef.pdf");
    await seedBlobText(loose, vault, null, "hovercraft eels");

    expect((await search(member, vault, "hovercraft eels")).length).toBe(0);
    await seedVaultGrant(org, "view");
    // Ranked first, not merely present: a zero-scoring candidate is still
    // returned (that is how the note pass has always behaved), so what the
    // grant buys is showing up AND matching.
    const hits = await search(member, vault, "hovercraft eels");
    expect(hits[0].relPath).toBe("attachments/deadbeef.pdf");
    expect(hits[0].score).toBeGreaterThan(0);
    // No registered doc behind it, so no doc id to hand back.
    expect(hits[0].docId).toBeNull();
  });

  it("includeFiles: false leaves files out entirely", async () => {
    await seedVaultGrant(org, "edit");
    const hits = await searchNoteIndex({
      vaultId: vault,
      query: "pipeline",
      k: 10,
      readableDocIds: await listReadableDocsInVault(owner, vault),
      includeFiles: false,
      vaultWideReader: true,
    });
    expect(hits).toEqual([]);
  });

  it("keeps the text of a file whose blob is still pending out of results", async () => {
    await seedVaultGrant(org, "edit");
    await pool.query("UPDATE blobs SET status = 'pending' WHERE rel_path = 'Team/q3.xlsx'");
    const hits = await search(owner, vault, "quarterly forecast");
    expect(hits.map((h) => h.relPath)).not.toContain("Team/q3.xlsx");
  });
});
