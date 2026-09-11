import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { deleteFolderCascade } from "../src/registry/tree-ops.js";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
} from "../src/permissions/vault-docs.js";
import { ACCESS_CHECK_MAX } from "../src/http/routes/registry.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedNote, seedShare, seedVault } from "./helpers/seed.js";

/**
 * The two server-side guards the revocation-removal path leans on.
 *
 * The desktop removes a file when a doc is absent from BOTH the notes listing
 * and the tombstone list, and it removes it OUTRIGHT — no recoverable copy —
 * under a cap an authoritative pass lifts. Everything below exists so that a
 * doc only ever lands in that branch when it genuinely belongs there.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

function post(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

describe("a deleted folder's notes stay DELETES for a share-only member", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let folder: string;
  let inFolder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@rev-safety.test");
    orgId = (await createOrg(owner, "Rev Safety Co", "rev-safety-co")).id;
    member = await signUp("member@rev-safety.test");
    await seedMember(orgId, member.userId, "member");

    vault = await seedVault(orgId, "V");
    folder = await seedFolder(vault, null, "Docs", "Docs");
    inFolder = await seedNote(vault, folder, "Docs/D.md", owner.userId);
    // The member's ONLY access: a per-user share on the folder. This is the
    // private-plus-selective-sharing model, and it is the case that broke.
    await seedShare(orgId, "folder", folder, member.userId, "view");
  });

  it("answers the tombstone after the folder rows are hard-deleted", async () => {
    expect(await listReadableDocsInVault(member.userId, vault)).toEqual(new Set([inFolder]));

    // Deleting a folder soft-deletes its notes and HARD-deletes the folder rows
    // (`notes.folder_id` is ON DELETE SET NULL), so the share that carried the
    // member's access no longer resolves through `folders` at all.
    await deleteFolderCascade(pool, folder);

    expect(await listReadableDocsInVault(member.userId, vault)).toEqual(new Set());
    // The part that regressed. Without it the doc is absent from both lists,
    // which is how the desktop spells REVOKED: removed outright, no
    // `.context/trash` copy, and on an authoritative pass no cap either. An
    // owner tidying up a shared folder while the member's app was closed erased
    // those files on their next launch with no local undo.
    expect(await listDeletedReadableDocsInVault(member.userId, vault)).toEqual(
      new Set([inFolder]),
    );
  });

  it("still says nothing to someone who never had the share", async () => {
    const stranger = await signUp("stranger@rev-safety.test");
    await seedMember(orgId, stranger.userId, "member");
    await deleteFolderCascade(pool, folder);
    expect(await listDeletedReadableDocsInVault(stranger.userId, vault)).toEqual(new Set());
  });

  it("resolves a note under a deleted SUBfolder of a shared one", async () => {
    const sub = await seedFolder(vault, folder, "Sub", "Docs/Sub");
    const deep = await seedNote(vault, sub, "Docs/Sub/E.md", owner.userId);
    await deleteFolderCascade(pool, sub);
    expect(await listDeletedReadableDocsInVault(member.userId, vault)).toEqual(new Set([deep]));
  });

  it("a tombstone cannot claim notes created after it", async () => {
    // The tombstone matches by PATH, and folder shares survive the hard delete —
    // so without a recency guard a long-dead shared folder keeps claiming
    // whatever later lives at the same path, including a brand-new folder nobody
    // shared. Bounded harm (ids only), but it is an id disclosure and it
    // contradicts the doc-id-not-path invariant.
    await deleteFolderCascade(pool, folder);
    const reborn = await seedFolder(vault, null, "Docs", "Docs");
    const fresh = await seedNote(vault, reborn, "Docs/New.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [fresh]);

    const dead = await listDeletedReadableDocsInVault(member.userId, vault);
    expect(dead).toEqual(new Set([inFolder]));
    expect(dead.has(fresh)).toBe(false);
  });

  it("owners keep the whole tombstone set, as before", async () => {
    await deleteFolderCascade(pool, folder);
    expect(await listDeletedReadableDocsInVault(owner.userId, vault)).toEqual(
      new Set([inFolder]),
    );
  });
});

describe("POST /api/vaults/:vaultId/access-check", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let ownerNote: string;
  let sharedNote: string;
  let folder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@access-check.test");
    orgId = (await createOrg(owner, "Access Check Co", "access-check-co")).id;
    member = await signUp("member@access-check.test");
    await seedMember(orgId, member.userId, "member");

    vault = await seedVault(orgId, "V");
    ownerNote = await seedNote(vault, null, "Root.md", owner.userId);
    folder = await seedFolder(vault, null, "Docs", "Docs");
    sharedNote = await seedNote(vault, folder, "Docs/D.md", owner.userId);
    await seedShare(orgId, "folder", folder, member.userId, "view");
  });

  it("names the docs the caller genuinely cannot read, and only those", async () => {
    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: [ownerNote, sharedNote],
    });
    expect(res.status).toBe(200);
    const { none } = (await res.json()) as { none: string[] };
    // The share still resolves for `Docs/D.md`, so the answer DISAGREES with a
    // hypothetical listing that omitted it — which is the whole point: the
    // desktop leaves a disputed file on disk.
    expect(none).toEqual([ownerNote]);
  });

  it("answers the owner with an empty set", async () => {
    const res = await post(owner, `/api/vaults/${vault}/access-check`, {
      docIds: [ownerNote, sharedNote],
    });
    expect((await res.json()) as { none: string[] }).toEqual({ none: [] });
  });

  it("leaves an id with no row in this vault UNANSWERED", async () => {
    // Not `none`. Answering would be a false confirmation on the one route whose
    // job is to be a second opinion, and the client keeps any file it did not get
    // an answer for. A doc that is merely revoked still has a row here, so a real
    // revocation is always answered.
    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: ["no-such-doc"],
    });
    expect((await res.json()) as { none: string[] }).toEqual({ none: [] });
  });

  it("does not answer for an id the caller can read in ANOTHER vault", async () => {
    // The sharpest form of the same thing: this id resolves to `edit` where it
    // lives. Reporting it as unreadable here would corroborate a deletion of a
    // file the caller may read perfectly well.
    const otherVault = await seedVault(orgId, "Other");
    const elsewhere = await seedNote(otherVault, null, "Elsewhere.md", member.userId);
    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: [elsewhere, ownerNote],
    });
    expect((await res.json()) as { none: string[] }).toEqual({ none: [ownerNote] });
  });

  it("answers for a soft-deleted note, which the resolver reports as none", async () => {
    // It has a row, so it reaches `effectivePermission`, which answers `none`
    // through `locateDoc`'s `deleted_at IS NULL` filter. No separate scoping rule
    // needed, and the comment on the query says exactly this.
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [sharedNote]);
    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: [sharedNote],
    });
    expect((await res.json()) as { none: string[] }).toEqual({ none: [sharedNote] });
  });

  it("refuses a non-member and an unknown vault", async () => {
    const stranger = await signUp("stranger@access-check.test");
    await createOrg(stranger, "Other Co", "other-co-access-check");
    expect(
      (await post(stranger, `/api/vaults/${vault}/access-check`, { docIds: [ownerNote] })).status,
    ).toBe(403);
    expect(
      (await post(member, `/api/vaults/does-not-exist/access-check`, { docIds: [] })).status,
    ).toBe(404);
  });

  it("validates the body and bounds the list", async () => {
    expect((await post(member, `/api/vaults/${vault}/access-check`, {})).status).toBe(400);
    const tooMany = Array.from({ length: ACCESS_CHECK_MAX + 1 }, (_, i) => `d${i}`);
    expect(
      (await post(member, `/api/vaults/${vault}/access-check`, { docIds: tooMany })).status,
    ).toBe(400);
  });
});
