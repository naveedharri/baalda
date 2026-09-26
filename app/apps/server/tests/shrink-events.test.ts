import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { applyDetached } from "../src/sync/doc-batch.js";
import { createVersionCapture, recordVersion } from "../src/versions/capture.js";
import { setShrinkHook } from "../src/versions/shrink-guard.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { memoryDocWriter, testAppDeps } from "./helpers/app.js";
import { seedItemPrivate, seedMember, seedNote, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * `GET /api/vaults/:vaultId/shrink-events`: the `pre-shrink` versions (#200)
 * on notes the caller can read, newest first, with before/after sizes.
 */

const app = createApp(testAppDeps());
const BODY = "A long paragraph that a runaway writer is about to wipe. ".repeat(10);

type Events = {
  items: Array<{
    versionId: number;
    docId: string;
    relPath: string;
    capturedAt: string;
    beforeChars: number;
    afterChars: number;
    deleted: boolean;
  }>;
  truncated: boolean;
  afterIsCurrent: boolean;
};

function get(user: TestUser, path: string) {
  return app.fetch(new Request(`http://local${path}`, { headers: authHeaders(user) }));
}

afterAll(async () => {
  await pool.end();
});

describe("shrink events", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let org: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@shrink-events.test");
    org = (await createOrg(owner, "Shrink Co", "shrink-co")).id;
    member = await signUp("member@shrink-events.test");
    await seedMember(org, member.userId, "member");
    outsider = await signUp("outsider@shrink-events.test");
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterEach(() => setShrinkHook(null));

  it("a real shrink produces one item with the right sizes", async () => {
    const docId = await seedNote(vault, null, "n.md", owner.userId);
    const capture = createVersionCapture({ docWriter: memoryDocWriter(), idleMs: 60_000 });
    const pending: Promise<void>[] = [];
    setShrinkHook((v, d, previousText) => {
      pending.push(capture.preShrink(v, d, previousText));
    });
    try {
      const actor = { userId: owner.userId };
      await applyDetached(vault, docId, (d) => d.getText("content").insert(0, BODY), actor);
      await applyDetached(vault, docId, (d) => {
        const t = d.getText("content");
        t.delete(0, t.length);
        t.insert(0, "left");
      }, actor);
      await Promise.all(pending);
    } finally {
      capture.stop();
    }

    const res = await get(member, `/api/vaults/${vault}/shrink-events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Events;
    expect(body.afterIsCurrent).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      docId,
      relPath: "n.md",
      beforeChars: BODY.length,
      afterChars: 4,
      deleted: false,
    });
  });

  it("refuses an outsider, filters unreadable notes, keeps deleted ones, excludes pre-revert", async () => {
    const visible = await seedNote(vault, null, "v.md", owner.userId);
    const hidden = await seedNote(vault, null, "h.md", owner.userId);
    const gone = await seedNote(vault, null, "g.md", owner.userId);
    for (const d of [visible, hidden, gone]) {
      await recordVersion({ vaultId: vault, docId: d, content: `before ${d}`, cause: "pre-shrink", authorId: null });
    }
    await recordVersion({ vaultId: vault, docId: visible, content: "revert", cause: "pre-revert", authorId: null });
    await seedItemPrivate(org, "file", hidden);
    await pool.query(
      "UPDATE notes SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [gone],
    );

    expect((await get(outsider, `/api/vaults/${vault}/shrink-events`)).status).toBe(403);
    const body = (await (await get(member, `/api/vaults/${vault}/shrink-events`)).json()) as Events;
    expect(new Set(body.items.map((i) => i.docId))).toEqual(new Set([visible, gone]));
    expect(body.items.find((i) => i.docId === gone)?.deleted).toBe(true);
  });

  it("`since` and `limit` filter the list", async () => {
    const a = await seedNote(vault, null, "a.md", owner.userId);
    const b = await seedNote(vault, null, "b.md", owner.userId);
    await recordVersion({ vaultId: vault, docId: a, content: "old", cause: "pre-shrink", authorId: null });
    await pool.query("UPDATE note_versions SET created_at = now() - interval '40 days' WHERE doc_id = $1", [a]);
    await recordVersion({ vaultId: vault, docId: b, content: "new", cause: "pre-shrink", authorId: null });

    // Default look-back is 30 days: the 40-day-old event is out.
    let body = (await (await get(member, `/api/vaults/${vault}/shrink-events`)).json()) as Events;
    expect(body.items.map((i) => i.docId)).toEqual([b]);

    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    body = (await (await get(member, `/api/vaults/${vault}/shrink-events?since=${since}`)).json()) as Events;
    expect(body.items.map((i) => i.docId)).toEqual([b, a]);

    body = (await (await get(member, `/api/vaults/${vault}/shrink-events?since=${since}&limit=1`)).json()) as Events;
    expect(body.items.map((i) => i.docId)).toEqual([b]);
    expect(body.truncated).toBe(true);

    expect((await get(member, `/api/vaults/${vault}/shrink-events?since=nope`)).status).toBe(400);
  });
});
