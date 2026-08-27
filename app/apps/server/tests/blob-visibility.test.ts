import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { filterReadableBlobs } from "../src/permissions/http-gates.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * `filterReadableBlobs` decides which attachments a SCOPED member (no vault-wide
 * grant) may see: only those referenced by a note they can read. It used to pull
 * every readable note's body into one JS string and substring-search it; the
 * reference test now runs in Postgres. These tests pin the semantics that swap
 * had to preserve — including the LIKE-escaping the SQL form newly needs, since
 * a rel_path is user-controlled and `%`/`_` are wildcards there but were literal
 * characters to `String.includes`.
 */

/** A derived index row — what the reference check actually reads. */
async function seedIndex(vaultId: string, docId: string, content: string): Promise<void> {
  await pool.query(
    "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)",
    [docId, vaultId, docId, content],
  );
}

/** The shape the blobs route hands in (only `rel_path` is load-bearing). */
const blob = (rel_path: string | null) => ({ id: `blob:${rel_path}`, rel_path });

describe("filterReadableBlobs (attachment visibility)", () => {
  let org: string;
  let owner: string;
  let member: string;
  let vault: string;
  let ownerNote: string;
  let memberNote: string;

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg("Blobs Co", "blobs-co");
    owner = await seedUser("owner@blobvis.test");
    await seedMember(org, owner, "owner");
    // A plain member with no shares: the vault is private by default, so their
    // readable set is exactly the notes they created.
    member = await seedUser("member@blobvis.test");
    await seedMember(org, member, "member");
    vault = await seedVault(org);
    ownerNote = await seedNote(vault, null, "Owner.md", owner);
    memberNote = await seedNote(vault, null, "Member.md", member);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("shows a blob referenced by a note the member can read", async () => {
    await seedIndex(vault, memberNote, "![](attachments/pic.png)\n");
    const out = await filterReadableBlobs(member, vault, [blob("attachments/pic.png")]);
    expect(out.map((b) => b.rel_path)).toEqual(["attachments/pic.png"]);
  });

  it("hides a blob no readable note references", async () => {
    await seedIndex(vault, memberNote, "no attachments here");
    const out = await filterReadableBlobs(member, vault, [blob("attachments/orphan.png")]);
    expect(out).toEqual([]);
  });

  it("hides a blob referenced only by a note the member cannot read", async () => {
    await seedIndex(vault, ownerNote, "![](attachments/secret.png)");
    await seedIndex(vault, memberNote, "nothing of interest");
    const out = await filterReadableBlobs(member, vault, [blob("attachments/secret.png")]);
    expect(out).toEqual([]);
  });

  it("filters a mixed batch in one pass", async () => {
    await seedIndex(vault, memberNote, "![](attachments/mine.png) and ![](attachments/also.pdf)");
    await seedIndex(vault, ownerNote, "![](attachments/theirs.png)");
    const out = await filterReadableBlobs(member, vault, [
      blob("attachments/mine.png"),
      blob("attachments/theirs.png"),
      blob("attachments/also.pdf"),
      blob("attachments/orphan.png"),
      blob(null), // legacy blob with no path — never matchable
    ]);
    expect(out.map((b) => b.rel_path).sort()).toEqual([
      "attachments/also.pdf",
      "attachments/mine.png",
    ]);
  });

  it("treats % and _ in a rel_path as literal characters, not LIKE wildcards", async () => {
    await seedIndex(
      vault,
      memberNote,
      // The literal path with the metacharacters, plus two decoys that a
      // WILDCARD interpretation of the other two paths would match.
      "![](attachments/50%_off.png)\n![](attachments/aXYZb.png)\n![](attachments/aXb.png)\n",
    );
    const out = await filterReadableBlobs(member, vault, [
      blob("attachments/50%_off.png"), // literally present -> visible
      blob("attachments/a%b.png"), // only matches if % is a wildcard -> hidden
      blob("attachments/a_b.png"), // only matches if _ is a wildcard -> hidden
    ]);
    expect(out.map((b) => b.rel_path)).toEqual(["attachments/50%_off.png"]);
  });

  it("treats a backslash in a rel_path literally", async () => {
    // `\` is the ESCAPE character in the LIKE, so an unescaped one would eat the
    // next character and silently change what is matched.
    await seedIndex(vault, memberNote, "![](attachments/a\\%b.png)");
    const out = await filterReadableBlobs(member, vault, [
      blob("attachments/a\\%b.png"),
      blob("attachments/ab.png"),
    ]);
    expect(out.map((b) => b.rel_path)).toEqual(["attachments/a\\%b.png"]);
  });

  it("gives a vault-wide reader every blob, referenced or not", async () => {
    const all = [blob("attachments/pic.png"), blob("attachments/orphan.png"), blob(null)];
    // Owner: no note_index rows at all, and still sees everything.
    expect(await filterReadableBlobs(owner, vault, all)).toEqual(all);
  });

  it("gives a non-member nothing", async () => {
    const outsider = await seedUser("outsider@blobvis.test");
    await seedIndex(vault, memberNote, "![](attachments/pic.png)");
    expect(await filterReadableBlobs(outsider, vault, [blob("attachments/pic.png")])).toEqual([]);
  });

  it("gives a member with an empty readable set nothing", async () => {
    // A member who created nothing has no readable docs, so no blob can be
    // justified — short-circuited before any query.
    const bystander = await seedUser("bystander@blobvis.test");
    await seedMember(org, bystander, "member");
    await seedIndex(vault, memberNote, "![](attachments/pic.png)");
    expect(await filterReadableBlobs(bystander, vault, [blob("attachments/pic.png")])).toEqual([]);
  });
});
