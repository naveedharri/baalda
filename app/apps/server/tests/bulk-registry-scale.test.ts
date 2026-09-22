import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { registerCtx, registerNotes } from "../src/registry/batch-ops.js";

/**
 * How many statements a registration batch costs — the number nothing pinned
 * before, and the one that decides whether turning on sync for a 5,000-note
 * vault takes seconds or minutes on a networked Postgres.
 *
 * The old shape was 1–3 queries per note plus ~7 per distinct folder, run
 * SERIALLY on one checked-out connection: a 200-note batch across 20 folders was
 * ~740 round trips, and 5,000 notes ~18,500 — i.e. 18–37 s of pure latency at a
 * 1–2 ms RTT, before Postgres did any work at all.
 *
 * Counted through the same seam `bootstrap-scale.test.ts` uses for its pages: a
 * `Queryable` that tallies, handed straight to `registerCtx`. That is exactly
 * what the route builds, so this measures the route's cost without needing an
 * HTTP-level hook.
 *
 * If a change here makes a number GROW, the question to ask is which lookup went
 * back to being per-item.
 */

function countingDb(): { db: Pick<pg.Pool, "query">; count: () => number; reset: () => void } {
  let n = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { query: ((...args: any[]) => (n++, (pool.query as any)(...args))) as any },
    count: () => n,
    reset: () => {
      n = 0;
    },
  };
}

const NOTES = 200;

describe("registration batch query count", () => {
  let owner: TestUser;
  let org: string;
  let vault: string;

  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("BAALDA_DEPLOYMENT", "self-hosted");
    await resetDb();
    owner = await signUp("owner@scale-reg.test");
    org = (await createOrg(owner, "Reg Co", "reg-co")).id;
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
  });
  afterAll(async () => {
    await pool.end();
  });

  /**
   * 200 brand-new notes in ONE folder.
   *
   * 10 statements, and every one of them is named:
   *   1 — the adopt probe, prefilled for all 200 paths with `lower(rel_path) = ANY`
   *   1 — the parent-folder map, ditto for the one directory they name
   *   7 — `canCreateIn` on that folder (memoised per folder, as it always was)
   *   1 — the `INSERT … SELECT FROM unnest(…) ON CONFLICT (id) DO NOTHING`
   * The frozen-root latch adds none: nothing here resolves to the root.
   */
  it("registers 200 new notes in one folder in a constant 10 statements", async () => {
    await seedFolder(vault, null, "Docs", "Docs");
    const counter = countingDb();
    const ctx = registerCtx(vault, owner.userId, counter.db);
    const out = await registerNotes(
      ctx,
      Array.from({ length: NOTES }, (_, i) => ({
        relPath: `Docs/n${String(i).padStart(4, "0")}.md`,
        docId: randomUUID(),
        title: null,
      })),
    );
    expect(out.every((r) => r.status === "created")).toBe(true);
    expect(counter.count()).toBe(10);

    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
      [vault],
    );
    expect(rows[0].n).toBe(NOTES);
  });

  /**
   * The steady-state pass — every device re-registers every note it holds on
   * every reconcile, and that case must stay the cheapest of all: the adopt
   * probe answers all 200 from ONE read and nothing else runs.
   */
  it("re-registering 200 existing notes costs 2 statements", async () => {
    await seedFolder(vault, null, "Docs", "Docs");
    const inputs = Array.from({ length: NOTES }, (_, i) => ({
      relPath: `Docs/n${String(i).padStart(4, "0")}.md`,
      docId: randomUUID(),
      title: null,
    }));
    await registerNotes(registerCtx(vault, owner.userId, pool), inputs);

    const counter = countingDb();
    const again = await registerNotes(registerCtx(vault, owner.userId, counter.db), inputs);
    expect(again.every((r) => r.status === "adopted")).toBe(true);
    // 1 adopt probe + 1 parent-folder map. (The folder read is still made
    // because a batch does not know in advance that every item will adopt.)
    expect(counter.count()).toBe(2);
  });

  /** Spread across folders, the only term that grows is `canCreateIn`, and it
   *  grows per FOLDER — not per note. 20 folders, still one insert. */
  it("scales per folder, not per note: 200 notes across 20 folders", async () => {
    for (let f = 0; f < 20; f++) await seedFolder(vault, null, `F${f}`, `F${f}`);
    const counter = countingDb();
    const out = await registerNotes(
      registerCtx(vault, owner.userId, counter.db),
      Array.from({ length: NOTES }, (_, i) => ({
        relPath: `F${i % 20}/n${String(i).padStart(4, "0")}.md`,
        docId: randomUUID(),
        title: null,
      })),
    );
    expect(out.every((r) => r.status === "created")).toBe(true);
    // 105 = 1 adopt probe + 1 folder map + 1 insert + 102 for the write gate
    // (~5 per folder; the member role and the vault baseline are now memoised
    // for the whole request, down from ~7). Before this change the same call was
    // ~740 statements — 200 adopt probes + 200 parent lookups + 20×7 + 200
    // inserts — run serially on one connection. The number that matters is that
    // NOTHING here scales with the note count any more.
    expect(counter.count()).toBe(105);
  });
});
