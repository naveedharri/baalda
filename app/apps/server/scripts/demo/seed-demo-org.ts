// ============================================================================
//  DEMO SEED — "Test Organization"
//  Builds a big, realistic team vault so you can demo / record Baalda:
//    • 1 organization ("Test Organization")
//    • 15 members with real logins (1 owner, 2 admins, 12 members)
//    • 1 vault, mirroring the folder tree + content of a source vault
//      (path from DEMO_SOURCE_VAULT), plus synthetic "Team Journal" notes so
//      the tree exceeds the target size and looks busy
//    • org-wide EDIT grant so every member can open every note
//    • generated per-folder index notes + a search/graph index over everything
//
//  Run:   npm run seed:demo          (reseeds; --reset first if it exists)
//         DEMO_TARGET_NOTES=8000 npm run seed:demo
//         DEMO_SOURCE_VAULT="/path/to/vault" npm run seed:demo
//
//  Requires local Postgres up (npm run db:up) + a .env with JWT_SECRET.
//  Prints a credentials table at the end.
// ============================================================================

import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import { pool, closePool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { auth } from "../../src/auth/auth.js";
import { seedMember, seedVault, seedVaultGrant } from "../../tests/helpers/seed.js";
import { appendUpdate } from "../../src/yjs/persistence.js";
import { backfillIndex } from "../../src/index/indexer.js";

import { buildTeam, demoConfig, pMapLimit, type TeamMember } from "./config.js";
import {
  buildIndexNotes,
  collectRealNotes,
  folderPathsFor,
  quickNotes,
  readNoteBody,
  synthesizeNotes,
  titleFromRelPath,
  type PlannedNote,
} from "./content.js";

const RESET = process.argv.includes("--reset") || process.env.DEMO_RESET === "1";
/** --quick: seed a tiny 10-note / 2-folder vault for fast iteration. */
const QUICK = process.argv.includes("--quick") || process.env.DEMO_QUICK === "1";

/** Wipe a prior demo org + its demo users so a reseed is clean & idempotent. */
async function resetDemo(): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM organization WHERE slug = $1",
    [demoConfig.orgSlug],
  );
  const orgId = rows[0]?.id;
  // Users that belong to the demo org (includes the owner / you) — collected
  // before we drop the org so we can remove their accounts too.
  const memberUserIds: string[] = [];
  if (orgId) {
    const mem = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM member WHERE "organizationId" = $1`,
      [orgId],
    );
    memberUserIds.push(...mem.rows.map((r) => r.userId));
    const vaults = await pool.query<{ id: string }>(
      "SELECT id FROM vaults WHERE organization_id = $1",
      [orgId],
    );
    const vaultIds = vaults.rows.map((r) => r.id);
    if (vaultIds.length) {
      const docs = await pool.query<{ id: string }>(
        `SELECT id FROM notes WHERE vault_id = ANY($1::text[])
         UNION SELECT id FROM files WHERE vault_id = ANY($1::text[])`,
        [vaultIds],
      );
      const docIds = docs.rows.map((r) => r.id);
      await pool.query("DELETE FROM note_links WHERE vault_id = ANY($1::text[])", [vaultIds]);
      await pool.query("DELETE FROM note_index WHERE vault_id = ANY($1::text[])", [vaultIds]);
      if (docIds.length) {
        await pool.query("DELETE FROM doc_updates WHERE doc_id = ANY($1::text[])", [docIds]);
        await pool.query("DELETE FROM doc_snapshots WHERE doc_id = ANY($1::text[])", [docIds]);
      }
    }
    await pool.query("DELETE FROM shares WHERE org_id = $1", [orgId]);
    // organization cascade removes vaults → folders → notes → files, member, invitation.
    await pool.query("DELETE FROM organization WHERE id = $1", [orgId]);
  }
  // Demo users to remove: the org's members (incl. the owner/you), everyone on
  // the synthetic email domain, and the configured owner email — deduped.
  const like = `%@${demoConfig.emailDomain}`;
  const byDomain = await pool.query<{ id: string }>(
    `SELECT id FROM "user" WHERE email LIKE $1 OR email = $2`,
    [like, demoConfig.ownerEmail],
  );
  const userIds = [...new Set([...memberUserIds, ...byDomain.rows.map((r) => r.id)])];
  if (userIds.length) {
    await pool.query(`DELETE FROM session WHERE "userId" = ANY($1::text[])`, [userIds]);
    await pool.query(`DELETE FROM account WHERE "userId" = ANY($1::text[])`, [userIds]);
    await pool.query(`DELETE FROM member WHERE "userId" = ANY($1::text[])`, [userIds]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [userIds]);
  }
}

/** Create a real, log-in-able user via Better Auth; returns its id. */
async function createUser(m: TeamMember): Promise<string> {
  const res = await auth.api.signUpEmail({
    body: { email: m.email, password: demoConfig.password, name: m.name },
    asResponse: true,
  });
  if (!res.ok) {
    throw new Error(`signUpEmail failed for ${m.email}: ${res.status} ${await res.text()}`);
  }
  const token = res.headers.get("set-auth-token") ?? undefined;
  const body = (await res.json()) as { user?: { id?: string } };
  const userId = body.user?.id;
  if (!userId) throw new Error(`no user id returned for ${m.email}`);
  // Mark verified so signing in with a trusted OAuth provider (e.g. Google) on
  // the same email auto-links to this account instead of erroring
  // `account_not_linked`.
  await pool.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [userId]);
  return userId;
}

/** Insert a notes row with a proper display title (so [[wikilinks]] resolve). */
async function insertNote(
  vaultId: string,
  folderId: string | null,
  relPath: string,
  title: string,
  createdBy: string,
): Promise<string> {
  const docId = randomUUID();
  await pool.query(
    `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6)`,
    [docId, vaultId, folderId, title, relPath, createdBy],
  );
  return docId;
}

/** Persist a note's markdown as the initial binary Y.Doc update. */
async function writeBody(docId: string, body: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, body);
  await appendUpdate(docId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`\n🌱  Seeding "${demoConfig.orgName}" from ${demoConfig.sourceVaultPath}\n`);

  await runMigrations();
  if (RESET) {
    console.log("↺  --reset: clearing any existing demo org + users…");
    await resetDemo();
  }

  const team = buildTeam();
  const owner = team.find((m) => m.role === "owner")!;

  // --- users + org + memberships ------------------------------------------
  console.log(`👤  Creating ${team.length} users (real logins)…`);
  const ownerId = await createUser(owner);
  const ownerRes = await auth.api.signInEmail({
    body: { email: owner.email, password: demoConfig.password },
    asResponse: true,
  });
  const ownerToken = ownerRes.headers.get("set-auth-token");
  const org = (await auth.api.createOrganization({
    headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    body: { name: demoConfig.orgName, slug: demoConfig.orgSlug },
  })) as { id: string };
  const orgId = org.id;

  const userIdByIndex: string[] = [];
  for (const m of team) {
    if (m.role === "owner") {
      userIdByIndex.push(ownerId);
      continue;
    }
    const uid = await createUser(m);
    await seedMember(orgId, uid, m.role);
    userIdByIndex.push(uid);
  }

  const vaultId = await seedVault(orgId, demoConfig.vaultName);
  await seedVaultGrant(orgId, "edit"); // org-wide "Open" → everyone can edit
  console.log(`🏢  Org ${orgId}\n📦  Vault ${vaultId}\n`);

  // --- plan the note set ---------------------------------------------------
  let allNotes: PlannedNote[];
  if (QUICK) {
    // Tiny fixed structure (10 notes, 2 folders) for a fast sync + teammate test.
    allNotes = quickNotes(team);
    console.log(`⚡  --quick: ${allNotes.length} notes in 2 folders`);
  } else {
    console.log("📚  Scanning source vault…");
    const realRel = await collectRealNotes(demoConfig.sourceVaultPath, demoConfig.maxImport);
    console.log(`   found ${realRel.length} real markdown files`);

    const realTitles = realRel.map(titleFromRelPath);
    const synthCount = Math.max(0, demoConfig.targetNotes - realRel.length);
    const synth = synthesizeNotes(synthCount, team, realTitles);
    console.log(`   synthesizing ${synth.length} activity notes → target ${demoConfig.targetNotes}`);

    // Assemble the full planned-note list (real → PlannedNote by lazy read).
    const realPlanned: PlannedNote[] = realRel.map((rel, i) => ({
      relPath: rel,
      title: titleFromRelPath(rel),
      body: "", // filled from disk during the write pass
      authorIndex: i % team.length,
    }));
    const allBeforeIndex = [...realPlanned, ...synth];
    const indexNotes = buildIndexNotes(allBeforeIndex.map((n) => n.relPath));
    allNotes = [...allBeforeIndex, ...indexNotes];
  }

  // Guarantee unique rel-paths: a note's path is its identity in the tree, and
  // the synthesizer can collide (two meetings on the same day+topic). Real files
  // come first so they keep their true paths; collisions get " (n)" appended.
  const seenRel = new Set<string>();
  for (const note of allNotes) {
    if (!seenRel.has(note.relPath)) {
      seenRel.add(note.relPath);
      continue;
    }
    const dot = note.relPath.lastIndexOf(".");
    const base = dot === -1 ? note.relPath : note.relPath.slice(0, dot);
    const ext = dot === -1 ? "" : note.relPath.slice(dot);
    let i = 2;
    while (seenRel.has(`${base} (${i})${ext}`)) i++;
    note.relPath = `${base} (${i})${ext}`;
    seenRel.add(note.relPath);
  }

  // --- create folders (parents first) -------------------------------------
  const folderPaths = folderPathsFor(allNotes.map((n) => n.relPath));
  console.log(`\n🗂️   Creating ${folderPaths.length} folders…`);
  const folderId = new Map<string, string>();
  for (const fp of folderPaths) {
    const name = fp.slice(fp.lastIndexOf("/") + 1);
    const parentPath = fp.includes("/") ? fp.slice(0, fp.lastIndexOf("/")) : null;
    const parentId = parentPath ? (folderId.get(parentPath) ?? null) : null;
    const id = randomUUID();
    await pool.query(
      "INSERT INTO folders (id, vault_id, parent_id, name, path) VALUES ($1,$2,$3,$4,$5)",
      [id, vaultId, parentId, name, fp],
    );
    folderId.set(fp, id);
  }

  // --- create notes + persist bodies (bounded concurrency) ----------------
  console.log(`✍️   Writing ${allNotes.length} notes…`);
  let done = 0;
  await pMapLimit(allNotes, 8, async (note) => {
    const dir = note.relPath.includes("/")
      ? note.relPath.slice(0, note.relPath.lastIndexOf("/"))
      : null;
    const fid = dir ? (folderId.get(dir) ?? null) : null;
    const author = userIdByIndex[note.authorIndex] ?? ownerId;
    const body = note.body
      ? note.body
      : await readNoteBody(demoConfig.sourceVaultPath, note.relPath, demoConfig.maxNoteBytes);
    const docId = await insertNote(vaultId, fid, note.relPath, note.title, author);
    await writeBody(docId, body);
    if (++done % 500 === 0) console.log(`   … ${done}/${allNotes.length}`);
  });

  // --- build search + graph index over everything -------------------------
  console.log(`\n🔎  Indexing (search + wikilink graph)…`);
  await backfillIndex();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅  Done in ${secs}s — ${allNotes.length} notes, ${folderPaths.length} folders.\n`);
  printSummary(team, vaultId, orgId);
}

function printSummary(team: TeamMember[], vaultId: string, orgId: string): void {
  console.log("═".repeat(64));
  console.log(`  ${demoConfig.orgName}   (org ${orgId})`);
  console.log(`  Vault: ${demoConfig.vaultName}   (${vaultId})`);
  console.log(`  Shared password for every account:  ${demoConfig.password}`);
  console.log("─".repeat(64));
  for (const m of team) {
    console.log(`  ${m.role.padEnd(6)}  ${m.name.padEnd(18)}  ${m.email}`);
  }
  console.log("═".repeat(64));
  console.log(`\n  ▶ Log into the desktop app as  ${team[0].email}  (server: http://localhost:3010)`);
  console.log(`  ▶ Then run the live teammates:  npm run demo:activity`);
  console.log(`  ▶ One shot next time (reseed + teammates):  npm run demo\n`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\n❌  Seed failed:\n", err);
    await closePool().catch(() => {});
    process.exit(1);
  });
