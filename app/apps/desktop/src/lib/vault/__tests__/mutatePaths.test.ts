import { describe, expect, it, vi } from "vitest";
import { deletePaths } from "../mutatePaths";

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
