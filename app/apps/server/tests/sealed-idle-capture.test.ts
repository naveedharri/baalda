// SPDX-License-Identifier: Apache-2.0
//
// Idle version capture on a keyed vault. The per-doc socket that made the edit
// has usually closed by the time the ten-minute idle capture fires, so the
// note is read from its SEALED log: the capture must take the key from the
// process cache (held by a member's vault channel) for the read as well as for
// sealing, and with no key held it defers quietly and captures once one arrives.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { createVersionCapture } from "../src/versions/capture.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import { KeyRequiredError } from "../src/crypto/transport.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedNote, seedVault } from "./helpers/seed.js";

const SECRET = "board minutes, confidential";

/** A doc writer whose doc is NOT live: reading its sealed log needs the key. */
function sealedLogWriter(text: () => string) {
  const seen: Array<DocCrypto | undefined> = [];
  return {
    seen,
    async peekContent(_vaultId: string, _docId: string, crypto?: DocCrypto) {
      seen.push(crypto ? { ...crypto } : undefined);
      if (!crypto) throw new KeyRequiredError();
      return text();
    },
  };
}

async function versionRows() {
  return (
    await pool.query<{ sha256: string; content: string | null; content_enc: Buffer | null }>(
      `SELECT v.sha256, t.content, t.content_enc FROM note_versions v
         LEFT JOIN note_texts t ON t.doc_id = v.doc_id AND t.sha256 = v.sha256
        ORDER BY v.id`,
    )
  ).rows;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("idle version capture on a keyed vault", () => {
  let owner: TestUser;
  let vaultId: string;
  let docId: string;
  let vk: Buffer;

  beforeEach(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    vaultKeyCache.clear();
    owner = await signUp("owner@idle.test");
    const org = await createOrg(owner, "Idle", `idle-${Date.now()}`);
    vaultId = await seedVault(org.id);
    vk = randomBytes(32);
    await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [
      vaultId,
      makeVkCheck(vk, vaultId),
    ]);
    docId = await seedNote(vaultId, null, "minutes.md", owner.userId);
  });
  afterEach(() => {
    vaultKeyCache.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("with a member's key cached: reads the sealed log with it and stores a sealed version", async () => {
    const release = vaultKeyCache.acquire(vaultId, vk, 1);
    const writer = sealedLogWriter(() => SECRET);
    const errors = vi.spyOn(console, "error");
    const capture = createVersionCapture({ docWriter: writer as never, idleMs: 60_000 });
    try {
      capture.touch(vaultId, docId, owner.userId);
      await capture.flush(docId);
      await capture.settled();
    } finally {
      capture.stop();
      release();
    }
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("idle capture failed"))).toEqual([]);
    expect(writer.seen[0]?.vaultId).toBe(vaultId);
    const rows = await versionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_enc).not.toBeNull();
    expect(rows[0].content).toBe("");
    expect(rows[0].content_enc!.includes(Buffer.from("confidential"))).toBe(false);
  });

  it("with no key held: writes nothing, logs nothing, and captures once a key is acquired", async () => {
    const writer = sealedLogWriter(() => SECRET);
    const errors = vi.spyOn(console, "error");
    const capture = createVersionCapture({ docWriter: writer as never, idleMs: 60_000 });
    try {
      capture.touch(vaultId, docId, owner.userId);
      await capture.flush(docId);
      expect(await versionRows()).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM note_texts")).rows).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();

      // A member's vault channel connects: the deferred capture runs.
      const release = vaultKeyCache.acquire(vaultId, vk, 1);
      await tick();
      await capture.settled();
      release();
    } finally {
      capture.stop();
    }
    expect(errors).not.toHaveBeenCalled();
    const rows = await versionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_enc).not.toBeNull();
  });

  it("a deferred capture also retries on the fallback timer", async () => {
    const writer = sealedLogWriter(() => SECRET);
    // No acquire notifications: only the fallback timer can retry.
    const keyCache = { onAcquire: () => () => {}, has: (v: string) => vaultKeyCache.has(v) };
    const capture = createVersionCapture({
      docWriter: writer as never,
      idleMs: 60_000,
      keyCache,
      keyRetryMs: 20,
    });
    try {
      capture.touch(vaultId, docId, owner.userId);
      await capture.flush(docId);
      await tick(50);
      expect(await versionRows()).toHaveLength(0);
      const release = vaultKeyCache.acquire(vaultId, vk, 1);
      await tick(80);
      await capture.settled();
      release();
    } finally {
      capture.stop();
    }
    expect(await versionRows()).toHaveLength(1);
  });

  it("an edit while deferred takes over: its own capture stores the newer text", async () => {
    let text = SECRET;
    const writer = sealedLogWriter(() => text);
    const capture = createVersionCapture({ docWriter: writer as never, idleMs: 60_000 });
    try {
      capture.touch(vaultId, docId, owner.userId);
      await capture.flush(docId);
      text = `${SECRET} (amended)`;
      capture.touch(vaultId, docId, owner.userId);
      const release = vaultKeyCache.acquire(vaultId, vk, 1);
      await tick();
      await capture.settled();
      // The live session was not captured by the acquire; its idle timer does it.
      expect(await versionRows()).toHaveLength(0);
      await capture.flush(docId);
      release();
    } finally {
      capture.stop();
    }
    expect(await versionRows()).toHaveLength(1);
  });
});
