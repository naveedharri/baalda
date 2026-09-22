import { describe, expect, it, vi } from "vitest";
import { deletePaths, type UnregisterOutcome } from "../mutatePaths";
import { BULK_THRESHOLD_DOCS } from "../../sync/pool";

/**
 * The sidebar had two hand-copied delete paths. The single-item one told the
 * server; the multi-select one didn't — so the rows survived and the next registry
 * pull materialized every deleted note back as an empty file. These tests pin the
 * ordering rule that makes that unrepeatable.
 */

type Deps = Parameters<typeof deletePaths>[1];

function deps(over: Partial<Deps> = {}) {
  const deleteDisk = vi.fn<Deps["deleteDisk"]>(async () => {});
  const unregister = vi.fn<Deps["unregister"]>(async () => {});
  return {
    deleteDisk,
    unregister,
    all: { epoch: 7, deleteDisk, unregister, ...over } as Deps,
  };
}

describe("deletePaths", () => {
  it("deletes deepest paths first, so a folder's children go before the folder", async () => {
    const order: string[] = [];
    const d = deps({
      deleteDisk: vi.fn(async (p: string) => {
        order.push(p);
      }),
    });
    await deletePaths(["A", "A/B/deep.md", "A/B"], d.all);
    expect(order).toEqual(["A/B/deep.md", "A/B", "A"]);
  });

  it("tells the server about every deleted path", async () => {
    // The actual bug: without this the note comes back as an empty file.
    const d = deps();
    const res = await deletePaths(["a.md", "b.md"], d.all);
    expect(d.unregister.mock.calls.map((c) => c[0]).sort()).toEqual(["a.md", "b.md"]);
    expect(res.deleted.sort()).toEqual(["a.md", "b.md"]);
  });

  it("unregisters BEFORE touching disk (server-first is the self-healing order)", async () => {
    const order: string[] = [];
    const d = deps({
      unregister: vi.fn(async (p: string) => {
        order.push(`server:${p}`);
      }),
      deleteDisk: vi.fn(async (p: string) => {
        order.push(`disk:${p}`);
      }),
    });
    await deletePaths(["a.md"], d.all);
    expect(order).toEqual(["server:a.md", "disk:a.md"]);
  });

  it("does NOT delete locally when the server call fails", async () => {
    // A live server row plus a deleted local file is the reappearing-ghost bug:
    // the next pull materializes the "deleted" item back. If the server refused
    // (offline, or no permission), nothing may happen anywhere — and the user is
    // told, instead of watching their delete silently not count.
    const d = deps({
      unregister: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const res = await deletePaths(["a.md"], d.all);
    expect(d.deleteDisk).not.toHaveBeenCalled();
    expect(res.deleted).toEqual([]);
    expect(res.failed).toEqual([{ path: "a.md", reason: "offline" }]);
  });

  it("reports a disk failure after a successful unregister", async () => {
    // The server side is tombstoned, so the next inbound pull cleans the file
    // up — but the caller still hears that this path isn't done.
    const d = deps({
      deleteDisk: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });
    const res = await deletePaths(["a.md"], d.all);
    expect(d.unregister).toHaveBeenCalledWith("a.md");
    expect(res.deleted).toEqual([]);
    expect(res.failed).toEqual([{ path: "a.md", reason: "permission denied" }]);
  });

  it("passes the pinned epoch to every disk call", async () => {
    // An unpinned delete that lands after a vault switch destroys a same-named
    // file in a vault the user wasn't even looking at.
    const d = deps();
    await deletePaths(["a.md", "b.md"], d.all);
    for (const call of d.deleteDisk.mock.calls) expect(call[1]).toBe(7);
  });

  it("reports progress once per path", async () => {
    const onProgress = vi.fn();
    const d = deps({ onProgress });
    await deletePaths(["a.md", "b.md", "c.md"], d.all);
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

/**
 * A big selection takes the BATCHED server call — one request per 200 notes
 * instead of one per note — and nothing else about the operation changes: still
 * server-first per path, still deepest-level-first on disk, still a refusal that
 * leaves that one file exactly where it is.
 */
describe("deletePaths — bulk selections", () => {
  /** `n` note paths, plus whatever folders a test names. */
  const notes = (n: number) => Array.from({ length: n }, (_, i) => `N${i}.md`);

  function bulkDeps(over: Partial<Deps> = {}) {
    const deleteDisk = vi.fn<Deps["deleteDisk"]>(async () => {});
    const unregister = vi.fn<Deps["unregister"]>(async () => {});
    const unregisterMany = vi.fn(
      async (paths: string[]): Promise<UnregisterOutcome[]> =>
        paths.map((path) => ({ path, ok: true, reason: null })),
    );
    return {
      deleteDisk,
      unregister,
      unregisterMany,
      all: { epoch: 7, deleteDisk, unregister, unregisterMany, ...over } as Deps,
    };
  }

  it("sends 30 selected notes as ONE batch and never the per-path call", async () => {
    const d = bulkDeps();
    const paths = notes(30);
    const res = await deletePaths(paths, d.all);

    expect(d.unregisterMany).toHaveBeenCalledTimes(1);
    expect((d.unregisterMany.mock.calls[0][0] as string[]).sort()).toEqual([...paths].sort());
    expect(d.unregister).not.toHaveBeenCalled();
    expect(res.deleted.sort()).toEqual([...paths].sort());
    expect(d.deleteDisk).toHaveBeenCalledTimes(30);
  });

  it("keeps the per-path call just below the threshold", async () => {
    const d = bulkDeps();
    await deletePaths(notes(BULK_THRESHOLD_DOCS - 1), d.all);

    expect(d.unregisterMany).not.toHaveBeenCalled();
    expect(d.unregister).toHaveBeenCalledTimes(BULK_THRESHOLD_DOCS - 1);
  });

  it("hands folders and notes to the SAME call — the registry keeps folders single", async () => {
    // `registry.deletePaths` leaves a folder on its one cascading request and
    // batches only the notes, so this layer must not split the selection itself.
    const d = bulkDeps();
    const paths = ["Archive", ...notes(30).map((n) => `Archive/${n}`)];
    const res = await deletePaths(paths, d.all);

    const sent = d.unregisterMany.mock.calls[0][0] as string[];
    expect(sent).toHaveLength(31);
    expect(sent).toContain("Archive");
    // Deepest FIRST, so the folder is the last thing either side hears about.
    expect(sent[sent.length - 1]).toBe("Archive");
    expect(res.deleted).toHaveLength(31);
  });

  it("removes disk paths deepest-LEVEL first, so a folder outlives its children", async () => {
    const order: string[] = [];
    const d = bulkDeps({
      deleteDisk: vi.fn(async (p: string) => {
        order.push(p);
      }),
    });
    await deletePaths(["A", ...notes(30).map((n) => `A/${n}`)], d.all);

    expect(order).toHaveLength(31);
    expect(order[order.length - 1]).toBe("A");
    expect(order.slice(0, 30).every((p) => p.startsWith("A/"))).toBe(true);
  });

  it("leaves the file of a path the server refused, and reports it", async () => {
    const d = bulkDeps({
      unregisterMany: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({
          path,
          ok: path !== "N3.md",
          reason: path === "N3.md" ? "no edit grant" : null,
        })),
      ),
    });
    const res = await deletePaths(notes(30), d.all);

    expect(res.failed).toEqual([{ path: "N3.md", reason: "no edit grant" }]);
    expect(res.deleted).toHaveLength(29);
    expect(d.deleteDisk.mock.calls.map((c) => c[0])).not.toContain("N3.md");
  });

  it("touches no disk at all when the batch itself fails", async () => {
    // Offline mid-request: every row is still live, so every local delete would
    // only produce the reappearing ghost.
    const d = bulkDeps({
      unregisterMany: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const res = await deletePaths(notes(30), d.all);

    expect(d.deleteDisk).not.toHaveBeenCalled();
    expect(res.deleted).toEqual([]);
    expect(res.failed).toHaveLength(30);
    expect(res.failed[0].reason).toBe("offline");
  });

  it("treats an UNANSWERED path as a refusal, never as a delete", async () => {
    const d = bulkDeps({
      unregisterMany: vi.fn(async (paths: string[]) =>
        paths.filter((p) => p !== "N7.md").map((path) => ({ path, ok: true, reason: null })),
      ),
    });
    const res = await deletePaths(notes(30), d.all);

    expect(res.failed.map((f) => f.path)).toEqual(["N7.md"]);
    expect(d.deleteDisk.mock.calls.map((c) => c[0])).not.toContain("N7.md");
  });

  it("reports a disk failure after a successful batch unregister", async () => {
    const d = bulkDeps({
      deleteDisk: vi.fn(async (p: string) => {
        if (p === "N1.md") throw new Error("permission denied");
      }),
    });
    const res = await deletePaths(notes(30), d.all);

    expect(res.failed).toEqual([{ path: "N1.md", reason: "permission denied" }]);
    expect(res.deleted).toHaveLength(29);
  });

  it("still pins the epoch and still counts progress once per path", async () => {
    const onProgress = vi.fn();
    const d = bulkDeps({ onProgress });
    await deletePaths(notes(30), d.all);

    for (const call of d.deleteDisk.mock.calls) expect(call[1]).toBe(7);
    expect(onProgress).toHaveBeenCalledTimes(30);
    expect(onProgress.mock.calls[29]).toEqual([30, 30]);
  });
});
