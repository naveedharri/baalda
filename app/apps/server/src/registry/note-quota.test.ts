// SPDX-License-Identifier: Apache-2.0
// Isolated registration tests, all I/O mocked.
import { beforeEach, expect, it, vi } from "vitest";
import { registerCtx, registerNotes } from "./batch-ops.js";
const state = vi.hoisted(() => ({ remaining: 1 as number | null, existing: false, query: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: { query: state.query } }));
vi.mock("../billing/note-quota.js", () => ({ NOTE_LIMIT_MESSAGE: "Upgrade to sync more notes", withNoteQuota: async (_v: unknown, db: unknown, work: Function) => work(db, state.remaining) }));
vi.mock("../permissions/http-gates.js", () => ({ canCreateIn: async () => true, canEditDoc: async () => true }));
vi.mock("../permissions/resolver.js", () => ({ createResolverCache: () => ({}) }));
beforeEach(() => {
  vi.resetAllMocks(); state.remaining = 1; state.existing = false;
  state.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("SELECT DISTINCT ON") && state.existing) return { rows: [{ id: "a", rel_path: "A.md", title: "A", folder_id: null }] };
    if (sql.includes("INSERT INTO notes")) return { rows: (args[0] as string[]).map(id => ({ id })) };
    return { rows: [] };
  });
});
it("admits the 20,000th note and reports a quota error for the rest of a batch", async () => {
  const result = await registerNotes(registerCtx("vault", "user"), [{ docId: "a", relPath: "A.md" }, { docId: "b", relPath: "B.md" }]);
  expect(result[0].status).toBe("created"); expect(result[1]).toMatchObject({ status: "error", code: "note_limit_reached" });
});
it("continues adopting existing paths when a vault is at or over the limit", async () => {
  state.remaining = 0; state.existing = true;
  const result = await registerNotes(registerCtx("vault", "user"), [{ docId: "different", relPath: "A.md" }]);
  expect(result[0]).toMatchObject({ status: "adopted", row: { id: "a" } });
  expect(state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO notes"))).toBe(false);
});
