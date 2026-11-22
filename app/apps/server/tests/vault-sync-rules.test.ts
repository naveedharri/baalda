import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";
import { setSyncRulesChangedPublisher } from "../src/sync/member-events.js";
import { decodePubsub, encodePubsubSyncRulesChanged } from "../src/sync/vault-protocol.js";
import { MAX_PATTERN_LINES, parseSyncRules } from "../src/sync-rules/schema.js";

/** GET/PUT /api/orgs/:orgId/sync-rules — the vault's sync rules (#401). */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

let published: Array<{ vaultId: string; orgId: string; revision: number }> = [];

function get(caller: TestUser, orgId: string) {
  return app.request(`/api/orgs/${orgId}/sync-rules`, { headers: authHeaders(caller) });
}
function put(caller: TestUser, orgId: string, patterns: unknown, baseRevision: unknown) {
  return app.request(`/api/orgs/${orgId}/sync-rules`, {
    method: "PUT",
    headers: { ...authHeaders(caller), "content-type": "application/json" },
    body: JSON.stringify({ rules: { version: 1, patterns }, baseRevision }),
  });
}

async function setup() {
  const owner = await signUp("owner@syncrules.test");
  const org = await createOrg(owner, "Rules", `rules-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  const member = await signUp("member@syncrules.test");
  await seedMember(org.id, member.userId, "member");
  const admin = await signUp("admin@syncrules.test");
  await seedMember(org.id, admin.userId, "admin");
  return { owner, member, admin, orgId: org.id, vaultId };
}

describe("vault sync rules", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
    published = [];
    setSyncRulesChangedPublisher((vaultId, orgId, revision) => published.push({ vaultId, orgId, revision }));
  });
  afterEach(() => setSyncRulesChangedPublisher(null));
  afterAll(async () => {
    await pool.end();
  });

  it("a vault with no rules answers empty rules at revision 0", async () => {
    const { member, orgId } = await setup();
    const res = await get(member, orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rules: { version: 1, patterns: "" },
      revision: 0,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("an owner saves, members read it back, and every vault hears about it", async () => {
    const { owner, member, orgId, vaultId } = await setup();
    const res = await put(owner, orgId, "projects/my-app/code/\n", 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: { patterns: string }; revision: number; updatedBy: string };
    expect(body.rules.patterns).toBe("projects/my-app/code/\n");
    expect(body.revision).toBe(1);
    expect(body.updatedBy).toBe(owner.userId);
    expect(await (await get(member, orgId)).json()).toEqual(body);
    expect(published).toEqual([{ vaultId, orgId, revision: 1 }]);
  });

  it("an admin may save; a member is refused and nothing changes", async () => {
    const { admin, member, orgId } = await setup();
    expect((await put(admin, orgId, "code/", 0)).status).toBe(200);
    const res = await put(member, orgId, "", 1);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "sync_rules_admin_required" });
    expect(((await (await get(member, orgId)).json()) as { rules: { patterns: string } }).rules.patterns).toBe("code/");
  });

  it("a stale baseRevision is refused with the current state", async () => {
    const { owner, admin, orgId } = await setup();
    expect((await put(owner, orgId, "a/", 0)).status).toBe(200);
    const res = await put(admin, orgId, "b/", 0);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; current: { revision: number; rules: { patterns: string } } };
    expect(body.error).toBe("stale_sync_rules");
    expect(body.current.revision).toBe(1);
    expect(body.current.rules.patterns).toBe("a/");
    expect((await put(admin, orgId, "b/", 1)).status).toBe(200);
    expect(published.map((p) => p.revision)).toEqual([1, 2]);
  });

  it("saving the same rules again changes nothing and announces nothing", async () => {
    const { owner, orgId } = await setup();
    await put(owner, orgId, "a/", 0);
    const res = await put(owner, orgId, "a/", 1);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: number }).revision).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("records who changed what syncs in the access history", async () => {
    const { owner, orgId } = await setup();
    await put(owner, orgId, "a/", 0);
    await put(owner, orgId, "b/", 1);
    const { rows } = await pool.query(
      `SELECT actor_user_id, action, before_state, after_state FROM access_audit
        WHERE organization_id = $1 AND entity_type = 'vault_sync_rules' ORDER BY id`,
      [orgId],
    );
    expect(rows).toEqual([
      { actor_user_id: owner.userId, action: "insert", before_state: { patterns: "" }, after_state: { patterns: "a/" } },
      { actor_user_id: owner.userId, action: "update", before_state: { patterns: "a/" }, after_state: { patterns: "b/" } },
    ]);
  });

  it("non-members get 404 on GET and PUT", async () => {
    const { orgId } = await setup();
    const outsider = await signUp("x@syncrules.test");
    for (const res of [await get(outsider, orgId), await put(outsider, orgId, "", 0)]) {
      expect(res.status).toBe(404);
    }
  });

  it("refuses malformed bodies rather than storing them", async () => {
    const { owner, orgId } = await setup();
    expect((await put(owner, orgId, 42, 0)).status).toBe(400);
    expect((await put(owner, orgId, "a/", undefined)).status).toBe(400);
    expect((await put(owner, orgId, "a\u0001b", 0)).status).toBe(400);
    expect((await put(owner, orgId, "x/\n".repeat(MAX_PATTERN_LINES + 1), 0)).status).toBe(400);
    expect(published).toHaveLength(0);
  });

  it("the schema keeps the desktop's caps and ignores comments in the line count", () => {
    expect(parseSyncRules({ patterns: "# c\n\n".repeat(MAX_PATTERN_LINES + 5) }).ok).toBe(true);
    expect(parseSyncRules({ patterns: "a".repeat(64 * 1024 + 1) }).ok).toBe(false);
    expect(parseSyncRules({ patterns: "a", extra: 1 }).ok).toBe(false);
    const crlf = parseSyncRules({ patterns: "a/\r\nb/\r\n" });
    expect(crlf.ok && crlf.rules.patterns).toBe("a/\nb/\n");
  });

  it("the pubsub frame round-trips", () => {
    expect(decodePubsub(encodePubsubSyncRulesChanged("org-1", 7))).toEqual({
      type: "sync-rules-changed",
      orgId: "org-1",
      revision: 7,
    });
  });

  it("/health advertises the feature", async () => {
    const res = await app.request("/health");
    const features = ((await res.json()) as { features: string[] }).features;
    expect(features).toContain("sync-rules");
    expect(features).toContain("more-file-types");
    expect(features).toContain("sync-folder-switches");
  });

  it("stores the folder switches, with one spelling for all-off", () => {
    const on = parseSyncRules({ version: 1, patterns: "", folders: { hidden: true } });
    expect(on.ok && on.rules).toEqual({ version: 1, patterns: "", folders: { hidden: true, build: false } });
    const off = parseSyncRules({ version: 1, patterns: "", folders: { hidden: false, build: false } });
    expect(off.ok && off.rules).toEqual({ version: 1, patterns: "" });
    expect(parseSyncRules({ patterns: "", folders: { git: true } }).ok).toBe(false);
    expect(parseSyncRules({ patterns: "", folders: { build: 1 } }).ok).toBe(false);
  });

  it("stores the file-type switches, with one spelling for all-off", () => {
    const on = parseSyncRules({ version: 1, patterns: "", types: { code: true } });
    expect(on.ok && on.rules).toEqual({ version: 1, patterns: "", types: { code: true, extra: false } });
    const off = parseSyncRules({ version: 1, patterns: "", types: { code: false, extra: false } });
    expect(off.ok && off.rules).toEqual({ version: 1, patterns: "" });
    expect(parseSyncRules({ patterns: "", types: { video: true } }).ok).toBe(false);
    expect(parseSyncRules({ patterns: "", types: { code: "yes" } }).ok).toBe(false);
  });

  it("an owner switches on code files; turning them on again is a no-op", async () => {
    const { owner, member, orgId } = await setup();
    const save = (rev: number) =>
      app.request(`/api/orgs/${orgId}/sync-rules`, {
        method: "PUT",
        headers: { ...authHeaders(owner), "content-type": "application/json" },
        body: JSON.stringify({ rules: { version: 1, patterns: "", types: { code: true } }, baseRevision: rev }),
      });
    expect((await save(0)).status).toBe(200);
    const read = (await (await get(member, orgId)).json()) as { rules: { types?: unknown }; revision: number };
    expect(read.rules.types).toEqual({ code: true, extra: false });
    expect(read.revision).toBe(1);
    expect(((await (await save(1)).json()) as { revision: number }).revision).toBe(1);
    expect(published).toHaveLength(1);
    // A folder switch alone is a real change.
    const folders = await app.request(`/api/orgs/${orgId}/sync-rules`, {
      method: "PUT",
      headers: { ...authHeaders(owner), "content-type": "application/json" },
      body: JSON.stringify({
        rules: { version: 1, patterns: "", types: { code: true }, folders: { build: true } },
        baseRevision: 1,
      }),
    });
    expect(((await folders.json()) as { revision: number }).revision).toBe(2);
  });
});
