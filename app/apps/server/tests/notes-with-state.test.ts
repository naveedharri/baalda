import { readFileSync } from "node:fs";
import { DEFAULT_MIN_CLIENT_VERSION } from "../src/http/client-version.js";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { freezeVaultRoot, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { recordingAppDeps } from "./helpers/app.js";
import { setDocBatchRuntime } from "../src/sync/doc-batch.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { loadDocState } from "../src/yjs/persistence.js";
import { config } from "../src/config.js";

/**
 * One-step note creation (`one-step-note-sync.md` §5.1/§5.2): `notes/batch` and
 * `POST /api/notes` items may carry the note's binary Yjs `state`. The server
 * registers exactly as before, then seeds ONLY rows this call created (or the
 * same id left stateless), under `expectEmpty`, and publishes `registry-changed`
 * after the state is persisted. Refusals write neither a row nor state.
 */

// Count every doc_updates row present at the moment `registry-changed` fires.
const atBroadcast: Array<Promise<number>> = [];
const rec = recordingAppDeps({
  // This override replaces the helper's recorder, so it records the broadcast itself.
  onRegistryChanged: (vaultId, originId) => {
    rec.registryBroadcasts.push({ vaultId, originId });
    atBroadcast.push(
      pool
        .query<{ n: number }>(
          `SELECT count(*)::int AS n FROM doc_updates u JOIN notes n ON n.id = u.doc_id WHERE n.vault_id = $1`,
          [vaultId],
        )
        .then((r) => r.rows[0].n),
    );
  },
});
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

function stateFor(text: string, clientId?: number): string {
  const doc = new Y.Doc();
  if (clientId !== undefined) doc.clientID = clientId;
  doc.getText("content").insert(0, text);
  const out = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return out;
}

async function contentOf(docId: string): Promise<string | null> {
  const state = await loadDocState(docId);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const out = doc.getText("content").toString();
  doc.destroy();
  return out;
}

const updateRows = async (docId: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]))
    .rows[0].n;

const noteRow = async (vaultId: string, relPath: string) =>
  (
    await pool.query<{ id: string }>(
      "SELECT id FROM notes WHERE vault_id = $1 AND lower(rel_path) = lower($2) AND deleted_at IS NULL",
      [vaultId, relPath],
    )
  ).rows[0]?.id ?? null;

interface Result {
  relPath: string;
  docId: string | null;
  status: string;
  code: string | null;
  seeded?: boolean;
  content?: string;
  reason?: string;
  sv?: string;
}

describe("notes with state", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    atBroadcast.length = 0;
    setDocBatchRuntime(null);
    owner = await signUp("owner@seed.test");
    org = (await createOrg(owner, "Seed Co", "seed-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterEach(() => {
    setDocBatchRuntime(null);
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool.end();
  });

  const batch = async (user: TestUser, items: unknown[]) => {
    const res = await req(user, "POST", `/api/vaults/${vault}/notes/batch`, { items });
    return { status: res.status, body: (await res.json()) as { results: Result[]; code?: string } };
  };

  it("creates the row and seeds its state in one call, broadcasting after the state", async () => {
    const docId = randomUUID();
    const { status, body } = await batch(owner, [{ relPath: "a.md", docId, state: stateFor("hello") }]);
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({ status: "created", docId, seeded: true, content: "applied" });
    expect(typeof body.results[0].sv).toBe("string");
    expect(await contentOf(docId)).toBe("hello");
    expect(await updateRows(docId)).toBe(1);
    expect(rec.registryBroadcasts).toHaveLength(1);
    // The broadcast fired once the content row already existed.
    expect(await atBroadcast[0]).toBe(1);
  });

  it("an adopt onto a different winner id returns the winner and writes no state", async () => {
    const winner = await seedNote(vault, null, "Shared.md", owner.userId);
    const { body } = await batch(owner, [
      { relPath: "shared.md", docId: randomUUID(), state: stateFor("my copy") },
    ]);
    expect(body.results[0]).toMatchObject({
      status: "adopted",
      docId: winner,
      seeded: false,
      content: "skipped",
      reason: "adopted",
    });
    expect(await updateRows(winner)).toBe(0);
    expect(await contentOf(winner)).toBeNull();
  });

  it("a same-id stateless row (half-registered by an old client) is seeded", async () => {
    const docId = await seedNote(vault, null, "half.md", owner.userId);
    const { body } = await batch(owner, [{ relPath: "half.md", docId, state: stateFor("filled") }]);
    expect(body.results[0]).toMatchObject({ status: "adopted", docId, seeded: true, content: "applied" });
    expect(await contentOf(docId)).toBe("filled");
  });

  it("a same-id row that already holds other text is a conflict, and the text is unchanged", async () => {
    const docId = await seedNote(vault, null, "busy.md", owner.userId);
    await req(owner, "POST", `/api/vaults/${vault}/docs/batch`, {
      items: [{ docId, update: stateFor("a teammate's text", 1) }],
    });
    const rowsBefore = await updateRows(docId);
    const { body } = await batch(owner, [{ relPath: "busy.md", docId, state: stateFor("my seed", 2) }]);
    expect(body.results[0]).toMatchObject({ status: "adopted", seeded: false, content: "conflict", reason: "conflict" });
    expect(await contentOf(docId)).toBe("a teammate's text");
    expect(await updateRows(docId)).toBe(rowsBefore);
  });

  it("a retry after a lost response answers covered, with no second doc_updates row", async () => {
    const docId = randomUUID();
    const state = stateFor("once", 7);
    await batch(owner, [{ relPath: "once.md", docId, state }]);
    const rows = await updateRows(docId);
    const { body } = await batch(owner, [{ relPath: "once.md", docId, state }]);
    expect(body.results[0]).toMatchObject({ status: "adopted", seeded: true, content: "covered" });
    expect(await updateRows(docId)).toBe(rows);
  });

  it("covered still holds after a teammate edited the note since the first attempt", async () => {
    const docId = randomUUID();
    const state = stateFor("base", 7);
    await batch(owner, [{ relPath: "edited.md", docId, state }]);
    // A teammate appends on top of our seed.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(state, "base64"));
    doc.clientID = 8;
    doc.getText("content").insert(4, " + more");
    await req(owner, "POST", `/api/vaults/${vault}/docs/batch`, {
      items: [{ docId, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") }],
    });
    doc.destroy();
    const { body } = await batch(owner, [{ relPath: "edited.md", docId, state }]);
    expect(body.results[0]).toMatchObject({ seeded: true, content: "covered" });
    expect(await contentOf(docId)).toBe("base + more");
  });

  it("a live Hocuspocus doc loaded empty receives the seed", async () => {
    const docId = randomUUID();
    const live = new Y.Doc();
    setDocBatchRuntime({
      server: { hocuspocus: { documents: new Map([[formatDocName(vault, docId), live]]) } } as never,
      hooks: {},
    });
    const { body } = await batch(owner, [{ relPath: "live.md", docId, state: stateFor("live seed") }]);
    expect(body.results[0]).toMatchObject({ status: "created", seeded: true, content: "applied" });
    expect(live.getText("content").toString()).toBe("live seed");
  });

  it("refusals in a mixed chunk write neither a row nor state; the others still seed", async () => {
    await seedNote(vault, null, "Taken.md", owner.userId);
    const ok = randomUUID();
    const mismatch = randomUUID();
    const { body } = await batch(owner, [
      { relPath: "ok.md", docId: ok, state: stateFor("ok") },
      { relPath: "taken.md", docId: randomUUID(), state: stateFor("case variant") },
      { relPath: "Docs/x.md", folderPath: "Other", docId: mismatch, state: stateFor("x") },
    ]);
    expect(body.results[0]).toMatchObject({ status: "created", seeded: true });
    expect(body.results[1]).toMatchObject({ status: "adopted", seeded: false, reason: "adopted" });
    expect(body.results[2]).toMatchObject({ status: "error", code: "path_folder_mismatch", seeded: false });
    expect(await noteRow(vault, "Docs/x.md")).toBeNull();
    expect(await updateRows(mismatch)).toBe(0);
    expect(await contentOf(ok)).toBe("ok");
  });

  it("root_frozen refuses before any write", async () => {
    await freezeVaultRoot(vault);
    const docId = randomUUID();
    const { body } = await batch(owner, [{ relPath: "root.md", docId, state: stateFor("nope") }]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "root_frozen", seeded: false, content: "refused" });
    expect(await noteRow(vault, "root.md")).toBeNull();
    expect(await updateRows(docId)).toBe(0);
  });

  it("permission refusal (no_write_access) writes nothing", async () => {
    const reader = await signUp("reader@seed.test");
    await seedMember(org, reader.userId, "member");
    await pool.query("DELETE FROM shares WHERE org_id = $1", [org]);
    await seedVaultGrant(org, "view");
    const docId = randomUUID();
    const { body } = await batch(reader, [{ relPath: "nope.md", docId, state: stateFor("nope") }]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "no_write_access", seeded: false });
    expect(await noteRow(vault, "nope.md")).toBeNull();
    expect(await updateRows(docId)).toBe(0);
    expect(rec.registryBroadcasts).toHaveLength(0);
  });

  it("quota refusal (note_limit_reached) writes nothing", async () => {
    vi.stubEnv("BAALDA_DEPLOYMENT", "cloud");
    await pool.query(
      `INSERT INTO notes (id, vault_id, rel_path, doc_id, created_by)
       SELECT 'q-' || n, $1, 'note-' || n || '.md', 'q-' || n, $2 FROM generate_series(1,20000) n`,
      [vault, owner.userId],
    );
    const docId = randomUUID();
    const { body } = await batch(owner, [{ relPath: "over.md", docId, state: stateFor("over") }]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "note_limit_reached", seeded: false });
    expect(await noteRow(vault, "over.md")).toBeNull();
    expect(await updateRows(docId)).toBe(0);
  });

  it("old-shape items answer exactly as before, with no new fields", async () => {
    const { body } = await batch(owner, [{ relPath: "plain.md" }]);
    expect(Object.keys(body.results[0]).sort()).toEqual(
      ["code", "docId", "error", "folderId", "relPath", "status", "title"].sort(),
    );
    expect(body.results[0].status).toBe("created");
    // Stateless creates still take up to batchMaxNotes items.
    const many = Array.from({ length: config.batchMaxDocs + 1 }, (_, i) => ({ relPath: `m-${i}.md` }));
    const res = await batch(owner, many);
    expect(res.status).toBe(200);
  });

  it("more than batchMaxDocs items with state is a 400 batch_too_large, and writes nothing", async () => {
    const items = Array.from({ length: config.batchMaxDocs + 1 }, (_, i) => ({
      relPath: `s-${i}.md`,
      state: stateFor(`n${i}`),
    }));
    const { status, body } = await batch(owner, items);
    expect(status).toBe(400);
    expect(body.code).toBe("batch_too_large");
    expect(await noteRow(vault, "s-0.md")).toBeNull();
  });

  it("decoded state over the batch cap is a 400; a single big item is allowed", async () => {
    const big = "x".repeat(Math.ceil(config.batchMaxDecodedBytes / 2) + 1024);
    const { status, body } = await batch(owner, [
      { relPath: "big-1.md", state: stateFor(big) },
      { relPath: "big-2.md", state: stateFor(big) },
    ]);
    expect(status).toBe(400);
    expect(body.code).toBe("batch_too_large");

    const single = "y".repeat(config.batchMaxDecodedBytes + 1024);
    const one = await batch(owner, [{ relPath: "single.md", state: stateFor(single) }]);
    expect(one.status).toBe(200);
    expect(one.body.results[0]).toMatchObject({ status: "created", seeded: true });
  });

  it("a malformed state is refused per item and gets no row", async () => {
    const { body } = await batch(owner, [{ relPath: "bad.md", state: "not-yjs-at-all" }]);
    expect(body.results[0]).toMatchObject({ status: "error", code: "invalid_state", seeded: false });
    expect(await noteRow(vault, "bad.md")).toBeNull();
  });

  describe("POST /api/notes", () => {
    const create = async (user: TestUser, body: Record<string, unknown>) => {
      const res = await req(user, "POST", "/api/notes", { vaultId: vault, ...body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    it("creates and seeds", async () => {
      const docId = randomUUID();
      const { status, body } = await create(owner, { relPath: "one.md", docId, state: stateFor("one") });
      expect(status).toBe(201);
      expect(body).toMatchObject({ docId, seeded: true, content: "applied" });
      expect(await contentOf(docId)).toBe("one");
      expect(await atBroadcast[0]).toBe(1);
    });

    it("retry answers covered", async () => {
      const docId = randomUUID();
      const state = stateFor("again", 9);
      await create(owner, { relPath: "again.md", docId, state });
      const { status, body } = await create(owner, { relPath: "again.md", docId, state });
      expect(status).toBe(200);
      expect(body).toMatchObject({ seeded: true, content: "covered" });
      expect(await updateRows(docId)).toBe(1);
    });

    it("adopt onto another id writes nothing", async () => {
      const winner = await seedNote(vault, null, "w.md", owner.userId);
      const { status, body } = await create(owner, { relPath: "W.md", docId: randomUUID(), state: stateFor("x") });
      expect(status).toBe(200);
      expect(body).toMatchObject({ docId: winner, seeded: false, reason: "adopted" });
      expect(await updateRows(winner)).toBe(0);
    });

    it("without state answers exactly as before", async () => {
      const { status, body } = await create(owner, { relPath: "plain.md" });
      expect(status).toBe(201);
      expect(Object.keys(body).sort()).toEqual(["docId", "folderId", "id", "relPath", "title", "vaultId"].sort());
    });
  });

  it("GET /health reports the server version, the desktop floor and bootstrap-only", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const prev = process.env.MIN_CLIENT_VERSION;
    try {
      delete process.env.MIN_CLIENT_VERSION;
      const res = await app.fetch(new Request("http://local/health"));
      const body = (await res.json()) as {
        ok: boolean;
        version?: string;
        minDesktopVersion?: string | null;
        features?: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.version).toBe(pkg.version);
      expect(body.minDesktopVersion).toBe(DEFAULT_MIN_CLIENT_VERSION);
      expect(body.features).toEqual(
        expect.arrayContaining(["notes-with-state", "bootstrap-only"]),
      );

      process.env.MIN_CLIENT_VERSION = "off";
      const off = (await (await app.fetch(new Request("http://local/health"))).json()) as {
        minDesktopVersion?: string | null;
      };
      expect(off.minDesktopVersion).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MIN_CLIENT_VERSION;
      else process.env.MIN_CLIENT_VERSION = prev;
    }
  });
});
