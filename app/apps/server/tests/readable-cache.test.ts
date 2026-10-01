import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The display-only readable-set cache (#261). The listing itself is mocked, so
// this needs no database: what is under test is when a cached set is served
// and when it must be rebuilt.
const calls: Array<{ kind: string; userId: string; vaultId: string }> = [];
let answer = new Set<string>(["A"]);

vi.mock("../src/permissions/vault-docs.js", () => ({
  listReadableDocsInVault: async (userId: string, vaultId: string) => {
    calls.push({ kind: "live", userId, vaultId });
    return new Set(answer);
  },
  listDeletedReadableDocsInVault: async (userId: string, vaultId: string) => {
    calls.push({ kind: "deleted", userId, vaultId });
    return new Set(answer);
  },
}));

const cache = await import("../src/permissions/readable-cache.js");
const db = {} as never;

beforeEach(() => {
  calls.length = 0;
  answer = new Set(["A"]);
  cache.clearReadableCache();
  cache.setReadableCacheTtl(cache.READABLE_CACHE_TTL_MS);
});

afterEach(() => cache.setReadableCacheTtl(0));

describe("readable-cache", () => {
  it("serves a repeat ask inside the TTL from memory", async () => {
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    await cache.readableDocsForActivity("u1", "v1", db, 2_000);
    expect(calls).toHaveLength(1);
  });

  it("rebuilds once the TTL has passed", async () => {
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    await cache.readableDocsForActivity("u1", "v1", db, 1_000 + cache.READABLE_CACHE_TTL_MS);
    expect(calls).toHaveLength(2);
  });

  it("keys by user, vault and kind", async () => {
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    await cache.readableDocsForActivity("u2", "v1", db, 1_000);
    await cache.readableDocsForActivity("u1", "v2", db, 1_000);
    await cache.deletedReadableDocsForActivity("u1", "v1", db, 1_000);
    expect(calls).toHaveLength(4);
  });

  it("an ACL / registry change drops the vault's sets at once", async () => {
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    await cache.readableDocsForActivity("u1", "v2", db, 1_000);
    answer = new Set(); // access revoked
    cache.invalidateReadableCache("v1");
    expect(await cache.readableDocsForActivity("u1", "v1", db, 1_001)).toEqual(new Set());
    // Another vault's entry is untouched.
    await cache.readableDocsForActivity("u1", "v2", db, 1_001);
    expect(calls.filter((c) => c.vaultId === "v2")).toHaveLength(1);
  });

  it("a build that started before an invalidation is not served after it", async () => {
    const first = cache.readableDocsForActivity("u1", "v1", db, 1_000);
    cache.invalidateReadableCache("v1");
    await first;
    await cache.readableDocsForActivity("u1", "v1", db, 1_001);
    expect(calls).toHaveLength(2);
  });

  it("TTL 0 disables caching entirely", async () => {
    cache.setReadableCacheTtl(0);
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    await cache.readableDocsForActivity("u1", "v1", db, 1_000);
    expect(calls).toHaveLength(2);
  });
});
