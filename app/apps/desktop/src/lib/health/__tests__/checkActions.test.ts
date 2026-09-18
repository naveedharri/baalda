// The Health page's heal / bulk actions: what each one plans to touch, what it
// refuses, and what it reports afterwards.
//
// Every dep is injected, so the whole execution loop runs here in Node — no
// Tauri host, no store, no vault. That is the point of `CheckActionDeps`: the
// thing that deletes twelve notes at once should be provable without twelve
// notes.

import { describe, expect, it, vi } from "vitest";
import { CHECK_BY_ID, checkRows } from "../checks";
import {
  checkActionPlans,
  isCreatableTarget,
  legalSegment,
  outcomeSummary,
  planCheckAction,
  runCheckAction,
  suggestLegalPath,
  uniqueName,
  wikilinkTargets,
  type CheckActionDeps,
  type CheckActionPlan,
} from "../checkActions";
import type { VaultCheckId, VaultCheckItem, VaultCheckResult } from "../types";

function result(
  id: VaultCheckId,
  items: VaultCheckItem[],
  count = items.length,
): VaultCheckResult {
  return { id, count, items };
}

function plan(id: VaultCheckId, items: VaultCheckItem[], count?: number): CheckActionPlan {
  const def = CHECK_BY_ID.get(id)!;
  const action = def.heal ?? def.bulkActions![0]!;
  return planCheckAction(def, result(id, items, count), action, def.heal ? "heal" : "bulk")!;
}

/** Deps that record what they were asked to do and succeed at all of it. */
function deps(over: Partial<CheckActionDeps> = {}): CheckActionDeps {
  return {
    deleteNotes: vi.fn(async (paths: string[]) => ({ deleted: paths, failed: [] })),
    resetHistory: vi.fn(async () => ({ bytesFreed: 1024 })),
    reclaim: vi.fn(async () => ({ docsRemoved: 3, bytesReclaimed: 2048 })),
    emptyTrash: vi.fn(async () => ({ filesRemoved: 7, bytesFreed: 4096 })),
    rebuildIndex: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    pickFolder: vi.fn(async () => "/tmp/out"),
    exportTo: vi.fn(async () => {}),
    readNote: vi.fn(async () => ""),
    resolveLink: vi.fn(async () => true),
    createNote: vi.fn(async (dir: string, name: string) => (dir ? `${dir}/${name}.md` : `${name}.md`)),
    isFile: vi.fn(async () => true),
    rename: vi.fn(async () => {}),
    ...over,
  };
}

// ── Planning ──────────────────────────────────────────────────────────────────

describe("checkActionPlans", () => {
  it("offers nothing for a passing check", () => {
    const rows = checkRows(null);
    for (const row of rows) expect(checkActionPlans(row)).toEqual([]);
  });

  it("puts the heal first and the bulk actions after it", () => {
    const rows = checkRows({
      computedAt: 1,
      results: [result("unindexed-markdown", [{ path: "a.md" }])],
    });
    const row = rows.find((r) => r.def.id === "unindexed-markdown")!;
    const plans = checkActionPlans(row);
    expect(plans.map((p) => p.action)).toEqual(["rebuild-index", "sync-now"]);
    expect(plans[0]!.kind).toBe("heal");
    expect(plans[1]!.kind).toBe("bulk");
  });

  it("names the true count in a destructive confirm", () => {
    const p = plan("empty-notes", [{ path: "a.md" }, { path: "b.md" }]);
    expect(p.action).toBe("delete-all");
    expect(p.confirm?.title).toBe("Delete 2 empty notes?");
    expect(p.confirm?.tone).toBe("danger");
  });

  it("counts what it cannot reach rather than pretending it will", () => {
    const p = plan(
      "empty-notes",
      Array.from({ length: 25 }, (_, i) => ({ path: `n${i}.md` })),
      400,
    );
    expect(p.targets).toHaveLength(25);
    expect(p.unlisted).toBe(375);
  });

  it("skips a heavy-history row with no doc id instead of failing on it", () => {
    const def = CHECK_BY_ID.get("heavy-history")!;
    const p = planCheckAction(
      def,
      result("heavy-history", [
        { path: "a.md", docId: "doc-a" },
        { path: "b.md", docId: null },
      ]),
      "reset-history-all",
      "heal",
    )!;
    expect(p.targets.map((t) => t.path)).toEqual(["a.md"]);
    expect(p.skipped[0]!.path).toBe("b.md");
    expect(p.confirm?.title).toBe("Reset the history of 1 notes?");
  });

  it("offers no button at all when every listed item is out of reach", () => {
    const def = CHECK_BY_ID.get("illegal-names")!;
    // A folder's own name is the problem — the heal never renames folders.
    const p = planCheckAction(
      def,
      result("illegal-names", [{ path: "Bad:Folder/fine.md" }]),
      "rename-legal",
      "heal",
    );
    expect(p).toBeNull();
  });

  it("ignores the item list for a whole-vault action", () => {
    const def = CHECK_BY_ID.get("orphan-history")!;
    const p = planCheckAction(def, result("orphan-history", [], 18), "reclaim", "heal")!;
    expect(p.wholeVault).toBe(true);
    expect(p.targets).toEqual([]);
    expect(p.unlisted).toBe(0);
    expect(p.confirm).toBeNull();
  });
});

// ── Legal names ───────────────────────────────────────────────────────────────

describe("legal names", () => {
  it("replaces exactly what Windows refuses", () => {
    expect(legalSegment('a<b>c:d"e|f?g*h.md')).toBe("a-b-c-d-e-f-g-h.md");
    expect(legalSegment("trailing dot.")).toBe("trailing dot");
    expect(legalSegment("trailing space ")).toBe("trailing space");
    expect(legalSegment("CON.md")).toBe("_CON.md");
    expect(legalSegment("nul")).toBe("_nul");
    expect(legalSegment("perfectly fine.md")).toBe("perfectly fine.md");
  });

  it("only renames the file, never a folder above it", () => {
    expect(suggestLegalPath("Notes/what?.md")).toBe("Notes/what-.md");
    expect(suggestLegalPath("No:tes/fine.md")).toBeNull();
    expect(suggestLegalPath("Notes/fine.md")).toBeNull();
    expect(suggestLegalPath("...")).toBeNull();
  });
});

// ── Wikilinks ─────────────────────────────────────────────────────────────────

describe("wikilink targets", () => {
  it("strips the alias and the heading and de-duplicates", () => {
    expect(
      wikilinkTargets("see [[A|an a]] and [[A#top]] and [[B/C]] and [[A]]"),
    ).toEqual(["A", "B/C"]);
  });

  it("creates notes, never files or links out of the vault", () => {
    expect(isCreatableTarget("Meeting notes")).toBe(true);
    expect(isCreatableTarget("Projects/Q3")).toBe(true);
    expect(isCreatableTarget("plan.md")).toBe(true);
    expect(isCreatableTarget("diagram.png")).toBe(false);
    expect(isCreatableTarget("report.pdf")).toBe(false);
    expect(isCreatableTarget("../escape")).toBe(false);
    expect(isCreatableTarget("/absolute")).toBe(false);
    expect(isCreatableTarget("https://example.com")).toBe(false);
  });
});

describe("uniqueName", () => {
  it("never lets two exports collide in one folder", () => {
    const used = new Set<string>();
    expect(uniqueName("index.md", used)).toBe("index.md");
    expect(uniqueName("index.md", used)).toBe("index 2.md");
    expect(uniqueName("index.md", used)).toBe("index 3.md");
    expect(uniqueName("README", used)).toBe("README");
  });
});

// ── Running ───────────────────────────────────────────────────────────────────

describe("runCheckAction", () => {
  it("deletes every listed item through the sidebar's own delete", async () => {
    const d = deps();
    const p = plan("empty-notes", [{ path: "a.md" }, { path: "b.md" }]);
    const out = await runCheckAction(p, d);
    expect(d.deleteNotes).toHaveBeenCalledWith(["a.md", "b.md"], undefined);
    expect(out.done).toBe(2);
    expect(out.total).toBe(2);
    expect(outcomeSummary(out, p)).toBe("Deleted 2 of 2");
  });

  it("reports a partial delete instead of claiming all of it", async () => {
    const d = deps({
      deleteNotes: vi.fn(async () => ({
        deleted: ["a.md"],
        failed: [{ path: "b.md", reason: "no permission" }],
      })),
    });
    const p = plan("empty-notes", [{ path: "a.md" }, { path: "b.md" }]);
    const out = await runCheckAction(p, d);
    expect(out.done).toBe(1);
    expect(out.errors).toEqual([{ path: "b.md", reason: "no permission" }]);
    expect(outcomeSummary(out, p)).toBe("Deleted 1 of 2 · 1 failed");
  });

  it("does nothing at all when the export folder picker is cancelled", async () => {
    const d = deps({ pickFolder: vi.fn(async () => null) });
    const def = CHECK_BY_ID.get("oversized-notes")!;
    const p = planCheckAction(
      def,
      result("oversized-notes", [{ path: "big.md" }]),
      "export-all",
      "bulk",
    )!;
    const out = await runCheckAction(p, d);
    expect(out.cancelled).toBe(true);
    expect(d.exportTo).not.toHaveBeenCalled();
    expect(outcomeSummary(out, p)).toBe("Cancelled — nothing changed");
  });

  it("exports every copy into the chosen folder without overwriting one", async () => {
    const d = deps();
    const def = CHECK_BY_ID.get("oversized-notes")!;
    const p = planCheckAction(
      def,
      result("oversized-notes", [{ path: "a/big.md" }, { path: "b/big.md" }]),
      "export-all",
      "bulk",
    )!;
    const out = await runCheckAction(p, d);
    expect(d.exportTo).toHaveBeenNthCalledWith(1, "a/big.md", "/tmp/out/big.md");
    expect(d.exportTo).toHaveBeenNthCalledWith(2, "b/big.md", "/tmp/out/big 2.md");
    expect(out.done).toBe(2);
  });

  it("resets the history of every listed doc and sums what it freed", async () => {
    const d = deps();
    const p = plan("heavy-history", [
      { path: "a.md", docId: "doc-a" },
      { path: "b.md", docId: "doc-b" },
    ]);
    const out = await runCheckAction(p, d);
    expect(d.resetHistory).toHaveBeenCalledTimes(2);
    expect(out.done).toBe(2);
    expect(out.note).toBe("2 KB freed");
  });

  it("creates only the link targets that resolve to nothing, once each", async () => {
    const d = deps({
      readNote: vi.fn(async (path: string) =>
        path === "one.md" ? "[[Missing]] [[Here]] [[Missing]]" : "[[Missing]] [[shot.png]]",
      ),
      resolveLink: vi.fn(async (t: string) => t === "Here"),
    });
    const p = plan("broken-links", [{ path: "one.md" }, { path: "two.md" }]);
    const out = await runCheckAction(p, d);
    expect(d.createNote).toHaveBeenCalledTimes(1);
    expect(d.createNote).toHaveBeenCalledWith("", "Missing");
    expect(out.done).toBe(1);
    expect(out.total).toBe(1);
    // The embed is left to the missing-embeds check, and says so.
    expect(out.skipped.map((s) => s.path)).toEqual(["shot.png"]);
  });

  it("creates a link target inside the folder it names", async () => {
    const d = deps({
      readNote: vi.fn(async () => "[[Projects/Q3 plan]]"),
      resolveLink: vi.fn(async () => false),
    });
    const p = plan("broken-links", [{ path: "one.md" }]);
    await runCheckAction(p, d);
    expect(d.createNote).toHaveBeenCalledWith("Projects", "Q3 plan");
  });

  it("keeps going when one source note cannot be read", async () => {
    const d = deps({
      readNote: vi.fn(async (path: string) => {
        if (path === "bad.md") throw new Error("not valid UTF-8");
        return "[[Missing]]";
      }),
      resolveLink: vi.fn(async () => false),
    });
    const p = plan("broken-links", [{ path: "bad.md" }, { path: "good.md" }]);
    const out = await runCheckAction(p, d);
    expect(out.errors[0]).toEqual({ path: "bad.md", reason: "not valid UTF-8" });
    expect(out.done).toBe(1);
  });

  it("renames an illegal FILE name and leaves a folder and a taken name alone", async () => {
    // `what-.md` is free (nothing to collide with); `Bad:Folder` is a folder,
    // which `isFile` is the only signal we have for.
    const d = deps({ isFile: vi.fn(async (path: string) => path === "what?.md") });
    const def = CHECK_BY_ID.get("illegal-names")!;
    const p = planCheckAction(
      def,
      result("illegal-names", [{ path: "what?.md" }, { path: "Bad:Folder" }]),
      "rename-legal",
      "heal",
    )!;
    const out = await runCheckAction(p, d);
    expect(d.rename).toHaveBeenCalledTimes(1);
    expect(d.rename).toHaveBeenCalledWith("what?.md", "what-.md");
    expect(out.done).toBe(1);
    expect(out.skipped.map((s) => s.reason)).toContain(
      "this is a folder — rename it in the sidebar",
    );
  });

  it("refuses to rename onto a name that is taken", async () => {
    const d = deps({ isFile: vi.fn(async () => true) });
    const def = CHECK_BY_ID.get("illegal-names")!;
    const p = planCheckAction(
      def,
      result("illegal-names", [{ path: "what?.md" }]),
      "rename-legal",
      "heal",
    )!;
    const out = await runCheckAction(p, d);
    expect(d.rename).not.toHaveBeenCalled();
    expect(out.done).toBe(0);
    expect(out.skipped[0]!.reason).toContain("is taken");
  });

  it("reports the whole-vault actions by what they freed, not by a count", async () => {
    const d = deps();
    const reclaim = planCheckAction(
      CHECK_BY_ID.get("orphan-history")!,
      result("orphan-history", [], 3),
      "reclaim",
      "heal",
    )!;
    const out = await runCheckAction(reclaim, d);
    expect(out.done).toBe(3);
    expect(outcomeSummary(out, reclaim)).toBe("Reclaimed 3 · 2 KB freed");

    const trash = planCheckAction(
      CHECK_BY_ID.get("trash")!,
      result("trash", [], 7),
      "empty-trash",
      "bulk",
    )!;
    expect(outcomeSummary(await runCheckAction(trash, d), trash)).toBe(
      "Removed 7 · 4 KB freed",
    );
  });

  it("says a rebuild failed rather than reporting a silent zero", async () => {
    const d = deps({
      rebuildIndex: vi.fn(async () => {
        throw new Error("index is locked");
      }),
    });
    const p = plan("stale-index", [{ path: "a.md", docId: "doc-a" }]);
    const out = await runCheckAction(p, d);
    expect(out.done).toBe(0);
    expect(out.errors[0]!.reason).toBe("index is locked");
    expect(outcomeSummary(out, p)).toBe("Rebuild index failed");
  });

  it("reports progress as it goes", async () => {
    const seen: Array<[number, number]> = [];
    const d = deps();
    const p = plan("heavy-history", [
      { path: "a.md", docId: "doc-a" },
      { path: "b.md", docId: "doc-b" },
    ]);
    await runCheckAction(p, d, (done, total) => seen.push([done, total]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
