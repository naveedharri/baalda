import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import {
  FOREIGN_RENAME_MAX,
  gainsConflictSuffix,
  resetRenameGuard,
  takeForeignRename,
} from "../src/registry/rename-guard.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * The brakes on renaming a teammate's note (2026-09-30: one client renamed 619
 * teammates' notes to `(conflict …)` names in six minutes, every request valid).
 */

const app = createApp(testAppDeps());

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("gainsConflictSuffix", () => {
  it("spots a conflict suffix added before the extension", () => {
    expect(gainsConflictSuffix("a/Note.md", "a/Note (conflict 2026-09-30).md")).toBe(true);
    expect(gainsConflictSuffix("Note", "Note (conflict 2026-09-30)")).toBe(true);
  });
  it("ignores renames that keep, remove or never had one", () => {
    expect(gainsConflictSuffix("a/Note (conflict 2026-09-30).md", "a/Note.md")).toBe(false);
    expect(gainsConflictSuffix("a/X (conflict 2026-09-30).md", "b/X (conflict 2026-09-30).md")).toBe(false);
    expect(gainsConflictSuffix("a/Note.md", "a/Better name.md")).toBe(false);
    expect(gainsConflictSuffix("a/Note.md", "a/Note (conflict notes).md")).toBe(false);
  });
});

describe("takeForeignRename", () => {
  beforeEach(() => resetRenameGuard());
  it("allows the budget, refuses past it, and frees up after the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FOREIGN_RENAME_MAX; i++) expect(takeForeignRename("u", "v", t0 + i).ok).toBe(true);
    const over = takeForeignRename("u", "v", t0 + FOREIGN_RENAME_MAX);
    expect(over.ok).toBe(false);
    // Budgets are per (user, vault).
    expect(takeForeignRename("u", "other", t0).ok).toBe(true);
    expect(takeForeignRename("someone", "v", t0).ok).toBe(true);
    expect(takeForeignRename("u", "v", t0 + 5 * 60_000 + 1).ok).toBe(true);
  });
});

describe("PATCH /api/notes/:id rename guard", () => {
  let owner: TestUser;
  let mate: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    resetRenameGuard();
    owner = await signUp("owner@rename-guard.test");
    const orgId = (await createOrg(owner, "Guard Co", "guard-co")).id;
    mate = await signUp("mate@rename-guard.test");
    await seedMember(orgId, mate.userId, "member");
    vault = await seedVault(orgId);
    // A shared vault, so the owner may edit the teammate's note at all.
    await seedVaultGrant(orgId, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("refuses renaming a teammate's note to a conflict name", async () => {
    const theirs = await seedNote(vault, null, "Plan.md", mate.userId);
    const res = await req(owner, "PATCH", `/api/notes/${theirs}`, {
      relPath: "Plan (conflict 2026-09-30).md",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("conflict_rename_refused");
    const { rows } = await pool.query("SELECT rel_path FROM notes WHERE id = $1", [theirs]);
    expect(rows[0].rel_path).toBe("Plan.md");
  });

  it("still lets the author rename their own note to a conflict name", async () => {
    const mine = await seedNote(vault, null, "Plan.md", owner.userId);
    const res = await req(owner, "PATCH", `/api/notes/${mine}`, {
      relPath: "Plan (conflict 2026-09-30).md",
    });
    expect(res.status).toBe(200);
  });

  it("rate-limits mass renames of teammates' notes, not of your own", async () => {
    const theirs = await seedNote(vault, null, "Theirs.md", mate.userId);
    const mine = await seedNote(vault, null, "Mine.md", owner.userId);
    for (let i = 0; i < FOREIGN_RENAME_MAX; i++) takeForeignRename(owner.userId, vault);
    const limited = await req(owner, "PATCH", `/api/notes/${theirs}`, { relPath: "Renamed.md" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(((await limited.json()) as { code: string }).code).toBe("rename_rate_limited");
    // Your own notes, and non-rename edits, are never budgeted.
    expect((await req(owner, "PATCH", `/api/notes/${mine}`, { relPath: "Mine2.md" })).status).toBe(200);
    expect((await req(owner, "PATCH", `/api/notes/${theirs}`, { color: "red" })).status).toBe(200);
  });
});
