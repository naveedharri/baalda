import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedVault, seedVaultGrant } from "./helpers/seed.js";
import { registerCtx, registerFile } from "../src/registry/batch-ops.js";
import { isTransientFileName, isTransientPath } from "../src/registry/transient.js";

/**
 * #266: a `files` registration that loses a same-path race used to surface the
 * bare 23505 from `files_vault_path_ci_uq` as a 500. The race is reproduced
 * deterministically by priming the per-request cache with "nothing at this
 * path" — exactly what a concurrent writer leaves behind between the adopt
 * probe and the insert.
 */
describe("files registration", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted");
    await resetDb();
    owner = await signUp("owner@files-race.test");
    org = (await createOrg(owner, "Files Co", "files-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("adopts the winner when an insert loses a same-path race", async () => {
    const winner = await registerFile(registerCtx(vault, owner.userId), { path: "report.pdf" });
    expect(winner.status).toBe("created");
    const winnerId = winner.status === "error" ? "" : winner.row.id;

    const ctx = registerCtx(vault, owner.userId);
    ctx.cache.files.set("report.pdf", null); // the probe "saw" an empty path
    const loser = await registerFile(ctx, { path: "Report.pdf", docId: randomUUID() });
    expect(loser.status).toBe("adopted");
    if (loser.status === "error") throw new Error("unreachable");
    expect(loser.row.id).toBe(winnerId);
    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows.map((r) => r.id)).toEqual([winnerId]);
  });

  it("adopts the occupant when a move loses a same-path race", async () => {
    const a = await registerFile(registerCtx(vault, owner.userId), { path: "a.pdf" });
    const b = await registerFile(registerCtx(vault, owner.userId), { path: "b.pdf" });
    if (a.status === "error" || b.status === "error") throw new Error("seed failed");

    const ctx = registerCtx(vault, owner.userId);
    ctx.cache.files.set("b.pdf", null);
    const moved = await registerFile(ctx, { path: "b.pdf", docId: a.row.id });
    expect(moved.status).toBe("adopted");
    if (moved.status === "error") throw new Error("unreachable");
    expect(moved.row.id).toBe(b.row.id);
    // Nothing moved and nothing was lost: both rows are where they were.
    const { rows } = await pool.query("SELECT id, path FROM files WHERE vault_id = $1 ORDER BY path", [
      vault,
    ]);
    expect(rows).toEqual([
      { id: a.row.id, path: "a.pdf" },
      { id: b.row.id, path: "b.pdf" },
    ]);
  });

  it("refuses a NEW Office lock file but still adopts one already registered", async () => {
    const refused = await registerFile(registerCtx(vault, owner.userId), {
      path: "Docs/~$Report.docx",
    });
    expect(refused).toMatchObject({ status: "error", code: "transient_file" });

    // A row an older client registered before the rule keeps answering.
    const legacyId = randomUUID();
    await pool.query("INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, NULL, $3)", [
      legacyId,
      vault,
      "~$Old.docx",
    ]);
    const adopted = await registerFile(registerCtx(vault, owner.userId), { path: "~$Old.docx" });
    expect(adopted.status).toBe("adopted");
    if (adopted.status === "error") throw new Error("unreachable");
    expect(adopted.row.id).toBe(legacyId);
  });

  it("names transient files narrowly", () => {
    expect(isTransientFileName("~$Report.docx")).toBe(true);
    expect(isTransientFileName("~WRL0001.tmp")).toBe(true);
    expect(isTransientFileName(".~lock.Report.docx#")).toBe(true);
    expect(isTransientFileName("~notes.pdf")).toBe(false);
    expect(isTransientFileName("Report.docx")).toBe(false);
    expect(isTransientPath("~$Folder/Report.docx")).toBe(false);
    expect(isTransientPath("Folder/~$Report.docx")).toBe(true);
  });
});
