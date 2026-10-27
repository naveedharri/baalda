// SPDX-License-Identifier: Apache-2.0
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool, resetDb } from "./helpers/db.js";
import { seedMember, seedOrg, seedUser, seedVault } from "./helpers/seed.js";
import { filterReadableBlobs } from "../src/permissions/http-gates.js";
import { listReadableDocsInVault } from "../src/permissions/vault-docs.js";

/**
 * The blob list for a member scoped to some folders (#338, #343). A vault of a
 * few thousand notes and a couple of thousand attachments used to run the
 * attachment reference check as one LIKE per (path, readable note) pair, which
 * blew through the statement timeout; the first rewrite still timed out on a
 * real vault, because its fixture here had one embed per note and every path
 * the same length. This one has human-length names (dozens of distinct
 * lengths, multi-byte), several embeds per note in two syntaxes and a heavy
 * note every 50. The answer is checked against an independent substring
 * oracle, so speed cannot have been bought by changing who sees what.
 */

let org: string;
let member: string;
let vault: string;

const NOTES = 3100;
const FOLDERS = 200;
const ATTACHMENTS = 1750;
const FILES = 430;

beforeAll(async () => {
  await resetDb();
  org = await seedOrg("Scale", "blob-list-scale");
  const owner = await seedUser("owner@bloblist.test");
  await seedMember(org, owner, "owner");
  member = await seedUser("member@bloblist.test");
  await seedMember(org, member, "member");
  vault = await seedVault(org);
  await pool.query("DELETE FROM member_access_snapshots WHERE organization_id = $1", [org]);

  await pool.query(
    `INSERT INTO folders (id, vault_id, parent_id, name, path)
     SELECT 'fo' || i, $1, NULL, 'F' || i, 'F' || i FROM generate_series(0, $2 - 1) i`,
    [vault, FOLDERS],
  );
  // The member reads half the folders by name.
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     SELECT 'sh' || i, $1, 'folder', 'fo' || i, 'user', $2, 'view' FROM generate_series(0, $3 / 2 - 1) i`,
    [org, member, FOLDERS],
  );
  // Live notes with a few KB of text (multi-byte characters included, so a
  // character/byte mix-up in the matching would show) and one embed each. Of
  // the attachments, about half are referenced only by notes the member cannot
  // read and the last 150 by nobody.
  await pool.query(
    `INSERT INTO notes (id, doc_id, vault_id, folder_id, rel_path, created_by)
     SELECT 'n' || i, 'n' || i, $1, 'fo' || (i % $3), 'F' || (i % $3) || '/n' || i || '.md', $4
       FROM generate_series(1, $2) i`,
    [vault, NOTES, FOLDERS, owner],
  );
  await pool.query(
    `INSERT INTO note_index (doc_id, vault_id, title, content)
     SELECT 'n' || i, $1, 'n' || i,
            repeat(md5(i::text) || ' é ', 70)
              || coalesce((
                   SELECT string_agg(
                            E'\\n![](attachments/' || substr(md5('a' || j), 1, 4 + j % 40) || ' é ' || j
                              || E'.png)\\n![[attachments/' || substr(md5('a' || j), 1, 4 + j % 40) || ' é ' || j
                              || '.png]] ' || md5(k::text), '')
                     FROM generate_series(1, CASE WHEN i % 50 = 0 THEN 120 ELSE i % 9 END) k,
                          LATERAL (SELECT (i * 13 + k * 101) % 1600 AS j) jj), '')
              || repeat(md5((i * 7)::text) || ' ', 30)
       FROM generate_series(1, $2) i
     ON CONFLICT (doc_id) DO UPDATE SET vault_id = EXCLUDED.vault_id, content = EXCLUDED.content`,
    [vault, NOTES],
  );
  // Soft-deleted history the readable-set queries have to wade past.
  await pool.query(
    `INSERT INTO notes (id, doc_id, vault_id, folder_id, rel_path, created_by, deleted_at)
     SELECT 'd' || i, 'd' || i, $1, 'fo' || (i % $3), 'F' || (i % $3) || '/d' || i || '.md', $4, now()
       FROM generate_series(1, $2::int) i`,
    [vault, 4000, FOLDERS, owner],
  );
  await pool.query(
    `INSERT INTO files (id, vault_id, folder_id, path)
     SELECT 'fi' || i, $1, 'fo' || (i % $3), 'F' || (i % $3) || '/file' || i || '.pdf'
       FROM generate_series(1, $2) i`,
    [vault, FILES, FOLDERS],
  );
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data, doc_id)
     SELECT 'bf' || i, $1, $2, md5('f' || i) || md5('g' || i), 1, 'application/pdf',
            'F' || (i % $4) || '/file' || i || '.pdf', 'file' || i || '.pdf',
            'postgres', 'ready', '\\x01'::bytea, 'fi' || i
       FROM generate_series(1, $3) i`,
    [vault, org, FILES, FOLDERS],
  );
  await pool.query(
    `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, rel_path, filename,
                        storage_provider, status, data, doc_id)
     SELECT 'ba' || j, $1, $2, md5('a' || j) || md5('b' || j), 1, 'image/png',
            'attachments/' || substr(md5('a' || j), 1, 4 + j % 40) || ' é ' || j || '.png', 'a' || j || '.png',
            'postgres', 'ready', '\\x01'::bytea, NULL
       FROM generate_series(0, $3 - 1) j`,
    [vault, org, ATTACHMENTS],
  );
}, 120_000);

afterAll(() => pool.end());

it("filters a large vault's blob list for a scoped member quickly, with the same answer", async () => {
  const { rows } = await pool.query<{ id: string; rel_path: string; doc_id: string | null }>(
    "SELECT id, rel_path, doc_id FROM blobs WHERE vault_id = $1 AND status = 'ready' ORDER BY rel_path",
    [vault],
  );
  expect(rows.length).toBe(FILES + ATTACHMENTS);

  const started = performance.now();
  const visible = await filterReadableBlobs(member, vault, rows);
  const elapsed = performance.now() - started;
  console.info(`blob list filter, ${NOTES} notes / ${rows.length} blobs: ${Math.round(elapsed)} ms`);

  // Oracle: a tree file is visible iff its doc is readable; an attachment iff
  // the text of a readable note contains its path verbatim.
  const readable = await listReadableDocsInVault(member, vault);
  const texts = await pool.query<{ content: string }>(
    "SELECT content FROM note_index WHERE vault_id = $1 AND doc_id = ANY($2::text[])",
    [vault, [...readable]],
  );
  const expected = rows.filter((b) =>
    b.doc_id
      ? readable.has(b.doc_id)
      : texts.rows.some((t) => t.content.includes(b.rel_path)),
  );
  expect(visible.map((b) => b.id)).toEqual(expected.map((b) => b.id));
  // Sanity: the fixture really exercises both answers in both branches.
  expect(visible.some((b) => b.doc_id)).toBe(true);
  expect(visible.some((b) => !b.doc_id)).toBe(true);
  expect(visible.filter((b) => b.doc_id).length).toBeLessThan(FILES);
  expect(visible.filter((b) => !b.doc_id).length).toBeLessThan(ATTACHMENTS - 150);
  expect(elapsed).toBeLessThan(2000);
}, 120_000);
