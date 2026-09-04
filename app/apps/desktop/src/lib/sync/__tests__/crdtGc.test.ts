// CRDT garbage collection — the allow-list is the whole safety argument.
//
// These tests exist because the failure mode of getting this wrong is not a bug
// report, it is a user's unsynced edits being deleted. Every case here is about
// what must SURVIVE a sweep, not what gets removed.

import { describe, expect, it, vi } from "vitest";
import { collectCrdtGarbage } from "../crdtGc";

const report = { docsRemoved: 0, updatesRemoved: 0, bytesReclaimed: 0 };

describe("collectCrdtGarbage", () => {
  it("passes the union of BOTH live id spaces", async () => {
    // A local CRDT can be keyed by the registry's server docId or by the local
    // index's notes.id. They are the same value in a vault registered from a
    // fresh index and diverge in one whose index predates its registration —
    // where the doc is keyed by whichever id opened the note first. Sending one
    // space and not the other deletes live docs.
    const prune = vi.fn().mockResolvedValue(report);
    await collectCrdtGarbage({
      registryDocIds: () => ["server-1", "shared"],
      localNotes: async () => [{ id: "local-1" }, { id: "shared" }],
      prune,
    });
    expect(prune).toHaveBeenCalledTimes(1);
    expect([...prune.mock.calls[0][0]].sort()).toEqual(["local-1", "server-1", "shared"]);
  });

  it("includes pinned ids that are in neither space yet", async () => {
    const prune = vi.fn().mockResolvedValue(report);
    await collectCrdtGarbage(
      { registryDocIds: () => ["a"], localNotes: async () => [], prune },
      { pinned: ["open-note"] },
    );
    expect([...prune.mock.calls[0][0]].sort()).toEqual(["a", "open-note"]);
  });

  it("REFUSES to prune when nothing is known to be live", async () => {
    // "I know of no live docs" is what a caller looks like when its map failed
    // to load, not a request to erase the vault's CRDT.
    const prune = vi.fn().mockResolvedValue(report);
    const out = await collectCrdtGarbage({
      registryDocIds: () => [],
      localNotes: async () => [],
      prune,
    });
    expect(prune).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it("never throws — a vault that cannot be tidied must still open", async () => {
    const out = await collectCrdtGarbage({
      registryDocIds: () => ["a"],
      localNotes: async () => {
        throw new Error("index unavailable");
      },
      prune: vi.fn(),
    });
    expect(out).toBeNull();
  });

  it("does not prune when the live set could not be completed", async () => {
    // A failed localNotes read must abort the sweep, not fall through to a
    // prune against the registry ids alone — every local-only doc would go.
    const prune = vi.fn().mockResolvedValue(report);
    await collectCrdtGarbage({
      registryDocIds: () => ["a"],
      localNotes: async () => {
        throw new Error("index unavailable");
      },
      prune,
    });
    expect(prune).not.toHaveBeenCalled();
  });
});
