import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, REGISTRY_LISTING_TIMEOUT_MS } from "../api";

/**
 * Every registry pull is serialized behind the one before it, so a listing that
 * never answers used to park every later pull forever: new local notes stopped
 * registering while edits to existing ones (their own sockets) kept syncing.
 * The listings now abort, and the abort covers a body that stalls after the
 * headers, not only a server that never answers at all.
 */

/** Headers arrive at once (or never); the body never finishes unless aborted. */
function stallingFetch(stage: "headers" | "body") {
  const seen: Array<AbortSignal | undefined> = [];
  const impl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    seen.push(signal);
    const hang = () =>
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    if (stage === "headers") return hang();
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: hang,
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registry listing timeout", () => {
  for (const stage of ["headers", "body"] as const) {
    it(`aborts the note listing when the ${stage} stall`, async () => {
      vi.useFakeTimers();
      const f = stallingFetch(stage);
      const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: f.impl });
      const p = api.listNoteRegistryPaged("v1", { limit: 10 });
      const settled = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(REGISTRY_LISTING_TIMEOUT_MS + 1);
      await settled;
      expect(f.seen[0]).toBeDefined();
    });

    it(`aborts the folder listing when the ${stage} stall`, async () => {
      vi.useFakeTimers();
      const f = stallingFetch(stage);
      const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: f.impl });
      const p = api.listFolderRegistry("v1");
      const settled = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(REGISTRY_LISTING_TIMEOUT_MS + 1);
      await settled;
      expect(f.seen[0]).toBeDefined();
    });
  }

  it("does not abort a listing that answers in time", async () => {
    vi.useFakeTimers();
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ notes: [], tombstones: [] }),
      }) as unknown as Response) as unknown as typeof fetch;
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    await expect(api.listNoteRegistryPaged("v1")).resolves.toEqual({ notes: [], tombstones: [] });
  });
});
