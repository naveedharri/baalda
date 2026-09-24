import { describe, expect, it } from "vitest";
import {
  buildTreeSyncIndex,
  FolderWaveTracker,
  folderSyncTitle,
  rowSyncMark,
  sidebarMarksVisible,
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

/** The same, plus the attachment mirror's per-path map (`store.fileSyncState`). */
function withFiles(
  notes: Record<string, DocSyncState>,
  files: Record<string, DocSyncState>,
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
    localNotePaths: Object.keys(notes),
    fileSyncState: files,
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

  it("rolls files into the SAME folder counts as notes", () => {
    // The dot answers one question — "is everything under here on the server?" —
    // and a folder whose only outstanding thing is an uploading PDF must not
    // read as settled just because its notes are done.
    const index = withFiles(
      { "Team/plan.md": "synced" },
      { "Team/report.docx": "syncing", "Team/logo.png": "synced" },
    );
    expect(index.folders.get("Team")).toMatchObject({
      total: 3,
      synced: 2,
      pending: 1,
      state: "syncing",
    });
    expect(index.vault).toMatchObject({ total: 3, synced: 2, state: "syncing" });

    // A failed file is the thing to look at, exactly as a failed note is.
    const broken = withFiles({ "Team/plan.md": "synced" }, { "Team/huge.mp4": "error" });
    expect(broken.folders.get("Team")!.state).toBe("error");
  });

  it("gives a folder of nothing but files a roll-up of its own", () => {
    // Previously "a folder holding only images has nothing to say"; now it
    // does, because those images sync.
    const index = withFiles({}, { "Media/a.png": "synced", "Media/b.mp4": "queued" });
    expect(index.folders.get("Media")).toMatchObject({ total: 2, synced: 1, pending: 1 });
    expect(rowSyncMark(dir("Media"), index, true)).toMatchObject({ state: "syncing" });
  });

  it("never counts a file twice, or one the registry claims as a note", () => {
    // Belt and braces for a mirror map that outlived the pass that built it:
    // the hidden root store has no row, and a path the registry has claimed is
    // the note's, not the blob's.
    const index = withFiles(
      { "Notes/a.md": "synced" },
      { "Notes/a.md": "error", "attachments/dropped.png": "error" },
    );
    expect(index.files.size).toBe(0);
    expect(index.vault).toMatchObject({ total: 1, failed: 0, state: "synced" });
  });

  it("does not pin a folder's wave on files (the mirror speaks or it doesn't)", () => {
    // A file has no `unreported` limbo — the mirror publishes its whole local
    // set each pass — so its state counts as work the moment it is reported.
    const waves = new FolderWaveTracker();
    const index = withFiles({}, { "Media/a.png": "synced", "Media/b.mp4": "queued" });
    waves.apply(index);
    expect(rowSyncMark(dir("Media"), index, true)!.progress).toEqual({ done: 0, total: 1 });
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

  it("counts unreported-but-not-named notes as synced once the server has answered", () => {
    // After `ready`, silence is a verdict: every doc the server named, or this
    // device has not confirmed, is in the run and reports its own state.
    const input = {
      docIdByPath: { "A/a.md": "d1", "A/b.md": "d2", "A/c.md": "d3" },
      docSyncState: { d3: "queued" } as Record<string, DocSyncState>,
      localNotePaths: ["A/a.md", "A/b.md", "A/c.md", "A/local.md"],
    };
    const before = buildTreeSyncIndex(input);
    expect(before.folders.get("A")).toMatchObject({ synced: 0, unreported: 2 });
    expect(before.notes.get("A/a.md")).toBe("unsynced");

    const after = buildTreeSyncIndex({ ...input, serverSettled: true });
    expect(after.notes.get("A/a.md")).toBe("synced");
    expect(after.notes.get("A/b.md")).toBe("synced");
    expect(after.notes.get("A/c.md")).toBe("queued"); // in the run
    // Never mapped at all ⇒ still honestly not on the server.
    expect(after.notes.get("A/local.md")).toBe("unsynced");
    expect(after.folders.get("A")).toMatchObject({
      total: 4,
      synced: 2,
      pending: 1,
      unreported: 0,
    });
  });

  it("keeps failure counts unless asked to fold them into synced", () => {
    const input = {
      docIdByPath: { "a.md": "d1", "b.md": "d2" },
      docSyncState: { d1: "error", d2: "synced" } as Record<string, DocSyncState>,
      localNotePaths: ["a.md", "b.md"],
      fileSyncState: { "c.pdf": "error" } as Record<string, DocSyncState>,
    };
    // Default: unchanged — the Health page still counts failures.
    expect(buildTreeSyncIndex(input).vault).toMatchObject({ failed: 2, state: "error" });
    const folded = buildTreeSyncIndex({ ...input, failuresAsSynced: true });
    expect(folded.vault).toMatchObject({ total: 3, synced: 3, failed: 0, state: "synced" });
    expect(folded.notes.get("a.md")).toBe("synced");
    expect(folded.files.get("c.pdf")).toBe("synced");
  });
});

describe("rowSyncMark", () => {
  it("shows a dot for a note and never a fraction", () => {
    const index = indexOf({ "a.md": "syncing" });
    expect(rowSyncMark(file("a.md"), index, true)).toEqual({
      state: "syncing",
      progress: null,
      title: "Syncing…",
    });
  });

  it("draws nothing on a file the attachment mirror has never spoken for", () => {
    // A binary gets its dot from the mirror, not the registry. Before the
    // mirror's first pass — or with sync off — there is nothing to claim, and
    // an indicator would be a lie in the other direction.
    const index = indexOf({ "a.md": "synced" });
    expect(rowSyncMark(file("shot.png"), index)).toBeNull();
    expect(rowSyncMark(file("page.html"), index)).toBeNull();
  });

  it("gives a file the mirror HAS spoken for the same dot, in a file's words", () => {
    const index = withFiles({ "a.md": "synced" }, { "Team/report.docx": "syncing" });
    expect(rowSyncMark(file("Team/report.docx"), index, true)).toEqual({
      state: "syncing",
      progress: null,
      title: "Uploading…",
    });
    // A failed upload is the Health page's to explain; the sidebar never shows
    // an error, mid-run or after.
    for (const runActive of [true, false]) {
      expect(
        rowSyncMark(file("Media/clip.mp4"), withFiles({}, { "Media/clip.mp4": "error" }), runActive),
      ).toMatchObject({ state: "synced", title: "Synced" });
    }
  });

  it("shows a folder's wave counts (not its population), and a dot once settled", () => {
    // One of two notes is still moving: the badge counts the WAVE (the one note
    // that needs syncing), not the folder's whole population — a single new
    // file in a 1114-note folder must read "0/1", never "1113/1114".
    const busy = indexOf({ "A/a.md": "synced", "A/b.md": "syncing" });
    expect(rowSyncMark(dir("A"), busy, true)).toMatchObject({
      state: "syncing",
      progress: { done: 0, total: 1 },
    });

    const done = indexOf({ "A/a.md": "synced", "A/b.md": "synced" });
    expect(rowSyncMark(dir("A"), done, true)).toMatchObject({ state: "synced", progress: null });

    // A failure is not outstanding work (nothing is moving it) and never a tone.
    const broken = indexOf({ "A/a.md": "synced", "A/b.md": "error" });
    expect(rowSyncMark(dir("A"), broken, true)).toMatchObject({ state: "synced", progress: null });
  });

  it("drops every wave the moment the run ends — no stuck 0/N", () => {
    // THE bug: a run ended with leftovers (a failed note, two never reached)
    // and the folder sat at an amber "0/3" forever. With no run moving, every
    // row with an indicator is the green dot.
    const index = indexOf({ "A/a.md": "synced", "A/b.md": "error", "A/c.md": "queued" }, [
      "A/d.md",
    ]);
    const waves = new FolderWaveTracker();
    waves.apply(index);
    expect(rowSyncMark(dir("A"), index, true)!.progress).toEqual({ done: 0, total: 2 });

    for (const row of [dir("A"), dir(""), file("A/b.md"), file("A/c.md"), file("A/d.md")]) {
      expect(rowSyncMark(row, index, false)).toMatchObject({ state: "synced", progress: null });
    }
    expect(rowSyncMark(dir("A"), index, false)!.title).toBe("All 4 files synced");
  });

  it("reads the run flag off the index when the caller does not pass one", () => {
    const index = indexOf({ "A/a.md": "synced", "A/b.md": "syncing" });
    expect(rowSyncMark(dir("A"), index)!.progress).toBeNull();
    index.runActive = true;
    expect(rowSyncMark(dir("A"), index)!.progress).toEqual({ done: 0, total: 1 });
  });

  it("never draws an error tone anywhere in the sidebar", () => {
    const index = buildTreeSyncIndex({
      docIdByPath: { "A/a.md": "d1", "A/B/b.md": "d2" },
      docSyncState: { d1: "error", d2: "error" },
      localNotePaths: ["A/a.md", "A/B/b.md"],
      fileSyncState: { "A/c.pdf": "error" },
      failuresAsSynced: true,
    });
    const rows = [dir(""), dir("A"), dir("A/B"), file("A/a.md"), file("A/B/b.md"), file("A/c.pdf")];
    for (const runActive of [true, false]) {
      for (const row of rows) {
        expect(rowSyncMark(row, index, runActive)!.state).not.toBe("error");
      }
    }
    // …and without the flag, rowSyncMark still refuses to draw one.
    const raw = indexOf({ "A/a.md": "error" });
    expect(rowSyncMark(file("A/a.md"), raw, true)!.state).toBe("synced");
    expect(rowSyncMark(dir("A"), raw, true)!.state).toBe("synced");
  });

  it("resolves the vault root folder to the whole-vault roll-up", () => {
    const index = indexOf({ "A/a.md": "synced", "b.md": "synced" });
    expect(rowSyncMark(dir(""), index)).toMatchObject({ state: "synced", progress: null });
  });
});

describe("FolderWaveTracker", () => {
  it("pins the wave's denominator while notes sync, so progress reads forward", () => {
    const waves = new FolderWaveTracker();

    // Two new files land: wave is 0/2.
    const start = indexOf({ "A/a.md": "queued", "A/b.md": "queued", "A/c.md": "synced" });
    waves.apply(start);
    expect(rowSyncMark(dir("A"), start, true)!.progress).toEqual({ done: 0, total: 2 });

    // One of them syncs: 1/2 — NOT 0/1, which would erase the progress made.
    const half = indexOf({ "A/a.md": "synced", "A/b.md": "syncing", "A/c.md": "synced" });
    waves.apply(half);
    expect(rowSyncMark(dir("A"), half, true)!.progress).toEqual({ done: 1, total: 2 });
  });

  it("forgets a settled folder, so the next wave starts fresh at 0/1", () => {
    const waves = new FolderWaveTracker();
    const busy = indexOf({ "A/a.md": "syncing", "A/b.md": "syncing" });
    waves.apply(busy);

    // Everything lands — the folder settles (dot; no progress stamped).
    const done = indexOf({ "A/a.md": "synced", "A/b.md": "synced" });
    waves.apply(done);
    expect(rowSyncMark(dir("A"), done, true)!.progress).toBeNull();

    // One NEW file later: a fresh 0/1 wave, not a resumed 2/3.
    const next = indexOf({ "A/a.md": "synced", "A/b.md": "synced", "A/c.md": "queued" });
    waves.apply(next);
    expect(rowSyncMark(dir("A"), next, true)!.progress).toEqual({ done: 0, total: 1 });
  });

  it("does not pin the wave on notes nobody has reported yet (fresh launch)", () => {
    // A fresh launch: the registry has mapped every note but the run has not
    // stamped anything. Every note reads unsynced, yet none of them is WORK —
    // pinning the wave here is what produced "186/187" for one new note.
    const waves = new FolderWaveTracker();
    const launch = buildTreeSyncIndex({
      docIdByPath: { "A/a.md": "d1", "A/b.md": "d2", "A/c.md": "d3" },
      docSyncState: {},
      localNotePaths: ["A/a.md", "A/b.md", "A/c.md"],
    });
    waves.apply(launch);
    expect(launch.folders.get("A")!.unreported).toBe(3);
    expect(launch.folders.get("A")!.state).toBe("unsynced"); // still honest
    expect(rowSyncMark(dir("A"), launch, true)!.progress).toBeNull(); // no "0/3"

    // The run's batch lands: two confirmed, and one NEW file appears queued.
    const busy = buildTreeSyncIndex({
      docIdByPath: { "A/a.md": "d1", "A/b.md": "d2", "A/c.md": "d3", "A/new.md": "d4" },
      docSyncState: { d1: "synced", d2: "synced", d3: "synced", d4: "queued" },
      localNotePaths: ["A/a.md", "A/b.md", "A/c.md", "A/new.md"],
    });
    waves.apply(busy);
    const mark = rowSyncMark(dir("A"), busy, true)!;
    expect(mark.progress).toEqual({ done: 0, total: 1 }); // not 3/4
    // The tooltip counts the same wave the badge does.
    expect(mark.title).toBe("Syncing 0 of 1 file");
  });

  it("grows the wave when more work arrives mid-flight", () => {
    const waves = new FolderWaveTracker();
    const one = indexOf({ "A/a.md": "syncing" });
    waves.apply(one);
    expect(one.folders.get("A")!.wave).toEqual({ done: 0, total: 1 });

    // A second file lands before the first finishes: the wave widens to 2.
    const two = indexOf({ "A/a.md": "syncing", "A/b.md": "queued" });
    waves.apply(two);
    expect(two.folders.get("A")!.wave).toEqual({ done: 0, total: 2 });
  });

  it("tracks the vault root under its own key and resets on demand", () => {
    const waves = new FolderWaveTracker();
    const busy = indexOf({ "a.md": "syncing", "b.md": "synced" });
    waves.apply(busy);
    expect(busy.vault!.wave).toEqual({ done: 0, total: 1 });

    waves.reset();
    const again = indexOf({ "a.md": "syncing", "b.md": "syncing" });
    waves.apply(again);
    // After a reset nothing is remembered: the wave is exactly what's unsynced now.
    expect(again.vault!.wave).toEqual({ done: 0, total: 2 });
  });
});

describe("folderSyncTitle", () => {
  // The unit is "file", not "note": these counts hold the folder's binaries
  // too, and a folder of three PDFs must not claim "All 3 notes synced".
  it("uses the badge's numbers while a run moves the folder", () => {
    // The old mismatch: "0/14" on the row, "11 of 25 files synced" on hover.
    const waves = new FolderWaveTracker();
    const start = indexOf({ "A/a.md": "synced", "A/b.md": "queued", "A/c.md": "queued" });
    waves.apply(start);
    const half = indexOf({ "A/a.md": "synced", "A/b.md": "synced", "A/c.md": "syncing" });
    waves.apply(half);
    const mark = rowSyncMark(dir("A"), half, true)!;
    expect(mark.progress).toEqual({ done: 1, total: 2 });
    expect(mark.title).toBe("Syncing 1 of 2 files");
    expect(folderSyncTitle(half.folders.get("A")!, mark.progress)).toBe(mark.title);
  });

  it("does not name failures — that is the Health page's job", () => {
    const index = indexOf({ "A/a.md": "error", "A/b.md": "synced" });
    expect(folderSyncTitle(index.folders.get("A")!)).toBe("All 2 files synced");
  });

  it("says so plainly when everything is synced", () => {
    expect(folderSyncTitle(indexOf({ "A/a.md": "synced" }).folders.get("A")!)).toBe(
      "All 1 file synced",
    );
  });
});

describe("sidebarMarksVisible", () => {
  it("hides every mark until the server has answered this session", () => {
    expect(sidebarMarksVisible("offline")).toBe(false);
    expect(sidebarMarksVisible("connecting")).toBe(false);
    expect(sidebarMarksVisible("error")).toBe(false);
    expect(sidebarMarksVisible("no-access")).toBe(false);
  });

  it("shows them once the server has spoken, even to say view-only or too large", () => {
    expect(sidebarMarksVisible("synced")).toBe(true);
    expect(sidebarMarksVisible("read-only")).toBe(true);
    expect(sidebarMarksVisible("deleted")).toBe(true);
    expect(sidebarMarksVisible("too-large")).toBe(true);
  });
});
