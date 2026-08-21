import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedVault } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";

/**
 * Folder/note accent colors on the registry rows.
 *
 * Colors used to be a localStorage preference keyed by path, which meant a
 * folder you tinted was grey on every other machine and for every teammate.
 * Two things make the server version right: it is keyed by **id**, so a rename
 * or a move keeps the color; and it rides the ordinary registry pull, so it
 * reaches everyone on the same round trip a rename does.
 */

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

describe("item colors sync with the registry", () => {
  let owner: TestUser;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@colors.test");
    const org = (await createOrg(owner, "Color Co", "color-co")).id;
    vault = await seedVault(org);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("a folder color set by one client comes back on the next listing", async () => {
    const created = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const id = (await created.json()).id as string;

    expect((await req(owner, "PATCH", `/api/folders/${id}`, { color: "amber" })).status).toBe(200);

    const list = await req(owner, "GET", `/api/folders?vaultId=${vault}`);
    const folders = (await list.json()).folders as Array<{ id: string; color: string | null }>;
    expect(folders.find((f) => f.id === id)?.color).toBe("amber");
  });

  it("survives a rename — the color is keyed by id, not path", async () => {
    const created = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const id = (await created.json()).id as string;
    await req(owner, "PATCH", `/api/folders/${id}`, { color: "teal" });

    await req(owner, "PATCH", `/api/folders/${id}`, { name: "Handbook", path: "Handbook" });

    const list = await req(owner, "GET", `/api/folders?vaultId=${vault}`);
    const folders = (await list.json()).folders as Array<{ path: string; color: string | null }>;
    expect(folders.find((f) => f.path === "Handbook")?.color).toBe("teal");
  });

  it("clears with null, and a note carries one too", async () => {
    const created = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: "n.md",
      color: "rose",
    });
    const id = (await created.json()).id as string;

    const listed = async () => {
      const res = await req(owner, "GET", `/api/notes?vaultId=${vault}`);
      const notes = (await res.json()).notes as Array<{ id: string; color: string | null }>;
      return notes.find((n) => n.id === id)?.color ?? null;
    };
    expect(await listed()).toBe("rose");

    await req(owner, "PATCH", `/api/notes/${id}`, { color: null });
    expect(await listed()).toBeNull();
  });

  it("broadcasts a registry change so open clients re-pull", async () => {
    const created = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const id = (await created.json()).id as string;
    rec.reset();

    await req(owner, "PATCH", `/api/folders/${id}`, { color: "violet" });
    expect(rec.registryBroadcasts.map((b) => b.vaultId)).toEqual([vault]);
  });

  it("ignores a junk color rather than storing it", async () => {
    const created = await req(owner, "POST", "/api/folders", {
      vaultId: vault,
      name: "Docs",
      path: "Docs",
    });
    const id = (await created.json()).id as string;
    await req(owner, "PATCH", `/api/folders/${id}`, { color: "x".repeat(64) });

    const list = await req(owner, "GET", `/api/folders?vaultId=${vault}`);
    const folders = (await list.json()).folders as Array<{ id: string; color: string | null }>;
    expect(folders.find((f) => f.id === id)?.color).toBeNull();
  });
});
