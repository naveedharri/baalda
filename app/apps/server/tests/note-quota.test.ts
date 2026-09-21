// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool, resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
const app = createApp(recordingAppDeps().deps);
let owner: TestUser; let vault: string;
const request = (path: string, body: unknown) => app.fetch(new Request(`http://local${path}`, { method: "POST", headers: authHeaders(owner), body: JSON.stringify(body) }));
beforeEach(async () => {
  vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
  await resetDb(); owner = await signUp("owner@note-quota.test");
  const org = (await createOrg(owner, "Quota", "quota")).id;
  vault = await seedVault(org); await seedVaultGrant(org, "edit");
  await pool.query(`INSERT INTO notes (id, vault_id, rel_path, doc_id, created_by)
    SELECT 'quota-' || n, $1, 'note-' || n || '.md', 'quota-' || n, $2 FROM generate_series(1,19999) n`, [vault, owner.userId]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => pool.end());
it("concurrent registrations cannot exceed 20,000, and existing paths still adopt", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => request("/api/notes", { vaultId: vault, relPath: `New-${n}.md` })));
  expect(results.filter(r => r.status === 201)).toHaveLength(1);
  expect(results.filter(r => r.status === 402)).toHaveLength(11);
  const count = await pool.query("SELECT count(*)::int AS n FROM notes WHERE vault_id=$1 AND deleted_at IS NULL", [vault]);
  expect(count.rows[0].n).toBe(20000);
  const batch = await request(`/api/vaults/${vault}/notes/batch`, { items: [{ relPath: "note-1.md", docId: "another-device-id" }, { relPath: "Extra.md" }] });
  expect(batch.status).toBe(200);
  const body = await batch.json() as { results: { status: string; code?: string }[] };
  expect(body.results[0].status).toBe("adopted");
  expect(body.results[1].code).toBe("note_limit_reached");
});
it("self-hosted billing does not impose the Cloud note cap", async () => {
  vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted"); vi.stubEnv("POLAR_ACCESS_TOKEN", "operator-billing");
  for (const relPath of ["More-one.md", "More-two.md"]) expect((await request("/api/notes", { vaultId: vault, relPath })).status).toBe(201);
});
