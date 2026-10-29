import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { replaceBlobRefs } from "../src/blobs/refs.js";
import { canReadAttachment, filterReadableBlobs } from "../src/permissions/http-gates.js";
import { resetSyncMetrics, snapshot } from "../src/metrics/sync-metrics.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * W3 attachment ACL shadow mode: `blob_refs` is computed beside the text test,
 * the TEXT answer is returned, and every disagreement is counted. Notes are
 * indexed the way the indexer does it: `note_index.content` and `blob_refs`
 * from the same markdown.
 */

/** [note markdown, blob rel_path, text answer, refs answer] */
const CASES: Array<[string, string, string, boolean, boolean]> = [
  ["plain image embed", "![x](attachments/a.png)", "attachments/a.png", true, true],
  ["plain link", "[doc](attachments/report.pdf)", "attachments/report.pdf", true, true],
  // The editor writes %20; the uploader stored a space. blob_refs records the
  // decoded form too, so refs finds it; LIKE on the raw text does not.
  ["URL-encoded link, decoded blob path", "[doc](attachments/My%20File.pdf)", "attachments/My File.pdf", false, true],
  ["URL-encoded link, encoded blob path", "[doc](attachments/My%20File.pdf)", "attachments/My%20File.pdf", true, true],
  // A path mentioned in prose or a code span is not a link: text grants it, refs does not.
  ["prose mention", "see attachments/notes.txt for details", "attachments/notes.txt", true, false],
  ["code span", "`attachments/raw.bin`", "attachments/raw.bin", true, false],
  // A space inside the link target is not a markdown link target.
  ["angle-bracket link with a space", "[doc](<attachments/Big Plan.pdf>)", "attachments/Big Plan.pdf", true, false],
  // blob_refs is lowercased; LIKE is case-sensitive.
  ["case differs", "![x](attachments/photo.png)", "attachments/Photo.PNG", false, true],
  // Text over-matches a longer name; refs does not.
  ["prefix of a longer name", "![x](attachments/a.png.bak)", "attachments/a.png", true, false],
];

describe("attachment ACL shadow mode", () => {
  let org: string;
  let member: string;
  let vault: string;
  const prev = process.env.ATTACHMENT_ACL_MODE;

  beforeEach(async () => {
    await resetDb();
    resetSyncMetrics();
    org = await seedOrg("Acl Co", "acl-co");
    const owner = await seedUser("owner@aclshadow.test");
    await seedMember(org, owner, "owner");
    member = await seedUser("member@aclshadow.test");
    await seedMember(org, member, "member");
    vault = await seedVault(org);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ATTACHMENT_ACL_MODE;
    else process.env.ATTACHMENT_ACL_MODE = prev;
  });
  afterAll(async () => {
    await pool.end();
  });

  async function memberNote(md: string): Promise<void> {
    const id = await seedNote(vault, null, `n-${Math.random().toString(36).slice(2)}.md`, member);
    await pool.query("INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $1, $3)", [id, vault, md]);
    await replaceBlobRefs(id, vault, md);
  }

  for (const [name, md, rel, textAns, refsAns] of CASES) {
    it(`${name}: text=${textAns} refs=${refsAns}; shadow returns text`, async () => {
      await memberNote(md);
      process.env.ATTACHMENT_ACL_MODE = "text";
      expect(await canReadAttachment(member, vault, rel)).toBe(textAns);
      process.env.ATTACHMENT_ACL_MODE = "refs";
      expect(await canReadAttachment(member, vault, rel)).toBe(refsAns);
      const listed = await filterReadableBlobs(member, vault, [{ id: "b", rel_path: rel }]);
      expect(listed.length === 1).toBe(refsAns);

      resetSyncMetrics();
      delete process.env.ATTACHMENT_ACL_MODE; // default = shadow
      expect(await canReadAttachment(member, vault, rel)).toBe(textAns);
      expect((await filterReadableBlobs(member, vault, [{ id: "b", rel_path: rel }])).length === 1).toBe(textAns);
      const m = snapshot();
      expect(m["attachment_acl.shadow.single.checked"]).toBe(1);
      expect(m["attachment_acl.shadow.list.checked"]).toBe(1);
      const textOnly = textAns && !refsAns ? 1 : 0;
      const refsOnly = !textAns && refsAns ? 1 : 0;
      expect(m["attachment_acl.shadow.single.disagree.text_only"] ?? 0).toBe(textOnly);
      expect(m["attachment_acl.shadow.single.disagree.refs_only"] ?? 0).toBe(refsOnly);
      expect(m["attachment_acl.shadow.list.disagree.text_only"] ?? 0).toBe(textOnly);
      expect(m["attachment_acl.shadow.list.disagree.refs_only"] ?? 0).toBe(refsOnly);
    });
  }
});
