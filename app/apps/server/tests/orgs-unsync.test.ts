import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { makeFakeProvider } from "./helpers/billing-provider.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedBlob,
  seedFile,
  seedFolder,
  seedMember,
  seedNote,
  seedShare,
  seedVault,
} from "./helpers/seed.js";

/**
 * "Make this vault local only" — `POST /api/orgs/:orgId/unsync`, its preview,
 * and `GET /api/orgs/:orgId/status`.
 *
 * The unsync runs the SAME teardown as `DELETE /api/orgs/:orgId`, so these
 * suites deliberately re-assert the delete's contract (billing first, the
 * tombstone, the hand-purge of the FK-less tables) against the new route: the
 * shared helper is what keeps them equal, and this is what notices if someone
 * forks it.
 *
 * The listings suite at the bottom is the R1 safety property: after a vault is
 * gone, the registry listings must 404. A `200 []` there would reach a
 * teammate's device as "every note you hold was revoked" and let the inbound
 * planner delete their files.
 */

const fakeProvider = makeFakeProvider();
const rec = recordingAppDeps({ billingProvider: fakeProvider });
const app = createApp(rec.deps);

function req(
  method: string,
  path: string,
  opts: { user?: TestUser; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.user) Object.assign(headers, authHeaders(opts.user));
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

interface Fixture {
  owner: TestUser;
  admin: TestUser;
  member: TestUser;
  orgId: string;
  orgName: string;
  vaultId: string;
  folderId: string;
  noteId: string;
  fileId: string;
}

/**
 * One org carrying a row in every table the teardown has to reach — including
 * the six with no FK to the organization, which a cascade alone would orphan.
 */
async function seedFullVault(tag: string): Promise<Fixture> {
  const owner = await signUp(`owner@${tag}.test`);
  const orgName = `Vault ${tag}`;
  const org = await createOrg(owner, orgName, `vault-${tag}`);
  const admin = await signUp(`admin@${tag}.test`);
  await seedMember(org.id, admin.userId, "admin");
  const member = await signUp(`member@${tag}.test`);
  await seedMember(org.id, member.userId, "member");

  const vaultId = await seedVault(org.id, "Notes");
  const folderId = await seedFolder(vaultId, null, "Projects", "Projects", owner.userId);
  const noteId = await seedNote(vaultId, folderId, "Projects/a.md", owner.userId);
  // A soft-deleted note: already gone as far as any client is concerned, so it
  // must not inflate the count the confirm dialog shows.
  const trashed = await seedNote(vaultId, folderId, "Projects/old.md", owner.userId);
  await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [trashed]);
  const fileId = await seedFile(vaultId, folderId, "Projects/spec.pdf");
  await seedBlob(vaultId, org.id, "Projects/spec.pdf", { docId: fileId, size: 4096 });
  await seedShare(org.id, "file", fileId, member.userId, "view");

  // The FK-less stores + derived caches the route purges by hand.
  await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)", [
    noteId,
    Buffer.from([1, 2, 3]),
  ]);
  await pool.query(
    `INSERT INTO doc_snapshots (doc_id, snapshot, state_vector, seq, updated_at)
     VALUES ($1, $2, $3, 1, now())`,
    [noteId, Buffer.from([1]), Buffer.from([2])],
  );
  await pool.query("INSERT INTO doc_state_vectors (doc_id, state_vector) VALUES ($1, $2)", [
    noteId,
    Buffer.from([2]),
  ]);
  await pool.query(
    "INSERT INTO note_index (doc_id, vault_id, title, content) VALUES ($1, $2, 'A', 'body')",
    [noteId, vaultId],
  );
  await pool.query(
    "INSERT INTO note_links (vault_id, from_doc, to_title) VALUES ($1, $2, 'B')",
    [vaultId, noteId],
  );
  await pool.query(
    `INSERT INTO public_links (id, doc_id, vault_id, org_id, token, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), noteId, vaultId, org.id, randomUUID(), owner.userId],
  );
  await pool.query(
    `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, 'cli', $4, 'mcp_ab12')`,
    [randomUUID(), owner.userId, org.id, randomUUID()],
  );
  await pool.query(
    "INSERT INTO vault_checkpoints (id, vault_id, kind, label) VALUES ($1, $2, 'manual', 'before')",
    [randomUUID(), vaultId],
  );

  // Every member's live session points at this vault, so the dangling-pointer
  // assertion has something to be about.
  await pool.query(`UPDATE session SET "activeOrganizationId" = $1`, [org.id]);

  return { owner, admin, member, orgId: org.id, orgName, vaultId, folderId, noteId, fileId };
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(sql, params);
  return Number(rows[0].c);
}

describe("unsync preview", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    fakeProvider.reset();
  });

  it("counts what the teardown would destroy, excluding the owner and trashed notes", async () => {
    const f = await seedFullVault("prev1");
    const res = await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: f.owner });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgName: f.orgName,
      notes: 1,
      files: 1,
      folders: 1,
      attachmentBytes: 4096,
      members: 2,
      publicLinks: 1,
      mcpTokens: 1,
      checkpoints: 1,
      subscription: null,
    });
    // Pure SELECTs: the preview must never be the thing that breaks a vault.
    expect(await countRows("SELECT count(*)::bigint AS c FROM notes", [])).toBe(2);
  });

  it("refuses an admin (403 owner_only), a member (403) and a stranger (404)", async () => {
    const f = await seedFullVault("prev2");
    const stranger = await signUp("stranger@prev2.test");

    const asAdmin = await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: f.admin });
    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.json()).toEqual({ error: "owner_only" });

    expect((await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: f.member })).status).toBe(403);

    const asStranger = await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: stranger });
    expect(asStranger.status).toBe(404);
    expect(await asStranger.json()).toEqual({ error: "vault_not_found" });

    expect((await req("GET", `/api/orgs/${randomUUID()}/unsync-preview`, { user: f.owner })).status).toBe(404);
    expect((await req("GET", `/api/orgs/${f.orgId}/unsync-preview`)).status).toBe(401);
  });
});

describe("unsync", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    fakeProvider.reset();
  });

  it("removes every trace of the vault and reports the preview's counts", async () => {
    const f = await seedFullVault("uns1");
    const preview = (await (
      await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: f.owner })
    ).json()) as { notes: number; files: number; members: number };

    const res = await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      unsynced: true,
      notes: preview.notes,
      files: preview.files,
      members: preview.members,
      subscription: null,
    });

    const gone: Array<[string, string, unknown[]]> = [
      ["organization", "SELECT count(*)::bigint AS c FROM organization WHERE id = $1", [f.orgId]],
      ["member", `SELECT count(*)::bigint AS c FROM member WHERE "organizationId" = $1`, [f.orgId]],
      ["vaults", "SELECT count(*)::bigint AS c FROM vaults WHERE organization_id = $1", [f.orgId]],
      ["notes", "SELECT count(*)::bigint AS c FROM notes WHERE vault_id = $1", [f.vaultId]],
      ["files", "SELECT count(*)::bigint AS c FROM files WHERE vault_id = $1", [f.vaultId]],
      ["folders", "SELECT count(*)::bigint AS c FROM folders WHERE vault_id = $1", [f.vaultId]],
      ["shares", "SELECT count(*)::bigint AS c FROM shares WHERE org_id = $1", [f.orgId]],
      ["doc_updates", "SELECT count(*)::bigint AS c FROM doc_updates WHERE doc_id = $1", [f.noteId]],
      ["doc_snapshots", "SELECT count(*)::bigint AS c FROM doc_snapshots WHERE doc_id = $1", [f.noteId]],
      ["doc_state_vectors", "SELECT count(*)::bigint AS c FROM doc_state_vectors WHERE doc_id = $1", [f.noteId]],
      ["note_index", "SELECT count(*)::bigint AS c FROM note_index WHERE vault_id = $1", [f.vaultId]],
      ["note_links", "SELECT count(*)::bigint AS c FROM note_links WHERE vault_id = $1", [f.vaultId]],
      ["blobs", "SELECT count(*)::bigint AS c FROM blobs WHERE org_id = $1", [f.orgId]],
      ["public_links", "SELECT count(*)::bigint AS c FROM public_links WHERE org_id = $1", [f.orgId]],
      ["mcp_tokens", "SELECT count(*)::bigint AS c FROM mcp_tokens WHERE organization_id = $1", [f.orgId]],
      ["vault_checkpoints", "SELECT count(*)::bigint AS c FROM vault_checkpoints WHERE vault_id = $1", [f.vaultId]],
    ];
    for (const [label, sql, params] of gone) {
      expect(`${label}=${await countRows(sql, params)}`).toBe(`${label}=0`);
    }

    // The vault channel is told per collection — `disconnectDoc` cannot reach it.
    expect(rec.aclBroadcasts).toEqual([f.vaultId]);
    // Every doc, including the soft-deleted note: a live socket on one of those
    // could still re-append a `doc_updates` row after the purge.
    const kicked = rec.disconnected.map((d) => d.docId);
    expect(kicked).toContain(f.noteId);
    expect(kicked).toContain(f.fileId);
    expect(kicked).toHaveLength(3);
  });

  it("clears the dangling activeOrganizationId on every member's session", async () => {
    const f = await seedFullVault("uns2");
    expect(
      await countRows(`SELECT count(*)::bigint AS c FROM session WHERE "activeOrganizationId" = $1`, [f.orgId]),
    ).toBeGreaterThanOrEqual(3);

    await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });

    // `session` has no FK to `organization`, so nothing else would clear these,
    // and a reload would ask for a vault nobody can resolve.
    expect(
      await countRows(`SELECT count(*)::bigint AS c FROM session WHERE "activeOrganizationId" = $1`, [f.orgId]),
    ).toBe(0);
  });

  it("refuses a wrong confirmName with 409 and destroys nothing", async () => {
    const f = await seedFullVault("uns3");
    const res = await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: "vault uns3" }, // right letters, wrong case
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_mismatch" });

    expect(await countRows("SELECT count(*)::bigint AS c FROM organization WHERE id = $1", [f.orgId])).toBe(1);
    expect(await countRows("SELECT count(*)::bigint AS c FROM notes WHERE vault_id = $1", [f.vaultId])).toBe(2);
    expect(rec.aclBroadcasts).toEqual([]);

    // A missing body is a mismatch too, never an accidental confirmation.
    expect((await req("POST", `/api/orgs/${f.orgId}/unsync`, { user: f.owner })).status).toBe(409);
    // Surrounding whitespace is forgiven; the name is not.
    const ok = await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: `  ${f.orgName}  ` },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses an admin, a member and a stranger without destroying anything", async () => {
    const f = await seedFullVault("uns4");
    const stranger = await signUp("stranger@uns4.test");
    const body = { confirmName: f.orgName };

    const asAdmin = await req("POST", `/api/orgs/${f.orgId}/unsync`, { user: f.admin, body });
    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.json()).toEqual({ error: "owner_only" });
    expect((await req("POST", `/api/orgs/${f.orgId}/unsync`, { user: f.member, body })).status).toBe(403);

    const asStranger = await req("POST", `/api/orgs/${f.orgId}/unsync`, { user: stranger, body });
    expect(asStranger.status).toBe(404);
    expect(await asStranger.json()).toEqual({ error: "vault_not_found" });

    expect((await req("POST", `/api/orgs/${f.orgId}/unsync`, { body })).status).toBe(401);
    expect(await countRows("SELECT count(*)::bigint AS c FROM organization WHERE id = $1", [f.orgId])).toBe(1);
    expect(rec.aclBroadcasts).toEqual([]);
  });
});

describe("unsync and the subscription", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    fakeProvider.reset();
    process.env.POLAR_ACCESS_TOKEN = "test-polar-access-token"; // billing ON
  });
  afterEach(() => {
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  async function seedSubscription(orgId: string, subId: string): Promise<void> {
    await pool.query(
      `INSERT INTO subscriptions (organization_id, provider, provider_customer_id,
         provider_subscription_id, plan, status, current_period_end,
         cancel_at_period_end, interval, amount, currency)
       VALUES ($1, 'polar', 'cus_test', $2, 'pro', 'active', $3, false, 'month', 1000, 'usd')`,
      [orgId, subId, new Date(Date.now() + 30 * 86400_000)],
    );
  }

  it("cancels at period end first and leaves the row as a tombstone", async () => {
    const f = await seedFullVault("sub1");
    await seedSubscription(f.orgId, "sub_unsync1");

    // The preview reports the live subscription so the dialog can say when Pro ends.
    const preview = (await (
      await req("GET", `/api/orgs/${f.orgId}/unsync-preview`, { user: f.owner })
    ).json()) as { subscription: { status: string; cancelAtPeriodEnd: boolean } | null };
    expect(preview.subscription?.status).toBe("active");
    expect(preview.subscription?.cancelAtPeriodEnd).toBe(false);

    const res = await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
    };
    // period_end, not revoke: the owner already paid for this month.
    expect(fakeProvider.canceled).toEqual([{ id: "sub_unsync1", mode: "period_end" }]);
    expect(body.subscription?.cancelAtPeriodEnd).toBe(true);

    const { rows } = await pool.query<{
      deleted_at: Date | null;
      org_name: string | null;
      owner_user_id: string | null;
    }>(
      "SELECT deleted_at, org_name, owner_user_id FROM subscriptions WHERE organization_id = $1",
      [f.orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].org_name).toBe(f.orgName);
    expect(rows[0].owner_user_id).toBe(f.owner.userId);
  });

  it("aborts with 502 and destroys nothing when the provider refuses", async () => {
    const f = await seedFullVault("sub2");
    await seedSubscription(f.orgId, "sub_unsync2");
    fakeProvider.failCancel = new Error("polar is down");

    const res = await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("subscription_cancel_failed");
    expect(body.message).toContain("polar is down");

    // A provider outage must not cost someone a vault while Polar keeps charging.
    expect(await countRows("SELECT count(*)::bigint AS c FROM organization WHERE id = $1", [f.orgId])).toBe(1);
    expect(await countRows("SELECT count(*)::bigint AS c FROM notes WHERE vault_id = $1", [f.vaultId])).toBe(2);
    expect(
      await countRows(`SELECT count(*)::bigint AS c FROM session WHERE "activeOrganizationId" = $1`, [f.orgId]),
    ).toBeGreaterThan(0);
    expect(rec.aclBroadcasts).toEqual([]);
    expect(rec.disconnected).toEqual([]);
  });
});

describe("vault status probe", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    fakeProvider.reset();
  });

  it("answers 200 for a member, 403 for a non-member and 404 once the vault is gone", async () => {
    const f = await seedFullVault("st1");
    const stranger = await signUp("stranger@st1.test");

    const asMember = await req("GET", `/api/orgs/${f.orgId}/status`, { user: f.member });
    expect(asMember.status).toBe(200);
    expect(await asMember.json()).toEqual({ orgId: f.orgId, name: f.orgName, role: "member" });

    const asOwner = (await (
      await req("GET", `/api/orgs/${f.orgId}/status`, { user: f.owner })
    ).json()) as { role: string };
    expect(asOwner.role).toBe("owner");

    // Exists but not mine → forbidden, which is what keeps `blocked-foreign`
    // refusing another account's folder.
    const forbidden = await req("GET", `/api/orgs/${f.orgId}/status`, { user: stranger });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "not_a_member" });

    expect((await req("GET", `/api/orgs/${f.orgId}/status`)).status).toBe(401);

    await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });

    // Gone, for everyone — this is the signal that a stamped folder is safe to
    // re-adopt instead of being refused forever.
    for (const user of [f.owner, f.member, stranger]) {
      const res = await req("GET", `/api/orgs/${f.orgId}/status`, { user });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "vault_not_found" });
    }
  });
});

describe("R1 — a dead vault's listings refuse, they never answer empty", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    fakeProvider.reset();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("404s every registry listing and the access-check after an unsync", async () => {
    const f = await seedFullVault("r1");
    // Baseline: while the vault lives, these all answer 200.
    for (const path of [
      `/api/folders?vaultId=${f.vaultId}`,
      `/api/notes?vaultId=${f.vaultId}`,
      `/api/files?vaultId=${f.vaultId}`,
      `/api/notes?vaultId=${f.vaultId}&limit=2`,
    ]) {
      expect((await req("GET", path, { user: f.owner })).status).toBe(200);
    }

    await req("POST", `/api/orgs/${f.orgId}/unsync`, {
      user: f.owner,
      body: { confirmName: f.orgName },
    });

    // THE safety property. A `200 []` here reaches a teammate's device as "every
    // doc you hold was revoked"; the pull has to THROW so `planInbound` never
    // runs and not one local file is removed.
    for (const user of [f.owner, f.member]) {
      for (const path of [
        `/api/folders?vaultId=${f.vaultId}`,
        `/api/folders?vaultId=${f.vaultId}&limit=2`,
        `/api/notes?vaultId=${f.vaultId}`,
        `/api/notes?vaultId=${f.vaultId}&limit=2`,
        `/api/files?vaultId=${f.vaultId}`,
        `/api/files?vaultId=${f.vaultId}&limit=2`,
      ]) {
        const res = await req("GET", path, { user });
        expect(`${path} → ${res.status}`).toBe(`${path} → 404`);
        expect(await res.json()).toEqual({ error: "vault_not_found" });
      }

      const check = await req("POST", `/api/vaults/${f.vaultId}/access-check`, {
        user,
        body: { docIds: [f.noteId, f.fileId] },
      });
      expect(check.status).toBe(404);
    }
  });
});
