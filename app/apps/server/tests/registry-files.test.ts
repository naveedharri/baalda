import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";

const rec = recordingAppDeps();
const app = createApp(rec.deps);

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

afterAll(async () => {
  await pool.end();
});

/**
 * `POST /api/files` — the tree-binary half of the registry. A device registers
 * every binary it holds on every reconcile pass, so "already registered" is the
 * normal case, and a rename has to move the row rather than fork the doc.
 */
describe("registry file registration", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let folder: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    // Fresh identity per test: Better Auth keeps state keyed on the account, and
    // re-signing-up the same address across a truncate is how you get a member
    // row pointing at a user that no longer exists.
    const tag = randomUUID().slice(0, 8);
    owner = await signUp(`owner+${tag}@files.registry.test`);
    org = (await createOrg(owner, "Files Reg", `files-reg-${tag}`)).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    folder = await seedFolder(vault, null, "Team", "Team", owner.userId);
  });

  it("adopts a client-supplied id and is idempotent on a repeat", async () => {
    const id = randomUUID();
    const first = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "Team/q3.xlsx",
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id, docId: id, folderId: folder });

    const again = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "Team/q3.xlsx",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, path: "Team/q3.xlsx" });

    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("treats the same id at a new path as a move, keeping the doc", async () => {
    const id = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: id, path: "Team/q3.xlsx" });
    const moved = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: "q3.xlsx",
    });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id, folderId: null, path: "q3.xlsx" });

    const { rows } = await pool.query<{ id: string; path: string; folder_id: string | null }>(
      "SELECT id, path, folder_id FROM files WHERE vault_id = $1",
      [vault],
    );
    expect(rows).toEqual([{ id, path: "q3.xlsx", folder_id: null }]);
  });

  it("a second device with its own id adopts the incumbent rather than forking", async () => {
    const mine = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: mine, path: "Team/logo.svg" });

    const exact = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "Team/logo.svg",
    });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ id: mine, docId: mine, path: "Team/logo.svg" });

    const variant = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "team/logo.svg", // case-variant: the same file on macOS
    });
    expect(variant.status).toBe(200);
    // The row's CANONICAL spelling comes back, so the second device stops
    // re-registering its own on every pass.
    expect(await variant.json()).toMatchObject({ id: mine, path: "Team/logo.svg" });

    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("adopts even when this device has not registered the folder yet", async () => {
    // The adoption lookup runs before `resolveParentFolder`, which throws for a
    // folder the server does not know. A device a pass behind on the folder map
    // must still converge on the incumbent id rather than earn a 400.
    const mine = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: mine, path: "Team/deck.pptx" });
    await pool.query("UPDATE folders SET path = 'Team2', name = 'Team2' WHERE id = $1", [folder]);

    const res = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: "Team/deck.pptx",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: mine });
  });

  it("a move onto an occupied path adopts the incumbent instead of forking", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: a, path: "Team/a.png" });
    await req(owner, "POST", "/api/files", { vaultId: vault, docId: b, path: "Team/b.png" });

    const clash = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: b,
      path: "Team/a.png",
    });
    expect(clash.status).toBe(200);
    expect(await clash.json()).toMatchObject({ id: a, docId: a });
    // Two rows still, each where it was: the path is not stolen from `a`.
    const { rows } = await pool.query<{ id: string; path: string }>(
      "SELECT id, path FROM files WHERE vault_id = $1 ORDER BY path",
      [vault],
    );
    expect(rows).toEqual([
      { id: a, path: "Team/a.png" },
      { id: b, path: "Team/b.png" },
    ]);
  });
});
