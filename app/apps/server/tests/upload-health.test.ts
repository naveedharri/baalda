import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedShare, seedVault } from "./helpers/seed.js";

/**
 * #257: a confirmed-empty note is told apart from one whose upload never
 * arrived, and the second kind is counted for owners. The marker is purely
 * informational — these tests also pin that it never touches content.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

function request(user: TestUser, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: authHeaders(user),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function age(noteId: string, minutes: number) {
  await pool.query(
    "UPDATE notes SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1",
    [noteId, minutes],
  );
}

async function giveContent(noteId: string) {
  await pool.query("INSERT INTO doc_updates (doc_id, update) VALUES ($1, $2)", [
    noteId,
    Buffer.from([1, 2, 3]),
  ]);
}

describe("confirmed-empty notes and stalled uploads", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let empty: string;
  let stalled: string;
  let full: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@upload-health.test");
    orgId = (await createOrg(owner, "Upload Health Co", "upload-health-co")).id;
    member = await signUp("member@upload-health.test");
    await seedMember(orgId, member.userId, "member");
    vault = await seedVault(orgId, "V");
    empty = await seedNote(vault, null, "Empty.md", owner.userId);
    stalled = await seedNote(vault, null, "Stalled.md", owner.userId);
    full = await seedNote(vault, null, "Full.md", owner.userId);
    await giveContent(full);
    for (const id of [empty, stalled, full]) await age(id, 120);
  });

  it("marks only contentless notes, and never touches content", async () => {
    const res = await request(owner, "POST", `/api/vaults/${vault}/notes/confirm-empty`, {
      docIds: [empty, full],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmed: [empty] });

    const { rows } = await pool.query<{ id: string; confirmed_empty_at: Date | null }>(
      "SELECT id, confirmed_empty_at FROM notes WHERE id = ANY($1::text[])",
      [[empty, full]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.confirmed_empty_at]));
    expect(byId.get(empty)).not.toBeNull();
    expect(byId.get(full)).toBeNull();
    const { rows: updates } = await pool.query("SELECT 1 FROM doc_updates WHERE doc_id = $1", [full]);
    expect(updates).toHaveLength(1);
  });

  it("counts registered notes whose content never arrived, for owners", async () => {
    await request(owner, "POST", `/api/vaults/${vault}/notes/confirm-empty`, { docIds: [empty] });
    const res = await request(owner, "GET", `/api/vaults/${vault}/upload-health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stalled: number;
      confirmedEmpty: number;
      byCreator: Array<{ userId: string; count: number }>;
    };
    expect(body.stalled).toBe(1);
    expect(body.confirmedEmpty).toBe(1);
    expect(body.byCreator).toEqual([expect.objectContaining({ userId: owner.userId, count: 1 })]);
  });

  it("stops counting a stalled note once its content arrives", async () => {
    await giveContent(stalled);
    const res = await request(owner, "GET", `/api/vaults/${vault}/upload-health`);
    // Only `empty` is left: contentless and (in this test) never confirmed.
    expect(((await res.json()) as { stalled: number }).stalled).toBe(1);
  });

  it("does not count a note registered moments ago", async () => {
    await age(stalled, 0);
    await age(empty, 0);
    const res = await request(owner, "GET", `/api/vaults/${vault}/upload-health`);
    expect(((await res.json()) as { stalled: number }).stalled).toBe(0);
  });

  it("is a manager-only census", async () => {
    const res = await request(member, "GET", `/api/vaults/${vault}/upload-health`);
    expect(res.status).toBe(403);
  });

  it("refuses to let a view-only member vouch for emptiness", async () => {
    // No vault grant (private), so this per-note view share is all they have.
    await seedShare(orgId, "file", empty, member.userId, "view");
    const res = await request(member, "POST", `/api/vaults/${vault}/notes/confirm-empty`, {
      docIds: [empty],
    });
    expect(await res.json()).toEqual({ confirmed: [] });
  });

  it("ignores ids from another vault", async () => {
    const other = await seedVault(orgId, "Other");
    const elsewhere = await seedNote(other, null, "Elsewhere.md", owner.userId);
    const res = await request(owner, "POST", `/api/vaults/${vault}/notes/confirm-empty`, {
      docIds: [elsewhere],
    });
    expect(await res.json()).toEqual({ confirmed: [] });
  });
});
