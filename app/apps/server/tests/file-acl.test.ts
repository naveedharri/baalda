import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  canReadAttachment,
  canWriteBlob,
  filterReadableBlobs,
} from "../src/permissions/http-gates.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  seedBlob,
  seedFile,
  seedFolder,
  seedLock,
  seedMember,
  seedOrg,
  seedNote,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
  sealVault,
} from "./helpers/seed.js";

/**
 * Files as first-class docs (PR3): a blob with a `doc_id` is judged by
 * `effectivePermission`, not by whether some readable note happens to mention
 * its path. The point of the whole change is the first test here — a member
 * shared one folder could open its notes and not its spreadsheets.
 *
 * The `attachments/` half is unchanged and pinned alongside it, because the two
 * branches share one function and it would be easy to move both by accident.
 */

/** A note_index row — what the path heuristic actually reads. */
async function indexNote(vaultId: string, docId: string, content: string): Promise<void> {
  await pool.query(
    "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)",
    [docId, vaultId, docId, content],
  );
}

describe("file ACL (blobs with a doc_id)", () => {
  let org: string;
  let owner: string;
  let member: string;
  let vault: string;
  let teamFolder: string;
  /** `Team/q3.xlsx` — a registered tree file. */
  let fileDoc: string;
  let fileBlob: string;
  /** `attachments/loose.png` — a hash-named drop with no doc of its own. */
  let orphanBlob: string;

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg("Files Co", `files-${randomUUID().slice(0, 8)}`);
    owner = await seedUser(`owner+${randomUUID()}@fileacl.test`);
    await seedMember(org, owner, "owner");
    member = await seedUser(`member+${randomUUID()}@fileacl.test`);
    await seedMember(org, member, "member");
    vault = await seedVault(org);
    // Private by default: no vault grant at all, so the member reaches only
    // what is shared with them by name.
    teamFolder = await seedFolder(vault, null, "Team", "Team", owner);
    fileDoc = await seedFile(vault, teamFolder, "Team/q3.xlsx");
    fileBlob = await seedBlob(vault, org, "Team/q3.xlsx", { docId: fileDoc });
    orphanBlob = await seedBlob(vault, org, "attachments/loose.png");
  });
  afterAll(async () => {
    await pool.end();
  });

  const readFile = (userId: string) =>
    canReadAttachment(userId, vault, "Team/q3.xlsx", fileDoc);
  const readOrphan = (userId: string) =>
    canReadAttachment(userId, vault, "attachments/loose.png", null);

  it("a folder share reaches the FILES inside it, not just the notes", async () => {
    expect(await readFile(member)).toBe(false);
    await seedShare(org, "folder", teamFolder, member, "view");
    expect(await readFile(member)).toBe(true);
  });

  it("revoking the share takes the file back", async () => {
    const share = await seedShare(org, "folder", teamFolder, member, "view");
    expect(await readFile(member)).toBe(true);
    await pool.query("DELETE FROM shares WHERE id = $1", [share]);
    expect(await readFile(member)).toBe(false);
  });

  it("a sealed vault refuses the file to everyone, owner included", async () => {
    await seedVaultGrant(org, "edit");
    expect(await readFile(member)).toBe(true);
    await pool.query("DELETE FROM shares WHERE resource_type = 'vault'");
    await sealVault(org);
    expect(await readFile(member)).toBe(false);
    expect(await readFile(owner)).toBe(false);
  });

  it("an org grant on the folder lifts a file out of a sealed vault", async () => {
    await sealVault(org);
    expect(await readFile(member)).toBe(false);
    await pool.query(
      `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'folder', $3, 'org', $2, 'view')`,
      [randomUUID(), org, teamFolder],
    );
    expect(await readFile(member)).toBe(true);
  });

  it("a non-member gets nothing, doc_id or not", async () => {
    const outsider = await seedUser(`outsider+${randomUUID()}@fileacl.test`);
    expect(await readFile(outsider)).toBe(false);
    expect(await readOrphan(outsider)).toBe(false);
  });

  it("an orphan attachments/ blob stays on the path heuristic", async () => {
    const note = await seedNote(vault, null, "Mine.md", member);
    // The member can read their own note but it mentions nothing.
    expect(await readOrphan(member)).toBe(false);
    await indexNote(vault, note, "see ![](attachments/loose.png)");
    expect(await readOrphan(member)).toBe(true);
  });

  it("a doc_id naming no files row falls back to the path branch", async () => {
    // A half-finished registration must not make the bytes unreachable.
    const ghost = randomUUID();
    await seedVaultGrant(org, "view");
    expect(await canReadAttachment(member, vault, "attachments/loose.png", ghost)).toBe(true);
  });

  describe("filterReadableBlobs", () => {
    const rows = () => [
      { id: fileBlob, rel_path: "Team/q3.xlsx", doc_id: fileDoc },
      { id: orphanBlob, rel_path: "attachments/loose.png", doc_id: null },
    ];

    it("mixes the two branches in one pass", async () => {
      const note = await seedNote(vault, null, "Mine.md", member);
      await indexNote(vault, note, "![](attachments/loose.png)");
      // Only the attachment, because nothing shares the folder yet.
      expect((await filterReadableBlobs(member, vault, rows())).map((b) => b.id)).toEqual([
        orphanBlob,
      ]);

      await seedShare(org, "folder", teamFolder, member, "view");
      const both = await filterReadableBlobs(member, vault, rows());
      expect(both.map((b) => b.id).sort()).toEqual([fileBlob, orphanBlob].sort());
    });

    it("hides a file from a vault-wide reader who was denied it by name", async () => {
      await seedVaultGrant(org, "edit");
      expect((await filterReadableBlobs(member, vault, rows())).map((b) => b.id).sort()).toEqual(
        [fileBlob, orphanBlob].sort(),
      );
      await pool.query(
        `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ($1, $2, 'file', $3, 'user', $4, 'denied')`,
        [randomUUID(), org, fileDoc, member],
      );
      expect((await filterReadableBlobs(member, vault, rows())).map((b) => b.id)).toEqual([
        orphanBlob,
      ]);
    });
  });

  describe("canWriteBlob", () => {
    const fileRow = () => ({ vault_id: vault, rel_path: "Team/q3.xlsx", doc_id: fileDoc });
    const orphanRow = () => ({ vault_id: vault, rel_path: "attachments/loose.png", doc_id: null });

    it("closes the folder-lock gap for a registered file", async () => {
      await seedVaultGrant(org, "edit");
      expect(await canWriteBlob(member, fileRow())).toBe(true);
      await seedLock(org, "folder", teamFolder, { type: "org" });
      // The file is locked; the vault posture alone would still say yes, which
      // is exactly the hole this closes.
      expect(await canWriteBlob(member, fileRow())).toBe(false);
      expect(await canWriteBlob(member, orphanRow())).toBe(true);
    });

    it("refuses everything in a read-only vault", async () => {
      await seedVaultGrant(org, "view");
      expect(await canWriteBlob(member, fileRow())).toBe(false);
      expect(await canWriteBlob(member, orphanRow())).toBe(false);
    });
  });
});
