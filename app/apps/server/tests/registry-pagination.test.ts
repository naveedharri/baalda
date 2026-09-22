import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFile, seedFolder, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { testAppDeps } from "./helpers/app.js";

/**
 * Keyset pagination on the registry listings.
 *
 * The rule that everything else hangs off: **omitting `limit` is today's exact
 * behaviour.** Every shipped client reads these listings as the complete truth
 * and deletes what is missing, so a page cap applied by default would have an
 * old client remove every note past the cap. The second rule is that tombstones
 * ride the LAST page only — the client's whole reason for asking is to subtract
 * one set from the other, and that subtraction is meaningless against a slice.
 */

const app = createApp(testAppDeps());

function req(user: TestUser, path: string) {
  return app.fetch(new Request(`http://local${path}`, { headers: authHeaders(user) }));
}

interface NotesPage {
  notes: Array<{ id: string; rel_path: string }>;
  tombstones?: string[];
  nextAfter?: string | null;
}

describe("registry keyset pagination", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@page.test");
    org = (await createOrg(owner, "Page Co", "page-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("omitting limit returns everything with tombstones, exactly as before", async () => {
    for (let i = 0; i < 5; i++) await seedNote(vault, null, `n${i}.md`, owner.userId);
    const gone = await seedNote(vault, null, "gone.md", owner.userId);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [gone]);
    const body = (await (await req(owner, `/api/notes?vaultId=${vault}`)).json()) as NotesPage;
    expect(body.notes.length).toBe(5);
    expect(body.tombstones).toEqual([gone]);
    expect(body.nextAfter).toBeUndefined();
  });

  it("pages notes by rel_path, hands back every note once, and never repeats", async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `note-${String(i).padStart(2, "0")}.md`);
    for (const p of paths) await seedNote(vault, null, p, owner.userId);
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const qs = `vaultId=${vault}&limit=5${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const body = (await (await req(owner, `/api/notes?${qs}`)).json()) as NotesPage;
      pages++;
      seen.push(...body.notes.map((n) => n.rel_path));
      // Tombstones ONLY on the last page.
      if (body.nextAfter) {
        expect(body.tombstones).toBeUndefined();
        after = body.nextAfter;
      } else {
        expect(body.tombstones).toEqual([]);
        break;
      }
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(paths);
    expect(new Set(seen).size).toBe(paths.length);
  });

  /**
   * The property a cursor buys over an OFFSET: a row inserted BEHIND the cursor
   * cannot shift the rows ahead of it, so nothing is skipped or seen twice. An
   * offset page would have done both.
   */
  it("is stable when rows are inserted mid-scan", async () => {
    for (let i = 0; i < 10; i++) await seedNote(vault, null, `b-${i}.md`, owner.userId);
    const first = (await (await req(owner, `/api/notes?vaultId=${vault}&limit=4`)).json()) as NotesPage;
    expect(first.notes.length).toBe(4);
    // Inserted before the cursor (a-*) and after it (z-*), mid-scan.
    await seedNote(vault, null, "a-new.md", owner.userId);
    await seedNote(vault, null, "z-new.md", owner.userId);
    const seen = first.notes.map((n) => n.rel_path);
    let after = first.nextAfter!;
    for (;;) {
      const body = (await (
        await req(owner, `/api/notes?vaultId=${vault}&limit=4&after=${encodeURIComponent(after)}`)
      ).json()) as NotesPage;
      seen.push(...body.notes.map((n) => n.rel_path));
      if (!body.nextAfter) break;
      after = body.nextAfter;
    }
    // The one inserted behind the cursor is simply not in this scan — never
    // duplicated, never a reason to re-read a page.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("z-new.md");
    expect(seen).not.toContain("a-new.md");
  });

  it("rejects a nonsense limit rather than guessing", async () => {
    for (const bad of ["0", "-1", "abc", "100000"]) {
      const res = await req(owner, `/api/notes?vaultId=${vault}&limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("pages folders on the same convention, tombstones last", async () => {
    for (let i = 0; i < 7; i++) await seedFolder(vault, null, `f${i}`, `f${i}`, owner.userId);
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const qs = `vaultId=${vault}&limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const body = (await (await req(owner, `/api/folders?${qs}`)).json()) as {
        folders: Array<{ path: string }>;
        tombstones?: string[];
        nextAfter?: string | null;
      };
      seen.push(...body.folders.map((f) => f.path));
      if (body.nextAfter) {
        expect(body.tombstones).toBeUndefined();
        after = body.nextAfter;
      } else {
        expect(body.tombstones).toEqual([]);
        break;
      }
    }
    expect(seen).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6"]);
    // …and the unpaginated call is untouched.
    const all = (await (await req(owner, `/api/folders?vaultId=${vault}`)).json()) as {
      folders: unknown[];
      tombstones: string[];
    };
    expect(all.folders.length).toBe(7);
    expect(all.tombstones).toEqual([]);
  });

  it("lists tree files, ACL-filtered, paged the same way", async () => {
    for (let i = 0; i < 5; i++) await seedFile(vault, null, `file-${i}.pdf`);
    const all = (await (await req(owner, `/api/files?vaultId=${vault}`)).json()) as {
      files: Array<{ path: string }>;
    };
    expect(all.files.map((f) => f.path)).toEqual([
      "file-0.pdf",
      "file-1.pdf",
      "file-2.pdf",
      "file-3.pdf",
      "file-4.pdf",
    ]);
    const first = (await (await req(owner, `/api/files?vaultId=${vault}&limit=2`)).json()) as {
      files: Array<{ path: string }>;
      nextAfter?: string | null;
    };
    expect(first.files.map((f) => f.path)).toEqual(["file-0.pdf", "file-1.pdf"]);
    expect(first.nextAfter).toBe("file-1.pdf");

    const stranger = await signUp("stranger@page.test");
    expect((await req(stranger, `/api/files?vaultId=${vault}`)).status).toBe(403);
  });
});
