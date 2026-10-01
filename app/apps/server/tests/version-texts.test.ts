import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { BULK_SEED_ORIGIN } from "../src/sync/doc-batch.js";
import {
  createVersionCapture,
  MAX_VERSIONS_PER_NOTE,
  recordVersion,
  sha256Hex,
} from "../src/versions/capture.js";
import { maybeDailyCheckpoint } from "../src/versions/checkpoints.js";
import { gcNoteTexts, TEXT_GC_GRACE_MS } from "../src/versions/texts.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { memoryDocWriter, testAppDeps } from "./helpers/app.js";
import { seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * #253 (a shrink is always recorded), #254 (a checkpoint after a wipe keeps
 * the text from before it) and #264 (version + checkpoint text is
 * content-addressed in `note_texts`, older inline rows stay readable).
 */

const app = createApp(testAppDeps());
const BODY = "A long paragraph somebody wrote and wants to keep around. ".repeat(10);

function get(user: TestUser, path: string) {
  return app.fetch(new Request(`http://local${path}`, { headers: authHeaders(user) }));
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

afterAll(async () => {
  await pool.end();
});

describe("version text storage", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@version-texts.test");
    org = (await createOrg(owner, "Texts Co", "texts-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });

  it("#253: wiping a note whose text equals its latest version still yields a shrink event", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    await recordVersion({ vaultId: vault, docId, content: BODY, cause: "idle", authorId: owner.userId });

    const capture = createVersionCapture({ docWriter: memoryDocWriter(), idleMs: 60_000 });
    try {
      await capture.preShrink(vault, docId, BODY);
    } finally {
      capture.stop();
    }

    const res = await get(owner, `/api/vaults/${vault}/shrink-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ docId: string; beforeChars: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ docId, beforeChars: BODY.length });

    // Two version rows, one stored copy of the text.
    expect(await count("SELECT count(*) AS n FROM note_versions WHERE doc_id = $1", [docId])).toBe(2);
    expect(await count("SELECT count(*) AS n FROM note_texts WHERE doc_id = $1", [docId])).toBe(1);
  });

  it("#253: idle captures of the emptied note never prune its recent pre-shrink version", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    await recordVersion({ vaultId: vault, docId, content: BODY, cause: "pre-shrink", authorId: null });
    for (let i = 0; i < MAX_VERSIONS_PER_NOTE + 5; i++) {
      await recordVersion({ vaultId: vault, docId, content: `empty-ish ${i}`, cause: "idle", authorId: null });
    }
    const { rows } = await pool.query<{ cause: string }>(
      "SELECT cause FROM note_versions WHERE doc_id = $1",
      [docId],
    );
    expect(rows.filter((r) => r.cause === "pre-shrink")).toHaveLength(1);
    // …and the ordinary history keeps exactly as many as it always did.
    expect(rows.filter((r) => r.cause === "idle")).toHaveLength(MAX_VERSIONS_PER_NOTE);
  });

  it("#254: a checkpoint taken after a wipe stores the note's text from before it", async () => {
    const wiped = await seedNote(vault, null, "wiped.md", owner.userId);
    const fine = await seedNote(vault, null, "fine.md", owner.userId);
    const writer = memoryDocWriter();
    writer.store.set(fine, "still here");
    writer.store.set(wiped, "/");
    await recordVersion({ vaultId: vault, docId: wiped, content: BODY, cause: "pre-shrink", authorId: null });

    const made = await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer });
    expect(made).toMatchObject({ noteCount: 2, carriedPreShrink: 1 });

    const { rows } = await pool.query<{ doc_id: string; content: string; inline: string | null }>(
      `SELECT d.doc_id, COALESCE(d.content, t.content) AS content, d.content AS inline
         FROM vault_checkpoint_docs d
         LEFT JOIN note_texts t ON t.doc_id = d.doc_id AND t.sha256 = d.sha256
        WHERE d.checkpoint_id = $1`,
      [made!.id],
    );
    const byDoc = new Map(rows.map((r) => [r.doc_id, r]));
    expect(byDoc.get(wiped)?.content).toBe(BODY);
    expect(byDoc.get(fine)?.content).toBe("still here");
    expect(rows.every((r) => r.inline === null)).toBe(true);

    const { rows: cp } = await pool.query<{ structure: { carriedPreShrink?: string[] } }>(
      "SELECT structure FROM vault_checkpoints WHERE id = $1",
      [made!.id],
    );
    expect(cp[0].structure.carriedPreShrink).toEqual([wiped]);
  });

  it("#254: a sharp shrink holds the activity-triggered checkpoint; a bulk seed never fires it", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const dailyCheckpoint = vi.fn(async (_vaultId: string) => null);
    const capture = createVersionCapture({ docWriter: memoryDocWriter(), idleMs: 60_000, dailyCheckpoint });
    try {
      capture.touch(vault, docId, null, BULK_SEED_ORIGIN);
      expect(dailyCheckpoint).not.toHaveBeenCalled();

      const shrink = capture.preShrink(vault, docId, BODY);
      capture.touch(vault, docId, null);
      await shrink;
      expect(dailyCheckpoint).not.toHaveBeenCalled();

      // Another vault is unaffected.
      const other = await seedVault(org);
      capture.touch(other, "other-doc", null);
      expect(dailyCheckpoint).toHaveBeenCalledWith(other);
    } finally {
      capture.stop();
    }
  });

  it("#264: an unchanged vault's second checkpoint adds no text", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    const writer = memoryDocWriter();
    writer.store.set(a, "alpha");
    writer.store.set(b, "beta");
    // An idle version already holds `alpha`: the checkpoint reuses it.
    await recordVersion({ vaultId: vault, docId: a, content: "alpha", cause: "idle", authorId: null });

    const first = await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer });
    expect(first).not.toBeNull();
    const textsAfterFirst = await count("SELECT count(*) AS n FROM note_texts WHERE vault_id = $1", [vault]);
    expect(textsAfterFirst).toBe(2);

    // A day later, nothing changed: a second checkpoint is all references.
    await pool.query("UPDATE vault_checkpoints SET created_at = now() - interval '25 hours' WHERE vault_id = $1", [vault]);
    const second = await maybeDailyCheckpoint({ vaultId: vault, docWriter: writer });
    expect(second).not.toBeNull();
    expect(await count("SELECT count(*) AS n FROM note_texts WHERE vault_id = $1", [vault])).toBe(textsAfterFirst);
  });

  it("#264: a version stored inline before migration 038 stays readable", async () => {
    const docId = await seedNote(vault, null, "legacy.md", owner.userId);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO note_versions (doc_id, vault_id, content, sha256, cause)
       VALUES ($1, $2, $3, $4, 'idle') RETURNING id`,
      [docId, vault, "legacy body", sha256Hex("legacy body")],
    );
    const res = await get(owner, `/api/notes/${docId}/versions/${rows[0].id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: "legacy body", size: "legacy body".length });

    const list = (await (await get(owner, `/api/notes/${docId}/versions`)).json()) as {
      versions: Array<{ size: number }>;
    };
    expect(list.versions.map((v) => v.size)).toEqual(["legacy body".length]);
  });

  it("#264: the sweep drops only old, unreferenced texts", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    await recordVersion({ vaultId: vault, docId, content: "kept", cause: "idle", authorId: null });
    await pool.query(
      `INSERT INTO note_texts (doc_id, sha256, vault_id, content, last_ref_at)
       VALUES ($1, 'orphan-old', $2, 'x', now() - ($3::bigint + 60000) * interval '1 millisecond'),
              ($1, 'orphan-new', $2, 'y', now())`,
      [docId, vault, TEXT_GC_GRACE_MS],
    );
    await pool.query("UPDATE note_texts SET last_ref_at = now() - interval '2 days' WHERE sha256 = $1", [
      sha256Hex("kept"),
    ]);

    expect(await gcNoteTexts(pool, vault)).toBe(1);
    const { rows } = await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM note_texts WHERE doc_id = $1 ORDER BY sha256",
      [docId],
    );
    expect(rows.map((r) => r.sha256).sort()).toEqual([sha256Hex("kept"), "orphan-new"].sort());
  });
});
