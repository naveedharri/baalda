// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pass-through spy: counts index loads without changing behaviour.
const indexLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/permissions/resolver.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/permissions/resolver.js")>();
  return {
    ...mod,
    loadAccessIndex: (...args: Parameters<typeof mod.loadAccessIndex>) => {
      indexLoads.count++;
      return mod.loadAccessIndex(...args);
    },
  };
});

import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { sealVault, seedFile, seedFolder, seedLock, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

const app = createApp(recordingAppDeps().deps);

afterAll(async () => {
  await pool.end();
});

type Board = {
  folders: Array<{ id: string; path: string; color: string | null }>;
  notes: Array<{ id: string; relPath: string }>;
  files: Array<{ id: string; path: string }>;
  modes: string;
  totals: { edit: number; view: number; none: number; mixed: number };
  complete: boolean;
};

const call = (user: TestUser, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function share(
  orgId: string,
  resourceType: "vault" | "folder" | "file",
  resourceId: string,
  principal: { type: "user"; id: string } | { type: "org" },
  permission: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), orgId, resourceType, resourceId, principal.type, principal.type === "org" ? orgId : principal.id, permission],
  );
}

const CHAR = { open: "e", readonly: "v", private: "n", mixed: "m" } as const;

async function board(owner: TestUser, vaultId: string, userId: string): Promise<Board> {
  const res = await call(owner, "GET", `/api/vaults/${vaultId}/access-board?userId=${userId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Board;
}

/** Every char equals POST /access/summaries for that single row. */
async function expectParity(owner: TestUser, orgId: string, vaultId: string, userId: string): Promise<Board> {
  const b = await board(owner, vaultId, userId);
  const groups = [
    ...b.folders.map((f) => [{ resourceType: "folder", resourceId: f.id }]),
    ...b.notes.map((n) => [{ resourceType: "file", resourceId: n.id }]),
    ...b.files.map((f) => [{ resourceType: "file", resourceId: f.id }]),
  ];
  expect(b.modes.length).toBe(groups.length);
  const res = await call(owner, "POST", `/api/orgs/${orgId}/access/summaries`, { groups, userIds: [userId] });
  expect(res.status).toBe(200);
  const { modes } = (await res.json()) as { modes: Array<keyof typeof CHAR> };
  const labels = groups.map((g) => g[0].resourceType + ":" + g[0].resourceId);
  expect([...b.modes].map((ch, i) => `${labels[i]}=${ch}`)).toEqual(modes.map((m, i) => `${labels[i]}=${CHAR[m]}`));
  const t = { edit: 0, view: 0, none: 0, mixed: 0 };
  for (const ch of b.modes) t[({ e: "edit", v: "view", n: "none", m: "mixed" } as const)[ch as "e"]]++;
  expect(b.totals).toEqual(t);
  expect(b.complete).toBe(true);
  return b;
}

describe("GET /vaults/:id/access-board", () => {
  let owner: TestUser;
  let member: TestUser;
  let target: TestUser;
  let orgId: string;
  let vaultId: string;

  beforeEach(async () => {
    await resetDb();
    indexLoads.count = 0;
    owner = await signUp(`owner-${randomUUID()}@test.dev`);
    member = await signUp(`member-${randomUUID()}@test.dev`);
    target = await signUp(`target-${randomUUID()}@test.dev`);
    orgId = (await createOrg(owner, "Board", `board-${randomUUID()}`)).id;
    await seedMember(orgId, member.userId, "member");
    await seedMember(orgId, target.userId, "member");
    vaultId = await seedVault(orgId);
  });

  async function tree() {
    const a = await seedFolder(vaultId, null, "A", "A", owner.userId);
    const ab = await seedFolder(vaultId, a, "B", "A/B", owner.userId);
    const abc = await seedFolder(vaultId, ab, "C", "A/B/C", owner.userId);
    const d = await seedFolder(vaultId, null, "D", "D", owner.userId);
    const empty = await seedFolder(vaultId, null, "E", "E", owner.userId);
    const n1 = await seedNote(vaultId, a, "A/1.md", owner.userId);
    const n2 = await seedNote(vaultId, ab, "A/B/2.md", owner.userId);
    const n3 = await seedNote(vaultId, abc, "A/B/C/3.md", owner.userId);
    const mine = await seedNote(vaultId, abc, "A/B/C/mine.md", target.userId);
    const n4 = await seedNote(vaultId, d, "D/4.md", owner.userId);
    const root = await seedNote(vaultId, null, "root.md", owner.userId);
    const pdf = await seedFile(vaultId, ab, "A/B/x.pdf");
    const gone = await seedNote(vaultId, d, "D/gone.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);
    // Another collection in the same org must not appear.
    const other = await seedVault(orgId, "Other");
    await seedNote(other, null, "elsewhere.md", owner.userId);
    return { a, ab, abc, d, empty, n1, n2, n3, mine, n4, root, pdf, gone };
  }

  it("edit posture: per-user folder readonly + file edit inside, org locked folder", async () => {
    await seedVaultGrant(orgId, "edit");
    const t = await tree();
    await share(orgId, "folder", t.a, { type: "user", id: target.userId }, "readonly");
    await share(orgId, "file", t.n2, { type: "user", id: target.userId }, "edit");
    await seedLock(orgId, "folder", t.d, { type: "org" });
    const b = await expectParity(owner, orgId, vaultId, target.userId);
    expect(b.notes.map((n) => n.relPath)).not.toContain("elsewhere.md");
    expect(b.notes.map((n) => n.id)).not.toContain(t.gone);
    const at = (id: string) => {
      const all = [...b.folders.map((f) => f.id), ...b.notes.map((n) => n.id), ...b.files.map((f) => f.id)];
      return b.modes[all.indexOf(id)];
    };
    expect(at(t.a)).toBe("m");
    expect(at(t.n2)).toBe("e");
    expect(at(t.n1)).toBe("v");
    expect(at(t.d)).toBe("v");
    expect(at(t.empty)).toBe("e");
    expect(at(t.root)).toBe("e");
    // The owner and the admin path agree too.
    await expectParity(owner, orgId, vaultId, owner.userId);
  });

  it("sealed vault with a per-user folder grant and an org folder denied", async () => {
    await sealVault(orgId);
    const t = await tree();
    await share(orgId, "folder", t.ab, { type: "user", id: target.userId }, "view");
    await share(orgId, "folder", t.d, { type: "org" }, "edit");
    await share(orgId, "file", t.n4, { type: "org" }, "denied");
    await expectParity(owner, orgId, vaultId, target.userId);
    await expectParity(owner, orgId, vaultId, member.userId);
    await expectParity(owner, orgId, vaultId, owner.userId);
  });

  it("personal vault view, lifted by a per-user note edit; personal denied", async () => {
    await seedVaultGrant(orgId, "edit");
    const t = await tree();
    await share(orgId, "vault", orgId, { type: "user", id: target.userId }, "view");
    await share(orgId, "file", t.n3, { type: "user", id: target.userId }, "edit");
    await share(orgId, "vault", orgId, { type: "user", id: member.userId }, "denied");
    await expectParity(owner, orgId, vaultId, target.userId);
    await expectParity(owner, orgId, vaultId, member.userId);
  });

  it("gates: 401, 403 plain member, 400 without userId, 404 non-member and unknown vault", async () => {
    const path = `/api/vaults/${vaultId}/access-board?userId=${target.userId}`;
    expect((await app.fetch(new Request(`http://local${path}`))).status).toBe(401);
    expect((await call(member, "GET", path)).status).toBe(403);
    expect((await call(target, "GET", `/api/vaults/${vaultId}/access-board?userId=${target.userId}`)).status).toBe(403);
    const noUser = await call(owner, "GET", `/api/vaults/${vaultId}/access-board`);
    expect(noUser.status).toBe(400);
    expect(((await noUser.json()) as { error: string }).error).toBe("invalid_request");
    const stranger = await signUp(`stranger-${randomUUID()}@test.dev`);
    const nm = await call(owner, "GET", `/api/vaults/${vaultId}/access-board?userId=${stranger.userId}`);
    expect(nm.status).toBe(404);
    expect(((await nm.json()) as { error: string }).error).toBe("not_member");
    expect((await call(owner, "GET", `/api/vaults/${randomUUID()}/access-board?userId=${target.userId}`)).status).toBe(404);
  });

  it("/health lists access-board", async () => {
    const res = await app.fetch(new Request("http://local/health"));
    expect(((await res.json()) as { features: string[] }).features).toContain("access-board");
  });

  it("perf: 15,000 notes in 300 folders answer in one index load under 1.5 s", async () => {
    await seedVaultGrant(orgId, "edit");
    const folderIds: string[] = [];
    const parents: Array<string | null> = [];
    const paths: string[] = [];
    // 10 top-level, 4 levels deep: 10 + 40 + 120 + 130 = 300.
    const levels = [10, 40, 120, 130];
    let prev: Array<{ id: string; path: string }> = [];
    for (let l = 0; l < levels.length; l++) {
      const cur: Array<{ id: string; path: string }> = [];
      for (let i = 0; i < levels[l]; i++) {
        const parent = l === 0 ? null : prev[i % prev.length];
        const id = randomUUID();
        const path = parent ? `${parent.path}/f${l}-${i}` : `f${l}-${i}`;
        folderIds.push(id);
        parents.push(parent?.id ?? null);
        paths.push(path);
        cur.push({ id, path });
      }
      prev = cur;
    }
    await pool.query(
      `INSERT INTO folders (id, vault_id, parent_id, name, path, created_by)
       SELECT id, $1, parent, split_part(path, '/', -1), path, $5
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(id, parent, path)`,
      [vaultId, folderIds, parents, paths, owner.userId],
    );
    const noteIds: string[] = [];
    const noteFolders: string[] = [];
    const notePaths: string[] = [];
    for (let i = 0; i < 15_000; i++) {
      const f = i % folderIds.length;
      noteIds.push(randomUUID());
      noteFolders.push(folderIds[f]);
      notePaths.push(`${paths[f]}/n${i}.md`);
    }
    await pool.query(
      `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
       SELECT id, $1, folder, path, path, id, $5
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(id, folder, path)`,
      [vaultId, noteIds, noteFolders, notePaths, owner.userId],
    );
    // A few exceptions so folders fold to a mix.
    await share(orgId, "folder", folderIds[3], { type: "user", id: target.userId }, "readonly");
    await share(orgId, "file", noteIds[7], { type: "user", id: target.userId }, "denied");

    indexLoads.count = 0;
    const started = performance.now();
    const b = await board(owner, vaultId, target.userId);
    const ms = performance.now() - started;
    console.log(`[access-board perf] ${b.modes.length} items in ${ms.toFixed(0)} ms`);
    expect(b.modes.length).toBe(15_300);
    expect(indexLoads.count).toBe(1);
    expect(ms).toBeLessThan(1500);
    expect(b.totals.mixed).toBeGreaterThan(0);
  }, 60_000);
});
