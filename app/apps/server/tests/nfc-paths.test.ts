import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { pathKey, samePath } from "../src/registry/tree-ops.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * A path names ONE item per vault after Unicode normalization too (#259).
 *
 * macOS hands out names DECOMPOSED (NFD: `e` + U+0301), Windows and Linux keep
 * them COMPOSED (NFC: U+00E9). On a Mac both spellings open one file, so if the
 * server stored both as distinct rows every Mac would map one file to two doc
 * ids — the same fork migration 023 closed for case variants. Migration 043's
 * `vault_path_key()` indexes and the lookups that use it close it for
 * normalization variants, while storing every path exactly as it was sent.
 */

const NFC_DIR = "Café"; // "Café", composed
const NFD_DIR = "Café"; // "Café", decomposed
const NFC_NOTE = "한글.md"; // Hangul, composed
const NFD_NOTE = "한글.md"; // the same, decomposed

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

function req(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean };
  };
  return { isError: body.result?.isError ?? false, data: body.result?.structuredContent as any };
}

async function liveNotes(vaultId: string) {
  const { rows } = await pool.query<{ id: string; rel_path: string }>(
    "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
    [vaultId],
  );
  return rows;
}

describe("pathKey / samePath", () => {
  it("treats NFC and NFD spellings as one path, case-insensitively", () => {
    expect(NFC_DIR).not.toBe(NFD_DIR);
    expect(samePath(NFC_DIR, NFD_DIR)).toBe(true);
    expect(samePath(`${NFC_DIR}/${NFC_NOTE}`, `${NFD_DIR.toUpperCase()}/${NFD_NOTE}`)).toBe(true);
    expect(pathKey(NFD_NOTE)).toBe(pathKey(NFC_NOTE));
    expect(samePath("Cafe", NFC_DIR)).toBe(false);
  });
});

describe("Unicode-normalized path identity", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;
  let cafe: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@nfc.test");
    org = (await createOrg(owner, "Nfc Co", "nfc-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    // Stored the way a Mac sends it: decomposed.
    cafe = await seedFolder(vault, null, NFD_DIR, NFD_DIR);
  });

  it("the SQL key agrees with the JS key", async () => {
    const { rows } = await pool.query<{ same: boolean; key: string }>(
      "SELECT vault_path_key($1) = vault_path_key($2) AS same, vault_path_key($1) AS key",
      [`${NFD_DIR}/${NFD_NOTE}`, `${NFC_DIR}/${NFC_NOTE}`],
    );
    expect(rows[0].same).toBe(true);
    expect(rows[0].key).toBe(pathKey(`${NFC_DIR}/${NFC_NOTE}`));
  });

  it("adopts the existing folder when its other normalization is registered", async () => {
    const res = await req(owner, "POST", "/api/folders", { vaultId: vault, name: NFC_DIR, path: NFC_DIR });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(cafe);
    // The caller is handed the stored spelling, byte for byte.
    expect(body.path).toBe(NFD_DIR);
    const { rows } = await pool.query("SELECT 1 FROM folders WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("adopts the existing note when a Windows client registers the NFC spelling", async () => {
    const first = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: `${NFD_DIR}/${NFD_NOTE}`,
    });
    expect(first.status).toBe(201);
    const original = (await first.json()).docId as string;

    const second = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: `${NFC_DIR}/${NFC_NOTE}`,
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.docId).toBe(original);
    expect(body.relPath).toBe(`${NFD_DIR}/${NFD_NOTE}`);
    expect(await liveNotes(vault)).toHaveLength(1);
  });

  it("resolves a note's NFC folder segment to the NFD folder and keeps the stored spelling", async () => {
    const res = await req(owner, "POST", "/api/notes", {
      vaultId: vault,
      relPath: `${NFC_DIR}/plan.md`,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.folderId).toBe(cafe);
    expect(body.relPath).toBe(`${NFD_DIR}/plan.md`);
  });

  it("the notes batch adopts across normalizations, in one batch and against existing rows", async () => {
    const existing = await seedNote(vault, cafe, `${NFD_DIR}/${NFD_NOTE}`);
    const res = await req(owner, "POST", `/api/vaults/${vault}/notes/batch`, {
      items: [
        { relPath: `${NFC_DIR}/${NFC_NOTE}` },
        { relPath: `${NFC_DIR}/résumé.md` },
        { relPath: `${NFD_DIR}/résumé.md` },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<{ docId: string | null; status: string }> };
    expect(results[0].docId).toBe(existing);
    expect(results[1].docId).toBeTruthy();
    expect(results[2].docId).toBe(results[1].docId);
    expect(await liveNotes(vault)).toHaveLength(2);
  });

  it("adopts a file registered under the other normalization instead of a second row", async () => {
    const id = randomUUID();
    const first = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: id,
      path: `${NFD_DIR}/fàcture.pdf`,
    });
    expect(first.status).toBe(201);
    const second = await req(owner, "POST", "/api/files", {
      vaultId: vault,
      docId: randomUUID(),
      path: `${NFC_DIR}/fàcture.pdf`,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id, path: `${NFD_DIR}/fàcture.pdf` });
    const { rows } = await pool.query("SELECT id FROM files WHERE vault_id = $1", [vault]);
    expect(rows).toHaveLength(1);
  });

  it("refuses a move onto the other normalization of an occupied path", async () => {
    await seedNote(vault, cafe, `${NFD_DIR}/${NFD_NOTE}`);
    const b = await seedNote(vault, cafe, `${NFD_DIR}/b.md`);
    const res = await req(owner, "PATCH", `/api/notes/${b}`, { relPath: `${NFC_DIR}/${NFC_NOTE}` });
    expect(res.status).toBe(400);
    const { rows } = await pool.query("SELECT rel_path FROM notes WHERE id = $1", [b]);
    expect(rows[0].rel_path).toBe(`${NFD_DIR}/b.md`);
  });

  it("MCP create_note adopts across normalizations", async () => {
    const token = (await createMcpToken({ userId: owner.userId, organizationId: org }, "test")).token;
    const first = await call(token, "create_note", {
      vaultId: vault,
      relPath: `${NFD_DIR}/${NFD_NOTE}`,
      content: "# One",
    });
    expect(first.isError).toBe(false);
    const second = await call(token, "create_note", {
      vaultId: vault,
      relPath: `${NFC_DIR}/${NFC_NOTE}`,
      content: "# Two",
    });
    expect(second.isError).toBe(false);
    expect(second.data.adopted).toBe(true);
    expect(second.data.docId).toBe(first.data.docId);
    expect(await liveNotes(vault)).toHaveLength(1);
  });

  describe("the database backstop (migration 043)", () => {
    it("rejects a second folder row that differs only by normalization", async () => {
      await expect(
        pool.query("INSERT INTO folders (id, vault_id, parent_id, name, path) VALUES ($1, $2, NULL, $3, $3)", [
          randomUUID(),
          vault,
          NFC_DIR,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("rejects a second live note row that differs only by normalization", async () => {
      await seedNote(vault, cafe, `${NFD_DIR}/${NFD_NOTE}`);
      await expect(
        pool.query(
          `INSERT INTO notes (id, vault_id, folder_id, rel_path, doc_id) VALUES ($1, $2, $3, $4, $1)`,
          [randomUUID(), vault, cafe, `${NFD_DIR}/${NFC_NOTE}`],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("rejects a second file row that differs only by normalization", async () => {
      await pool.query("INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4)", [
        randomUUID(),
        vault,
        cafe,
        `${NFD_DIR}/á.png`,
      ]);
      await expect(
        pool.query("INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4)", [
          randomUUID(),
          vault,
          cafe,
          `${NFD_DIR}/á.png`,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("stores paths exactly as sent", async () => {
      const id = await seedNote(vault, cafe, `${NFD_DIR}/${NFD_NOTE}`);
      const { rows } = await pool.query<{ rel_path: string }>("SELECT rel_path FROM notes WHERE id = $1", [id]);
      expect(rows[0].rel_path).toBe(`${NFD_DIR}/${NFD_NOTE}`);
    });
  });
});
