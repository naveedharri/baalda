// SPDX-License-Identifier: Apache-2.0
// Isolated tests: no database connections.
import { beforeEach, expect, it, vi } from "vitest";
import { withNoteQuota } from "./note-quota.js";
const state = vi.hoisted(() => ({ enabled: true, paid: false, count: 19999, query: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("../deployment-policy.js", () => ({ requiresCloudPlan: () => state.enabled }));
vi.mock("./entitlements.js", () => ({ orgHasActiveSubscription: async () => state.paid }));
vi.mock("../db/pool.js", () => ({ pool: { connect: state.connect } }));
beforeEach(() => {
  vi.resetAllMocks(); state.enabled = true; state.paid = false; state.count = 19999;
  state.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("organization_id") ? [{ organization_id: "org" }] : sql.includes("count(*)") ? [{ count: state.count }] : [] }));
  state.connect.mockResolvedValue({ query: state.query, release: state.release });
});
it.each([[19999, 1], [20000, 0], [21000, 0]])("limits %i live notes to %i new registrations", async (count, remaining) => {
  state.count = count;
  expect(await withNoteQuota("vault", { query: vi.fn() }, async (_, available) => available)).toBe(remaining);
  expect(state.query.mock.calls[0][0]).toContain("pg_advisory_lock");
  expect(state.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  expect(state.release).toHaveBeenCalledOnce();
});
it("does not limit paid vaults or self-hosted deployments", async () => {
  state.paid = true;
  expect(await withNoteQuota("v", { query: vi.fn() }, async (_, available) => available)).toBeNull();
  state.connect.mockClear(); state.enabled = false;
  expect(await withNoteQuota("v", { query: vi.fn() }, async (_, available) => available)).toBeNull();
  expect(state.connect).not.toHaveBeenCalled();
});
it("releases a locked connection when registration fails", async () => {
  await expect(withNoteQuota("v", { query: vi.fn() }, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(state.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  expect(state.release).toHaveBeenCalledOnce();
});
