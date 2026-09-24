import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { recordVersion } from "../src/versions/capture.js";
import { assessNote, type VersionText } from "../src/versions/recovery.js";
import { parseCsv } from "../src/scripts/recover-notes.js";
import { recordingAppDeps, type RecordingAppDeps } from "./helpers/app.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

/** Issue #200: reviewed, reversible recovery of notes damaged by past sync bugs. */

const GOOD = "# Plan\n\n" + "Everything the team agreed on, in detail. ".repeat(10) + "\n\nOwner: Sam\n";
const v = (id: number, content: string): VersionText => ({
  id,
  createdAt: new Date(2026, 8, id).toISOString(),
  content,
});

describe("assessNote", () => {
  it("proposes the last full version for an emptied note, losslessly", () => {
    const got = assessNote("", [v(1, GOOD.slice(0, 250)), v(2, GOOD), v(3, "")]);
    expect(got).toMatchObject({ kind: "shrunk", status: "restore", proposedVersionId: 2, novelLines: [] });
  });

  it("stray markers left by the wipe still restore losslessly", () => {
    expect(assessNote("**:\n#\n/", [v(1, GOOD)])).toMatchObject({ kind: "shrunk", status: "restore" });
  });

  it("marks for review when the note gained real text after the damage", () => {
    const got = assessNote("Follow-up: book the venue by Friday", [v(1, GOOD), v(2, "")]);
    expect(got).toMatchObject({ kind: "shrunk", status: "review", proposedVersionId: 1 });
    expect(got?.novelLines).toEqual(["Follow-up: book the venue by Friday"]);
  });

  it("flags repeated punctuation the note did not always have", () => {
    const damaged = GOOD.replace("Owner: Sam", "Owner:::::::: Sam,,,,,,,");
    const got = assessNote(damaged, [v(1, GOOD), v(2, damaged)]);
    expect(got).toMatchObject({ kind: "repeated", status: "review", proposedVersionId: 1 });
  });

  it("leaves healthy notes, markdown rules and dividers alone", () => {
    const table = GOOD + "\n| a | b |\n|------|------|\n\n--------\n";
    expect(assessNote(table, [v(1, GOOD), v(2, table)])).toBeNull();
    expect(assessNote(GOOD, [v(1, GOOD)])).toBeNull();
    expect(assessNote(GOOD.slice(0, 300), [v(1, GOOD)])).toBeNull(); // trimmed, not wiped
    expect(assessNote("", [])).toBeNull();
  });
});

describe("parseCsv", () => {
  it("reads quoted cells with commas, quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });
});

describe("recovery routes", () => {
  let rec: RecordingAppDeps;
  let app: ReturnType<typeof createApp>;
  const api = (user: TestUser, path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://local${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
      }),
    );

  beforeEach(async () => {
    await resetDb();
    rec = recordingAppDeps();
    app = createApp(rec.deps);
  });
  afterAll(async () => {
    await pool.end();
  });

  async function setup() {
    const owner = await signUp("rec-owner@t.com");
    const member = await signUp("rec-member@t.com");
    const org = await seedOrg("Acme", "acme-rec");
    await seedMember(org, owner.userId, "owner");
    await seedMember(org, member.userId, "member");
    const vault = await seedVault(org);
    const wiped = await seedNote(vault, null, "wiped.md", owner.userId);
    const healthy = await seedNote(vault, null, "healthy.md", owner.userId);
    const good = await recordVersion({ vaultId: vault, docId: wiped, content: GOOD, cause: "idle", authorId: owner.userId });
    await recordVersion({ vaultId: vault, docId: healthy, content: GOOD, cause: "idle", authorId: owner.userId });
    rec.docWriter.store.set(wiped, "");
    rec.docWriter.store.set(healthy, GOOD);
    return { owner, member, vault, wiped, good: good! };
  }

  it("lists damaged notes for an owner and refuses a plain member", async () => {
    const { owner, member, vault, wiped, good } = await setup();
    const res = await api(owner, `/api/vaults/${vault}/recovery`);
    expect(res.status).toBe(200);
    const { candidates } = (await res.json()) as { candidates: Array<Record<string, unknown>> };
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ docId: wiped, path: "wiped.md", status: "restore", proposedVersionId: good });

    const csv = await (await api(owner, `/api/vaults/${vault}/recovery?format=csv`)).text();
    const [head, row] = parseCsv(csv);
    expect(row[head.indexOf("apply")]).toBe("yes");
    expect(row[head.indexOf("docId")]).toBe(wiped);

    expect((await api(member, `/api/vaults/${vault}/recovery`)).status).toBe(403);
    expect(
      (await api(member, `/api/vaults/${vault}/recovery/apply`, {
        method: "POST",
        body: JSON.stringify({ items: [{ docId: wiped, versionId: good }] }),
      })).status,
    ).toBe(403);
  });

  it("restores a reviewed pair forward, keeps an undo version, and rejects foreign versions", async () => {
    const { owner, vault, wiped, good } = await setup();
    const res = await api(owner, `/api/vaults/${vault}/recovery/apply`, {
      method: "POST",
      body: JSON.stringify({
        items: [
          { docId: wiped, versionId: good },
          { docId: wiped, versionId: good + 999 },
          { docId: "not-a-note", versionId: good },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(results.map((r) => (r.ok ? true : r.error))).toEqual([true, "unknown_version", "unknown_note"]);
    expect(rec.docWriter.store.get(wiped)).toBe(GOOD);

    const { rows } = await pool.query<{ cause: string; content: string }>(
      "SELECT cause, content FROM note_versions WHERE doc_id = $1 ORDER BY id",
      [wiped],
    );
    expect(rows.map((r) => r.cause)).toEqual(["idle", "pre-revert"]);
    expect(rows[1].content).toBe("");

    // Nothing left to recover.
    const again = (await (await api(owner, `/api/vaults/${vault}/recovery`)).json()) as { candidates: unknown[] };
    expect(again.candidates).toEqual([]);
  });

  it("400s a malformed apply body", async () => {
    const { owner, vault } = await setup();
    for (const body of [{}, { items: [] }, { items: [{ docId: 1, versionId: "x" }] }]) {
      const res = await api(owner, `/api/vaults/${vault}/recovery/apply`, { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });
});
