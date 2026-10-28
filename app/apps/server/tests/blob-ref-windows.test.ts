import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { filterReadableBlobs } from "../src/permissions/http-gates.js";
import {
  REF_WINDOW_CHARS,
  flushRefWindowRefreshes,
  refText,
  refreshVaultRefWindows,
} from "../src/blobs/ref-windows.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedBlob, seedFile, seedFolder, seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

/**
 * #343: a scoped member's attachment list reads each note's reference excerpt
 * (`note_index.ref_text`) instead of its full text whenever the excerpt covers
 * the anchors asked about. These pin that the excerpt gives the SAME answer as
 * the text, and that the pre-0.1.92 adopted attachment rows are split apart.
 */

const blob = (rel_path: string) => ({ id: `blob:${rel_path}`, rel_path });

async function seedIndex(vaultId: string, docId: string, content: string): Promise<void> {
  await pool.query("INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, $3, $4)", [
    docId,
    vaultId,
    docId,
    content,
  ]);
}

/** Deterministic noise with path-ish characters, non-ASCII and anchors mixed in. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const ALPHABET = "abcxyz/ -._é漢</>\"'[]()!\n";

describe("reference excerpts (#343)", () => {
  let org: string;
  let member: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    org = await seedOrg("Refs Co", `refs-${randomUUID().slice(0, 6)}`);
    const owner = await seedUser(`owner+${randomUUID()}@refs.test`);
    member = await seedUser(`member+${randomUUID()}@refs.test`);
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    vault = await seedVault(org);
    await seedFolder(vault, null, "Projects", "Projects");
  });
  afterAll(async () => {
    await pool.end();
  });

  const visible = async (paths: string[]) =>
    (await filterReadableBlobs(member, vault, paths.map(blob))).map((b) => b.rel_path).sort();

  it("an excerpt keeps every occurrence of each head with the window after it", () => {
    const text = "x attachments/a.png y attachments/b c Projects/p/q.pdf";
    const out = refText(text, ["Projects/", "attachments/"]);
    expect(out.split("\n").sort()).toEqual(["Projects/p/q.pdf", "attachments/a.png y attachments/b c Projects/p/q.pdf", "attachments/b c Projects/p/q.pdf"].sort());
    expect(refText("nothing here", ["attachments/"])).toBe("");
  });

  it("answers from excerpts exactly as from full text, random notes and paths", async () => {
    const r = rng(343);
    const word = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join("");
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `attachments/${word(3 + (i % 9))}-${i}.png`),
      ...Array.from({ length: 10 }, (_, i) => `Projects/${word(4)}/é 漢 ${i}.pdf`),
      // Longer than the window: matched on text, only where the excerpt has its start.
      `attachments/${"long-".repeat(140)}end.png`,
      `attachments/${"long-".repeat(140)}other.png`,
    ];
    for (const p of paths) await seedBlob(vault, org, p);
    for (let n = 0; n < 12; n++) {
      const doc = await seedNote(vault, null, `N${n}.md`, member);
      let text = word(200);
      for (const p of paths.slice(0, 40)) if (r() < 0.15) text += word(Math.floor(r() * 50)) + p + word(Math.floor(r() * 50));
      if (n === 0) text += `![](attachments/${"long-".repeat(140)}end.png)`;
      // A truncated long path and an anchor cut short: neither may match.
      if (n === 1) text += `attachments/${"long-".repeat(140)}` + "ATTACHMENTS/x" + word(5000);
      await seedIndex(vault, doc, text);
    }
    const all = paths.map((p) => p);

    const fromText = await visible(all);
    await refreshVaultRefWindows(vault);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM note_index WHERE vault_id = $1 AND ref_heads IS NULL", [vault]);
    expect(rows[0].n).toBe(0);
    const fromExcerpts = await visible(all);
    expect(fromExcerpts).toEqual(fromText);
    expect(fromText).toContain(`attachments/${"long-".repeat(140)}end.png`);
    expect(fromText).not.toContain(`attachments/${"long-".repeat(140)}other.png`);
  });

  it("a huge note with no references costs only an empty excerpt", async () => {
    await seedBlob(vault, org, "attachments/pic.png");
    const big = await seedNote(vault, null, "app.html", member);
    await seedIndex(vault, big, "<div>" + "x</span>".repeat(200_000) + "</div>");
    const small = await seedNote(vault, null, "Small.md", member);
    await seedIndex(vault, small, "![](attachments/pic.png)");
    await refreshVaultRefWindows(vault);
    const { rows } = await pool.query<{ len: number }>("SELECT length(ref_text) AS len FROM note_index WHERE doc_id = $1", [big]);
    expect(rows[0].len).toBe(0);
    expect(await visible(["attachments/pic.png"])).toEqual(["attachments/pic.png"]);
  });

  it("a head added after the excerpts falls back to text, then refreshes", async () => {
    const doc = await seedNote(vault, null, "N.md", member);
    await seedIndex(vault, doc, "see Brand-new/logo.svg here");
    await refreshVaultRefWindows(vault);
    // A blob under a folder the excerpts were not built for.
    await seedBlob(vault, org, "Brand-new/logo.svg");
    expect(await visible(["Brand-new/logo.svg"])).toEqual(["Brand-new/logo.svg"]);
    await flushRefWindowRefreshes();
    const { rows } = await pool.query<{ heads: string[] }>("SELECT ref_heads AS heads FROM note_index WHERE doc_id = $1", [doc]);
    expect(rows[0].heads).toContain("Brand-new/");
    expect(await visible(["Brand-new/logo.svg"])).toEqual(["Brand-new/logo.svg"]);
  });

  it("splits attachment rows a copied file adopted before 0.1.92 (migration 063)", async () => {
    const repair = readFileSync(
      new URL("../migrations/063_note_ref_windows_and_attachment_split.sql", import.meta.url),
      "utf8",
    );
    const projects = (await pool.query<{ id: string }>("SELECT id FROM folders WHERE vault_id = $1", [vault])).rows[0].id;
    // A: adopted, attachment never re-uploaded. B: adopted, attachment uploaded again since.
    const fileA = await seedFile(vault, projects, "Projects/a-copy.png");
    const fileB = await seedFile(vault, projects, "Projects/b-copy.png");
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const rowA = await seedBlob(vault, org, "attachments/a.png", { docId: fileA, sha256: shaA });
    const rowB = await seedBlob(vault, org, "attachments/b.png", { docId: fileB, sha256: shaB });
    await seedBlob(vault, org, "attachments/b.png", { docId: null, sha256: shaB });
    // Untouched: a file's own row, and an attachment.
    const ownFile = await seedFile(vault, projects, "Projects/c.png");
    const rowC = await seedBlob(vault, org, "Projects/c.png", { docId: ownFile, sha256: "c".repeat(64) });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(repair);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const rows = async (sha: string) =>
      (
        await pool.query<{ id: string; doc_id: string | null; rel_path: string }>(
          "SELECT id, doc_id, rel_path FROM blobs WHERE vault_id = $1 AND sha256 = $2 ORDER BY doc_id NULLS FIRST",
          [vault, sha],
        )
      ).rows;
    const a = await rows(shaA);
    expect(a).toEqual([
      { id: rowA, doc_id: null, rel_path: "attachments/a.png" },
      { id: expect.any(String), doc_id: fileA, rel_path: "Projects/a-copy.png" },
    ]);
    const b = await rows(shaB);
    expect(b.map((r) => [r.doc_id, r.rel_path])).toEqual([
      [null, "attachments/b.png"],
      [fileB, "Projects/b-copy.png"],
    ]);
    expect(b.find((r) => r.doc_id === fileB)?.id).toBe(rowB);
    expect(await rows("c".repeat(64))).toEqual([{ id: rowC, doc_id: ownFile, rel_path: "Projects/c.png" }]);
  });

  it("keeps the window the list relies on", () => {
    expect(REF_WINDOW_CHARS).toBeGreaterThanOrEqual(256);
  });
});
