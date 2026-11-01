// SPDX-License-Identifier: Apache-2.0
//
// A desktop that predates vault keys must never meet a response it has never
// seen (409 `key_required`, vault-channel close 4409, a per-doc `key_required`
// denial) on a KEYED vault: every entry point answers it with the
// `426 client_outdated` it already treats as "stop syncing and update", and
// writes nothing. A vault-key build (version >= VAULT_KEYS_MIN_DESKTOP, or a
// request presenting the verified key) gets today's key flow. Unkeyed vaults
// are unchanged for everyone.
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import {
  CLIENT_OUTDATED_CODE,
  VAULT_KEYS_MIN_DESKTOP,
  isVaultKeyCapableVersion,
} from "../src/http/client-version.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function updateWith(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

async function setup(keyed: boolean) {
  const owner = await signUp(`owner-${keyed}-${Date.now()}@oldclient.test`);
  const org = await createOrg(owner, "Old client", `old-client-${keyed}-${Date.now()}`);
  const vaultId = await seedVault(org.id);
  const vk = randomBytes(32);
  if (keyed) {
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(vk, vaultId),
    ]);
  }
  const docId = await seedNote(vaultId, null, "n.md", owner.userId);
  return { owner, vaultId, vk, docId };
}

/** How a client identifies itself: nothing (every pre-#251 path of an old
 *  build), the old build's own version, a staging build of it, or a new build. */
type Who = { version?: string; vk?: Buffer };

function call(user: TestUser, method: string, path: string, who: Who, body?: unknown) {
  // The old desktop sends its version as the `clientVersion` query parameter.
  const sep = path.includes("?") ? "&" : "?";
  const url = who.version ? `/api${path}${sep}clientVersion=${encodeURIComponent(who.version)}` : `/api${path}`;
  return app.request(url, {
    method,
    headers: { ...authHeaders(user), ...(who.vk ? { "x-baalda-vk": b64(who.vk) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function counts() {
  const { rows } = await pool.query<{ notes: string; updates: string; blobs: string; files: string }>(
    `SELECT (SELECT count(*) FROM notes) AS notes,
            (SELECT count(*) FROM doc_updates) AS updates,
            (SELECT count(*) FROM blobs) AS blobs,
            (SELECT count(*) FROM files) AS files`,
  );
  return rows[0];
}

/** Every keyed-vault entry point an old build reaches. */
function entryPoints(s: Awaited<ReturnType<typeof setup>>) {
  const state = b64(updateWith("old client text"));
  return [
    ["POST", "/sync-token", { docId: s.docId }],
    ["POST", "/vault-sync-token", { vaultId: s.vaultId }],
    ["POST", `/vaults/${s.vaultId}/bootstrap`, { have: [] }],
    ["GET", `/vaults/${s.vaultId}/bootstrap/some-session`, undefined],
    ["POST", `/vaults/${s.vaultId}/docs/batch`, { items: [{ docId: s.docId, update: state }] }],
    [
      "POST",
      `/vaults/${s.vaultId}/notes/batch`,
      { items: [{ docId: "11111111-2222-4333-8444-555555555555", relPath: "a.md", state }] },
    ],
    [
      "POST",
      `/vaults/${s.vaultId}/notes/batch`,
      { items: [{ docId: "11111111-2222-4333-8444-666666666666", relPath: "b.md" }] },
    ],
    ["POST", "/notes", { vaultId: s.vaultId, relPath: "c.md", docId: "11111111-2222-4333-8444-777777777777", state }],
    ["POST", "/notes", { vaultId: s.vaultId, relPath: "d.md", docId: "11111111-2222-4333-8444-888888888888" }],
    [
      "POST",
      `/vaults/${s.vaultId}/blobs/intent`,
      { relPath: "attachments/x.png", sha256: "a".repeat(64), size: 3, mime: "image/png" },
    ],
    ["GET", `/vaults/${s.vaultId}/search?q=hello`, undefined],
    // File registration: the bytes would be refused, so no byte-less `files` row.
    ["POST", "/files", { vaultId: s.vaultId, path: "report.pdf", docId: "11111111-2222-4333-8444-999999999999" }],
    [
      "POST",
      `/vaults/${s.vaultId}/files/batch`,
      { items: [{ relPath: "pic.png", sha256: "b".repeat(64), size: 3, mime: "image/png" }] },
    ],
  ] as const;
}

describe("vault keys: desktops that predate them", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("capability is a version at or above the vault-keys release; missing means old", () => {
    expect(isVaultKeyCapableVersion(undefined)).toBe(false);
    expect(isVaultKeyCapableVersion("")).toBe(false);
    expect(isVaultKeyCapableVersion("garbage")).toBe(false);
    expect(isVaultKeyCapableVersion("0.1.97")).toBe(false);
    expect(isVaultKeyCapableVersion("0.1.97-staging.5")).toBe(false);
    expect(isVaultKeyCapableVersion(VAULT_KEYS_MIN_DESKTOP)).toBe(true);
    expect(isVaultKeyCapableVersion(`${VAULT_KEYS_MIN_DESKTOP}-staging.3`)).toBe(true);
    expect(isVaultKeyCapableVersion("0.2.0")).toBe(true);
  });

  for (const version of [undefined, "0.1.97", "0.1.97-staging.5"]) {
    it(`keyed vault, old build (${version ?? "no version"}): 426 client_outdated everywhere, nothing written`, async () => {
      const s = await setup(true);
      const before = await counts();
      for (const [method, path, body] of entryPoints(s)) {
        const res = await call(s.owner, method, path, { version }, body);
        expect({ path, status: res.status }).toEqual({ path, status: 426 });
        expect(await res.json()).toMatchObject({ code: CLIENT_OUTDATED_CODE, minVersion: VAULT_KEYS_MIN_DESKTOP });
      }
      // Even the legacy single-request upload stores nothing.
      const legacy = await app.request(`/api/vaults/${s.vaultId}/blobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${s.owner.token}`,
          "content-type": "application/octet-stream",
          "x-rel-path": "attachments/y.png",
          ...(version ? { "x-baalda-version": version } : {}),
        },
        body: randomBytes(8),
      });
      expect(legacy.status).toBe(426);
      expect(await counts()).toEqual(before);
    });
  }

  it("keyed vault, old build: blob complete is refused and the row stays pending", async () => {
    const s = await setup(true);
    const newBuild = { version: VAULT_KEYS_MIN_DESKTOP };
    const intent = await call(s.owner, "POST", `/vaults/${s.vaultId}/blobs/intent`, newBuild, {
      relPath: "attachments/z.png",
      sha256: "b".repeat(64),
      size: 3,
      mime: "image/png",
    });
    expect(intent.status).toBeLessThan(300);
    const { blobId } = (await intent.json()) as { blobId: string };
    const done = await call(s.owner, "POST", `/blobs/${blobId}/complete`, {}, {});
    expect(done.status).toBe(426);
    const { rows } = await pool.query("SELECT status FROM blobs WHERE id = $1", [blobId]);
    expect(rows[0]?.status).toBe("pending");
  });

  it("keyed vault, vault-key build without the key: today's key flow (409 key_required, tokens mint)", async () => {
    const s = await setup(true);
    const who = { version: VAULT_KEYS_MIN_DESKTOP };
    const push = await call(s.owner, "POST", `/vaults/${s.vaultId}/docs/batch`, who, {
      items: [{ docId: s.docId, update: b64(updateWith("x")) }],
    });
    expect(push.status).toBe(409);
    expect(await push.json()).toMatchObject({ code: "key_required" });
    const page = await call(s.owner, "GET", `/vaults/${s.vaultId}/bootstrap/some-session`, who);
    expect(page.status).toBe(409);
    expect((await call(s.owner, "POST", "/sync-token", who, { docId: s.docId })).status).toBe(200);
    expect((await call(s.owner, "POST", "/vault-sync-token", who, { vaultId: s.vaultId })).status).toBe(200);
    // Registration without state never needed the key.
    const reg = await call(s.owner, "POST", `/vaults/${s.vaultId}/notes/batch`, who, {
      items: [{ docId: "11111111-2222-4333-8444-999999999999", relPath: "e.md" }],
    });
    expect(reg.status).toBe(200);
  });

  it("keyed vault: a request presenting the verified key is capable whatever it reports", async () => {
    const s = await setup(true);
    const push = await call(s.owner, "POST", `/vaults/${s.vaultId}/docs/batch`, { version: "0.1.97", vk: s.vk }, {
      items: [{ docId: s.docId, update: b64(updateWith("with key")) }],
    });
    expect(push.status).toBe(200);
    // A WRONG key proves nothing: still the old build's 426.
    const wrong = await call(s.owner, "POST", `/vaults/${s.vaultId}/docs/batch`, { version: "0.1.97", vk: randomBytes(32) }, {
      items: [{ docId: s.docId, update: b64(updateWith("wrong key")) }],
    });
    expect(wrong.status).toBe(426);
  });

  it("unkeyed vault: an old build (no version) works exactly as before", async () => {
    const s = await setup(false);
    const old = {};
    expect((await call(s.owner, "POST", "/sync-token", old, { docId: s.docId })).status).toBe(200);
    expect((await call(s.owner, "POST", "/vault-sync-token", old, { vaultId: s.vaultId })).status).toBe(200);
    const push = await call(s.owner, "POST", `/vaults/${s.vaultId}/docs/batch`, old, {
      items: [{ docId: s.docId, update: b64(updateWith("plain")) }],
    });
    expect(push.status).toBe(200);
    const reg = await call(s.owner, "POST", `/vaults/${s.vaultId}/notes/batch`, old, {
      items: [{ docId: "11111111-2222-4333-8444-aaaaaaaaaaaa", relPath: "f.md", state: b64(updateWith("f")) }],
    });
    expect(reg.status).toBe(200);
    const one = await call(s.owner, "POST", "/notes", old, {
      vaultId: s.vaultId,
      relPath: "g.md",
      docId: "11111111-2222-4333-8444-bbbbbbbbbbbb",
    });
    expect(one.status).toBeLessThan(300);
    const boot = await call(s.owner, "POST", `/vaults/${s.vaultId}/bootstrap`, old, { have: [] });
    expect(boot.status).toBeLessThan(300);
    const search = await call(s.owner, "GET", `/vaults/${s.vaultId}/search?q=plain`, old);
    expect(search.status).toBe(200);
    const file = await call(s.owner, "POST", "/files", old, { vaultId: s.vaultId, path: "r.pdf" });
    expect(file.status).toBeLessThan(300);
    const files = await call(s.owner, "POST", `/vaults/${s.vaultId}/files/batch`, old, {
      items: [{ relPath: "p.png", sha256: "b".repeat(64), size: 3, mime: "image/png" }],
    });
    expect(files.status).toBe(200);
  });

  it("flag off: a keyed row is never consulted (old builds unaffected)", async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    const s = await setup(true);
    expect((await call(s.owner, "POST", "/sync-token", {}, { docId: s.docId })).status).toBe(200);
  });
});
