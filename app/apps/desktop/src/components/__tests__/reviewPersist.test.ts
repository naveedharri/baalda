import { describe, expect, it } from "vitest";
import type { ReconcileItem } from "../../lib/sync/reconcileReport";
import {
  parseReview,
  prunePersisted,
  readPersisted,
  REVIEW_STORAGE_PREFIX,
  reviewKey,
  serializeReview,
  writePersisted,
} from "../reviewModel";

const S = "2026-09-26T10-00-00-000Z";
const copyA: ReconcileItem = { kind: "deletedByTeammate", docId: "d1", path: "a.md", detail: `.context/trash/${S}/a.md`, at: 1 };
const copyE: ReconcileItem = { kind: "externalEditSaved", path: "e.md", detail: `.context/trash/${S}/e.md`, at: 2 };
const restored: ReconcileItem = { kind: "restoredFromServer", docId: "d4", path: "d.md", detail: "restored", at: 3 };
const folder: ReconcileItem = { kind: "folderKept", path: "F", at: 4 };

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    kv: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

describe("review persistence", () => {
  it("round-trips reviewable items and their resolutions, dropping notices", () => {
    const { kv } = memory();
    const resolved = new Map([[reviewKey(copyE), "skipped" as const], ["stale", "kept" as const]]);
    writePersisted("/v", serializeReview([copyA, copyE, restored, folder], resolved), kv);
    const back = readPersisted("/v", kv)!;
    expect(back.items.map((i) => i.path)).toEqual(["a.md", "e.md", "d.md"]);
    expect(back.items[0]).toEqual(copyA);
    expect(back.resolved).toEqual([[reviewKey(copyE), "skipped"]]);
  });

  it("removes the key when nothing is left to save", () => {
    const { kv, m } = memory();
    writePersisted("/v", serializeReview([copyA], new Map()), kv);
    expect(m.has(REVIEW_STORAGE_PREFIX + "/v")).toBe(true);
    writePersisted("/v", serializeReview([folder], new Map()), kv);
    expect(m.has(REVIEW_STORAGE_PREFIX + "/v")).toBe(false);
  });

  it("seeds only pending items whose copy still exists", () => {
    const p = serializeReview([copyA, copyE, restored], new Map([[reviewKey(copyA), "kept" as const]]));
    // a.md resolved, e.md's copy deleted outside the app, d.md has no copy.
    expect(prunePersisted(p, new Set()).map((i) => i.path)).toEqual(["d.md"]);
    expect(prunePersisted(p, new Set([`${S}/e.md`])).map((i) => i.path)).toEqual(["e.md", "d.md"]);
    // Copy check unavailable: nothing is pruned for a missing copy.
    expect(prunePersisted(p, null).map((i) => i.path)).toEqual(["e.md", "d.md"]);
  });

  it("parses malformed storage to null or drops bad entries, never throws", () => {
    expect(parseReview(null)).toBeNull();
    expect(parseReview("{not json")).toBeNull();
    expect(parseReview("42")).toBeNull();
    const out = parseReview(JSON.stringify({
      items: [copyA, { kind: "bogus", path: "x" }, { kind: "folderKept" }, null],
      resolved: [["k", "kept"], ["k2", "nope"], "x"],
    }))!;
    expect(out.items).toEqual([copyA]);
    expect(out.resolved).toEqual([["k", "kept"]]);
  });

  it("survives a storage that throws", () => {
    const bad = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readPersisted("/v", bad)).toBeNull();
    expect(() => writePersisted("/v", serializeReview([copyA], new Map()), bad)).not.toThrow();
  });
});
