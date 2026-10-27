import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { filterReadableBlobs } from "../src/permissions/http-gates.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  seedBlob,
  seedFile,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

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

  it("matches a path anywhere in the text: repeated folders, overlaps, multi-byte text, no folder", async () => {
    // The reference check finds paths by their leading `dir/` and cuts the
    // candidates out of the text. These are the shapes that could trip that
    // and must answer exactly as plain substring containment does.
    await seedIndex(
      vault,
      memberNote,
      [
        "ünïcödé — 日本語 before ![](attachments/attachments/nested.png)", // anchor twice in a row
        "x/attachments/inner.png", // occurs after another folder
        "![](attachments/long-name.png)", // a shorter path is a prefix of this
        "attachments/attachments/attachments/deep.png",
        "loose.png in the root", // no folder at all
        "attachments/",
      ].join("\n"),
    );
    // A path under the same folder that only the owner's note, which the
    // member cannot read, references.
    await seedIndex(vault, ownerNote, "![](attachments/owner-only.png)");
    const candidates = [
      "attachments/attachments/nested.png", // visible
      "attachments/nested.png", // visible: it is a substring of the first line
      "attachments/inner.png", // visible: substring of x/attachments/inner.png
      "x/attachments/inner.png", // visible
      "attachments/long", // visible: substring of long-name.png
      "attachments/long-name.png.bak", // hidden: longer than what is there
      "attachments/attachments/deep.png", // visible
      "attachments/deep.png", // visible
      "loose.png", // visible, no folder
      "missing.png", // hidden, no folder
      "attachments/owner-only.png", // hidden: only an unreadable note has it
      "Attachments/nested.png", // hidden: case-sensitive
      "日本語 before", // visible: no folder, multi-byte
    ];
    const out = await filterReadableBlobs(member, vault, candidates.map(blob));
    const text = (
      await pool.query<{ content: string }>("SELECT content FROM note_index WHERE doc_id = $1", [memberNote])
    ).rows[0].content;
    // Plain substring containment over the readable note is the oracle.
    expect(out.map((b) => b.rel_path)).toEqual(candidates.filter((p) => text.includes(p)));
    expect(out.map((b) => b.rel_path)).toEqual([
      "attachments/attachments/nested.png",
      "attachments/nested.png",
      "attachments/inner.png",
      "x/attachments/inner.png",
      "attachments/long",
      "attachments/attachments/deep.png",
      "attachments/deep.png",
      "loose.png",
      "日本語 before",
    ]);
  });

  it("scopes a folder-granted member to exactly the right blobs (#343)", async () => {
    // The member reads one folder by name and nothing else; the vault itself
    // gives no vault-wide read. Every case is a real blob row, run through the
    // same `SELECT … ORDER BY rel_path` shape the list route hands in.
    const shared = await seedFolder(vault, null, "Shared", "Shared", owner);
    const closed = await seedFolder(vault, null, "Closed", "Closed", owner);
    await seedShare(org, "folder", shared, member, "view");
    const readNote = await seedNote(vault, shared, "Shared/Read.md", owner);
    const hiddenNote = await seedNote(vault, closed, "Closed/Hidden.md", owner);
    const openFile = await seedFile(vault, shared, "Shared/report.pdf");
    const closedFile = await seedFile(vault, closed, "Closed/budget.xlsx");
    await seedBlob(vault, org, "Shared/report.pdf", { docId: openFile });
    await seedBlob(vault, org, "Closed/budget.xlsx", { docId: closedFile });
    // Paths of several lengths, embedded more than once and back to back, as a
    // wikilink and a markdown image; one is a prefix of another, one has the
    // anchor again inside it, and one appears only in the unreadable note.
    const visible = [
      "attachments/a.png",
      "attachments/a.png.bak",
      "attachments/Screenshot 2026-10-01 at 12.33.07 é.png",
      "attachments/sub/attachments/deep.png",
    ];
    for (const p of [...visible, "attachments/secret.png", "attachments/orphan.png"]) {
      await seedBlob(vault, org, p);
    }
    await seedIndex(
      vault,
      readNote,
      "Résumé ✓\n![[attachments/a.png]]![](attachments/a.png.bak)\n" +
        "![](attachments/Screenshot 2026-10-01 at 12.33.07 é.png) and again " +
        "![[attachments/Screenshot 2026-10-01 at 12.33.07 é.png]]\n" +
        "see attachments/sub/attachments/deep.png\n",
    );
    await seedIndex(vault, hiddenNote, "![](attachments/secret.png) ![](attachments/a.png)");

    const { rows } = await pool.query<{ id: string; rel_path: string; doc_id: string | null }>(
      "SELECT id, rel_path, doc_id FROM blobs WHERE vault_id = $1 AND status = 'ready' ORDER BY rel_path",
      [vault],
    );
    const out = await filterReadableBlobs(member, vault, rows);
    expect(out.map((b) => b.rel_path)).toEqual(
      rows.map((b) => b.rel_path).filter((p) => p === "Shared/report.pdf" || visible.includes(p)),
    );
  });

  it("gives a vault-wide reader every blob, referenced or not", async () => {
    // "Vault-wide" is the org grant, not the role. The rest of this file keeps
    // the vault Private on purpose — that is what gives the member an empty
    // readable set — so the grant goes on here and nowhere else. Before
    // Private stopped exempting owners, the role alone answered this and the
    // distinction was invisible.
    await seedVaultGrant(org, "edit");
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
