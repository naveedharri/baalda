import { describe, expect, it } from "vitest";
import {
  buildTreeSyncIndex,
  folderSyncTitle,
  rowSyncMark,
  type TreeSyncIndex,
} from "../syncRollup";
import type { DocSyncState } from "../sync/vaultScope";

// The sidebar sync indicator is a promise to the user: a column of quiet dots
// means "everything is on the server". These tests exist because that promise is
// only worth anything if it can never be made falsely — every case below is a way
// the roll-up could have lied.

const dir = (path: string) => ({ path, isDir: true });
const file = (path: string) => ({ path, isDir: false });

/** Build an index from a compact {relPath: state} description. */
function indexOf(
  notes: Record<string, DocSyncState>,
  extraLocal: string[] = [],
): TreeSyncIndex {
  const docIdByPath: Record<string, string> = {};
  const docSyncState: Record<string, DocSyncState> = {};
  let n = 0;
  for (const [relPath, state] of Object.entries(notes)) {
    const docId = `doc-${++n}`;
    docIdByPath[relPath] = docId;
    docSyncState[docId] = state;
  }
  return buildTreeSyncIndex({
    docIdByPath,
    docSyncState,
    localNotePaths: [...Object.keys(notes), ...extraLocal],
  });
}

describe("buildTreeSyncIndex", () => {
  it("keys note state by docId, so a rename can't fork or lose it", () => {
    // The mapping moved the note to a new path; the state still belongs to the id.
    const index = buildTreeSyncIndex({
      docIdByPath: { "Work/Renamed.md": "doc-1" },
      docSyncState: { "doc-1": "synced" },
      localNotePaths: ["Work/Renamed.md"],
    });
    expect(index.notes.get("Work/Renamed.md")).toBe("synced");
    expect(index.notes.has("Work/Old.md")).toBe(false);
    expect(index.folders.get("Work")?.state).toBe("synced");
  });

  it("counts a note with no server mapping as unsynced, in its folder's total", () => {
    // THE honesty case: a local .md the registry never mapped (registration
    // failed, or hasn't run) must not silently vanish from the denominator and
    // let its folder claim 100%.
    const index = indexOf({ "Work/a.md": "synced" }, ["Work/b.md"]);
    expect(index.notes.get("Work/b.md")).toBe("unsynced");
    const work = index.folders.get("Work")!;
    expect(work.total).toBe(2);
    expect(work.synced).toBe(1);
    expect(work.percent).toBe(50);
    expect(work.state).not.toBe("synced");
  });

  it("treats a mapped doc with no reported transition as unsynced", () => {
    const index = buildTreeSyncIndex({
      docIdByPath: { "a.md": "doc-1" },
      docSyncState: {},
      localNotePaths: ["a.md"],
    });
    expect(index.notes.get("a.md")).toBe("unsynced");
  });

  it("rolls a folder up from EVERY descendant, however deep and unexpanded", () => {
    // The tree is lazily loaded, so the roll-up must not depend on it at all:
    // these nested folders were never expanded and still report correctly.
    const index = indexOf({
      "A/one.md": "synced",
      "A/B/two.md": "synced",
      "A/B/C/three.md": "syncing",
      "root.md": "synced",
    });
    expect(index.folders.get("A")).toMatchObject({ total: 3, synced: 2, percent: 66 });
    expect(index.folders.get("A/B")).toMatchObject({ total: 2, synced: 1, percent: 50 });
    expect(index.folders.get("A/B/C")).toMatchObject({ total: 1, synced: 0, percent: 0 });
    expect(index.vault).toMatchObject({ total: 4, synced: 3, percent: 75 });
  });

  it("is 'synced' only when every descendant is", () => {
    expect(indexOf({ "A/a.md": "synced", "A/b.md": "synced" }).folders.get("A")!.state).toBe(
      "synced",
    );
    expect(indexOf({ "A/a.md": "synced", "A/b.md": "queued" }).folders.get("A")!.state).toBe(
      "syncing",
    );
    expect(
      indexOf({ "A/a.md": "synced", "A/b.md": "unsynced" }).folders.get("A")!.state,
    ).toBe("unsynced");
  });

  it("surfaces an error over anything else in the subtree", () => {
    const index = indexOf({
      "A/a.md": "synced",
      "A/b.md": "syncing",
      "A/deep/c.md": "error",
    });
    expect(index.folders.get("A")!.state).toBe("error");
    expect(index.folders.get("A/deep")!.state).toBe("error");
    expect(index.vault!.state).toBe("error");
  });

  it("never reads 100% while a single note is outstanding", () => {
    const notes: Record<string, DocSyncState> = {};
    for (let i = 0; i < 500; i++) notes[`Big/n${i}.md`] = "synced";
    notes["Big/n499.md"] = "syncing";
    const big = indexOf(notes).folders.get("Big")!;
    expect(big.total).toBe(500);
    expect(big.synced).toBe(499);
    expect(big.percent).toBe(99); // floored, not rounded to 100
  });

  it("gives folders with no notes no summary at all", () => {
    // A folder holding only images has nothing to say about note sync; it must
    // render nothing rather than a meaningless "0 of 0".
    const index = indexOf({ "Notes/a.md": "synced" });
    expect(index.folders.has("Images")).toBe(false);
    expect(rowSyncMark(dir("Images"), index)).toBeNull();
  });

  it("ignores markdown inside the hidden vault-root attachments/ store", () => {
    // Rust indexes it (so it lands in `titles`), the sidebar hides the folder, and
    // the registry never registers it as a note. It has no row to badge, so
    // counting it would only make the vault look permanently unsynced.
    const index = indexOf({ "a.md": "synced" }, [
      "attachments/stray.md",
      "attachments/sub/other.md",
    ]);
    expect(index.notes.has("attachments/stray.md")).toBe(false);
    expect(index.folders.has("attachments")).toBe(false);
    expect(index.vault).toMatchObject({ total: 1, synced: 1, state: "synced" });
    // A user's OWN nested attachments folder is normal content and still counts.
    const nested = indexOf({ "Notes/attachments/keep.md": "synced" });
    expect(nested.folders.get("Notes/attachments")?.total).toBe(1);
  });

  it("has no notes, no folders and no vault roll-up for an empty vault", () => {
    const index = buildTreeSyncIndex({
      docIdByPath: {},
      docSyncState: {},
      localNotePaths: [],
    });
    expect(index.notes.size).toBe(0);
    expect(index.folders.size).toBe(0);
    expect(index.vault).toBeNull();
  });

  it("ignores a docSyncState entry whose doc is no longer mapped", () => {
    // Stale per-doc state (a deleted note) must not invent a row or a count.
    const index = buildTreeSyncIndex({
      docIdByPath: { "a.md": "doc-1" },
      docSyncState: { "doc-1": "synced", "doc-gone": "error" },
      localNotePaths: ["a.md"],
    });
    expect(index.notes.size).toBe(1);
    expect(index.vault).toMatchObject({ total: 1, failed: 0, state: "synced" });
  });
});

describe("rowSyncMark", () => {
  it("shows a dot for a note and never a fraction", () => {
    const index = indexOf({ "a.md": "syncing" });
    expect(rowSyncMark(file("a.md"), index)).toEqual({
      state: "syncing",
      progress: null,
      title: "Syncing…",
    });
  });

  it("draws nothing on a file that isn't a synced note", () => {
    // Images/PDFs sync as attachments, not notes: an indicator on them would be
    // a lie in the other direction.
    const index = indexOf({ "a.md": "synced" });
    expect(rowSyncMark(file("shot.png"), index)).toBeNull();
    expect(rowSyncMark(file("page.html"), index)).toBeNull();
  });

  it("shows a folder's synced/total counts, and a dot once settled", () => {
    const busy = indexOf({ "A/a.md": "synced", "A/b.md": "syncing" });
    expect(rowSyncMark(dir("A"), busy)).toMatchObject({
      state: "syncing",
      progress: { synced: 1, total: 2 },
    });

    const done = indexOf({ "A/a.md": "synced", "A/b.md": "synced" });
    expect(rowSyncMark(dir("A"), done)).toMatchObject({ state: "synced", progress: null });

    const broken = indexOf({ "A/a.md": "synced", "A/b.md": "error" });
    expect(rowSyncMark(dir("A"), broken)).toMatchObject({ state: "error", progress: null });
  });

  it("shows the counts for a stalled partial folder too", () => {
    // Nothing in flight, not everything synced: the number is the only honest
    // answer, and it is what tells the user which folder to look at.
    const index = indexOf({ "A/a.md": "synced" }, ["A/b.md", "A/c.md"]);
    expect(rowSyncMark(dir("A"), index)).toMatchObject({
      state: "unsynced",
      progress: { synced: 1, total: 3 },
    });
  });

  it("resolves the vault root folder to the whole-vault roll-up", () => {
    const index = indexOf({ "A/a.md": "synced", "b.md": "synced" });
    expect(rowSyncMark(dir(""), index)).toMatchObject({ state: "synced", progress: null });
  });
});

describe("folderSyncTitle", () => {
  it("states the real counts rather than a rounded claim", () => {
    const index = indexOf({ "A/a.md": "synced", "A/b.md": "syncing", "A/c.md": "syncing" });
    expect(folderSyncTitle(index.folders.get("A")!)).toBe("1 of 3 notes synced");
  });

  it("names the failures when there are any", () => {
    const index = indexOf({ "A/a.md": "error", "A/b.md": "synced" });
    expect(folderSyncTitle(index.folders.get("A")!)).toBe("1 note of 2 couldn't sync");
  });

  it("says so plainly when everything is synced", () => {
    expect(folderSyncTitle(indexOf({ "A/a.md": "synced" }).folders.get("A")!)).toBe(
      "All 1 note synced",
    );
  });
});
