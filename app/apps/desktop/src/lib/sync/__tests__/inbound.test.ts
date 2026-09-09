import { describe, expect, it } from "vitest";
import { isSafeFolderPath, isSafeNotePath, planInbound } from "../inbound";

/**
 * `planInbound` decides whether to move or delete files on someone's disk, so it
 * is written as a pure function and tested as a table. Every rule gets a case,
 * and the ones that matter most get their own names:
 *   - a note the server RENAMED must move, not duplicate;
 *   - a note that left the listing (access revoked) must be removed, because a
 *     revocation that leaves a readable copy behind is cosmetic;
 *   - …unless the server didn't answer about deletions, where absence proves
 *     nothing and the file must be left alone.
 */

const empty = {
  server: new Map<string, string>(),
  // Nullable on purpose: `null` means "the server didn't answer", which several
  // cases below rely on being distinguishable from an empty set.
  tombstones: new Set<string>() as Set<string> | null,
  baseline: new Map<string, string>(),
  local: new Map<string, string>(),
  serverFolders: new Set<string>(),
  localFolders: new Set<string>(),
  folderTombstones: new Set<string>() as Set<string> | null,
  localFolderIds: new Map<string, string>(),
  serverFolderIds: new Map<string, string>(),
};

function plan(over: Partial<typeof empty>) {
  return planInbound({ ...empty, ...over });
}

describe("planInbound — folders", () => {
  it("creates a folder that exists only on the server", () => {
    // The reported bug: `create_folder` over MCP always makes an EMPTY folder, and
    // nothing in the client ever created a local folder except the user's own
    // right-click — so an AI-created folder was invisible on every device forever.
    const p = plan({ serverFolders: new Set(["Ideas"]) });
    expect(p.createFolders).toEqual(["Ideas"]);
  });

  it("creates parents before children", () => {
    const p = plan({ serverFolders: new Set(["A/B/C", "A", "A/B"]) });
    expect(p.createFolders).toEqual(["A", "A/B", "A/B/C"]);
  });

  it("is a no-op for folders that already exist locally", () => {
    const p = plan({
      serverFolders: new Set(["Ideas"]),
      localFolders: new Set(["Ideas"]),
    });
    expect(p.createFolders).toEqual([]);
  });

  it("never deletes a local folder the server merely no longer lists", () => {
    // The folder listing is permission-filtered, so "absent" alone is
    // irreducibly ambiguous for a folder we never recorded a server id for: it
    // could be a brand-new local folder. Only an id WE recorded (see the
    // revocation cases below) or a tombstone lets the plan act.
    const p = plan({ localFolders: new Set(["Gone"]) });
    expect(p).toMatchObject({ createFolders: [], removeFolders: [], trash: [], renames: [] });
  });

  it("removes a recorded folder that left the listing without a tombstone — access revoked", () => {
    // THE leftover-folder bug: an admin made "Getting Started" private. Its
    // notes left as `revoked`, but the folder was neither tombstoned nor moved,
    // so the emptied directory stayed in the teammate's sidebar forever.
    const p = plan({
      localFolders: new Set(["Getting Started", "Getting Started/Deep", "Concepts"]),
      localFolderIds: new Map([
        ["Getting Started", "f-gs"],
        ["Getting Started/Deep", "f-deep"],
        ["Concepts", "f-c"],
      ]),
      serverFolders: new Set(["Concepts"]),
      serverFolderIds: new Map([["f-c", "Concepts"]]),
    });
    // Children first, so the subtree unwinds bottom-up.
    expect(p.removeFolders).toEqual(["Getting Started/Deep", "Getting Started"]);
    expect(p.rejected).toEqual([]);
  });

  it("leaves a revoked folder alone when the server did not answer about folder deletions", () => {
    // `null` tombstones = "I don't know" — a truncated listing looks exactly
    // like a mass revoke, and the safe reading of absence is then nothing.
    const p = plan({
      localFolders: new Set(["Getting Started"]),
      localFolderIds: new Map([["Getting Started", "f-gs"]]),
      folderTombstones: null,
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("does not read a revoked folder as revoked once the server re-created its path", () => {
    // Someone made a NEW "Getting Started" (fresh id) after ours went private:
    // the directory on disk is now that folder's, and the outbound half adopts it.
    const p = plan({
      localFolders: new Set(["Getting Started"]),
      localFolderIds: new Map([["Getting Started", "f-old"]]),
      serverFolders: new Set(["Getting Started"]),
      serverFolderIds: new Map([["f-new", "Getting Started"]]),
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("refuses a mass folder revocation past the safety limit, and reports every one", () => {
    const localFolders = new Set<string>();
    const localFolderIds = new Map<string, string>();
    for (let i = 0; i < 21; i++) {
      localFolders.add(`F${i}`);
      localFolderIds.set(`F${i}`, `f${i}`);
    }
    const p = plan({ localFolders, localFolderIds });
    expect(p.removeFolders).toEqual([]);
    expect(p.rejected).toHaveLength(21);
    expect(p.rejected[0]).toMatchObject({ kind: "folder", path: "F0" });
    expect(p.rejected[0].reason).toMatch(/exceeds the 20 safety limit/);
  });

  it("removes a local folder whose recorded id is tombstoned, children first", () => {
    // THE reappearing-folder bug: a device still holding the folder locally used
    // to re-register it on its next pull, resurrecting it for the whole team.
    const p = plan({
      localFolders: new Set(["A", "A/B", "Keep"]),
      localFolderIds: new Map([
        ["A", "fa"],
        ["A/B", "fb"],
        ["Keep", "fk"],
      ]),
      // `Keep` is still listed; a recorded id that is NEITHER listed nor
      // tombstoned would be a revocation (its own cases above).
      serverFolders: new Set(["Keep"]),
      serverFolderIds: new Map([["fk", "Keep"]]),
      folderTombstones: new Set(["fa", "fb"]),
    });
    expect(p.removeFolders).toEqual(["A/B", "A"]);
  });

  it("does not remove on a tombstone when the server did not answer (null)", () => {
    const p = plan({
      localFolders: new Set(["A"]),
      localFolderIds: new Map([["A", "fa"]]),
      folderTombstones: null,
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("leaves a folder re-created at the same path alone", () => {
    // The successor has a fresh server id; the old id's tombstone must not take
    // the new folder down with it.
    const p = plan({
      localFolders: new Set(["A"]),
      serverFolders: new Set(["A"]),
      localFolderIds: new Map([["A", "fa-old"]]),
      folderTombstones: new Set(["fa-old"]),
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("skips a tombstoned folder that is already gone locally", () => {
    const p = plan({
      localFolderIds: new Map([["A", "fa"]]),
      folderTombstones: new Set(["fa"]),
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("removes the emptied old directory of a folder the server MOVED", () => {
    // We recorded id f1 at "Projects/vid"; the server now has f1 at "Archive/vid".
    const p = plan({
      localFolders: new Set(["Projects", "Projects/vid"]),
      localFolderIds: new Map([["Projects", "fp"], ["Projects/vid", "f1"]]),
      serverFolders: new Set(["Projects", "Archive", "Archive/vid"]),
      serverFolderIds: new Map([["fp", "Projects"], ["fa", "Archive"], ["f1", "Archive/vid"]]),
    });
    expect(p.removeFolders).toEqual(["Projects/vid"]);
    expect(p.createFolders).toEqual(["Archive", "Archive/vid"]);
  });

  it("leaves a moved folder's old path alone once the server has re-created it there", () => {
    const p = plan({
      localFolders: new Set(["Projects/vid"]),
      localFolderIds: new Map([["Projects/vid", "f1"]]),
      serverFolders: new Set(["Projects/vid", "Archive/vid"]),
      serverFolderIds: new Map([["f1", "Archive/vid"], ["f2", "Projects/vid"]]),
    });
    expect(p.removeFolders).toEqual([]);
  });

  // The #98 heartbeat. Disk says `Projects/community`, the server says
  // `Projects/Community` (a rename-by-case on one device, or migration 023
  // merging case-duplicated rows), and the server holds an EMPTY folder under
  // it. On a case-insensitive filesystem those are one directory, so neither
  // half of the plan may act on the spelling alone — creating it and removing it
  // alternated on every pull, forever, each pass re-triggering the next through
  // the watcher.
  it("treats a folder that differs from the server only by case as already present", () => {
    const p = plan({
      serverFolders: new Set(["Projects/Community", "Projects/Community/Content/pipeline"]),
      localFolders: new Set(["Projects/community", "Projects/community/Content/pipeline"]),
    });
    expect(p.createFolders).toEqual([]);
    expect(p.removeFolders).toEqual([]);
  });

  it("does not read a spelling disagreement as a remote MOVE of the folder", () => {
    // The id recorded under the local spelling now "lives" at the server's
    // spelling of the same directory. That is not a move: nothing to remove.
    const p = plan({
      localFolderIds: new Map([["Projects/community/Content/pipeline", "f-pipe"]]),
      serverFolderIds: new Map([["f-pipe", "Projects/Community/Content/pipeline"]]),
      localFolders: new Set(["Projects/community", "Projects/community/Content/pipeline"]),
      serverFolders: new Set(["Projects/Community", "Projects/Community/Content/pipeline"]),
    });
    expect(p.removeFolders).toEqual([]);
    expect(p.createFolders).toEqual([]);
  });

  it("still removes the old directory when the server moved the folder for real", () => {
    // Guard against over-correcting: a genuine move (different name, not just
    // different case) must keep working exactly as before.
    const p = plan({
      localFolderIds: new Map([["Projects/vid", "f1"]]),
      serverFolderIds: new Map([["f1", "Archive/vid"]]),
      localFolders: new Set(["Projects", "Projects/vid"]),
      serverFolders: new Set(["Projects", "Archive", "Archive/vid"]),
    });
    expect(p.removeFolders).toEqual(["Projects/vid"]);
  });

  it("matches a tombstoned folder's local spelling against the server's re-creation case-insensitively", () => {
    // Deleted under one spelling, re-created under another: same directory on
    // disk, so the tombstone must not remove it.
    const p = plan({
      localFolderIds: new Map([["Archive", "old-id"]]),
      folderTombstones: new Set(["old-id"]),
      localFolders: new Set(["Archive"]),
      serverFolders: new Set(["archive"]),
    });
    expect(p.removeFolders).toEqual([]);
  });

  it("refuses an unsafe folder path", () => {
    const p = plan({ serverFolders: new Set([".context/evil", "../up", "ok"]) });
    expect(p.createFolders).toEqual(["ok"]);
    expect(p.rejected).toHaveLength(2);
  });
});

describe("planInbound — renames", () => {
  it("moves a note the server renamed (the duplicate-file bug)", () => {
    const p = plan({
      baseline: new Map([["d1", "old.md"]]),
      local: new Map([["d1", "old.md"]]),
      server: new Map([["d1", "new.md"]]),
    });
    expect(p.renames).toEqual([{ docId: "d1", from: "old.md", to: "new.md" }]);
    expect(p.trash).toEqual([]);
  });

  it("leaves a note WE moved for the outbound half to push", () => {
    const p = plan({
      baseline: new Map([["d1", "old.md"]]),
      local: new Map([["d1", "moved.md"]]),
      server: new Map([["d1", "old.md"]]),
    });
    expect(p.renames).toEqual([]);
  });

  it("lets the server win when both sides moved (the feed is downstream-only)", () => {
    const p = plan({
      baseline: new Map([["d1", "old.md"]]),
      local: new Map([["d1", "mine.md"]]),
      server: new Map([["d1", "theirs.md"]]),
    });
    expect(p.renames).toEqual([{ docId: "d1", from: "mine.md", to: "theirs.md" }]);
  });

  it("does nothing when everyone already agrees", () => {
    const p = plan({
      baseline: new Map([["d1", "a.md"]]),
      local: new Map([["d1", "a.md"]]),
      server: new Map([["d1", "a.md"]]),
    });
    expect(p.renames).toEqual([]);
  });

  it("does nothing when both sides moved to the SAME new path", () => {
    const p = plan({
      baseline: new Map([["d1", "a.md"]]),
      local: new Map([["d1", "b.md"]]),
      server: new Map([["d1", "b.md"]]),
    });
    expect(p.renames).toEqual([]);
  });

  it("will not guess without a baseline", () => {
    // On disk at one path, on the server at another, and no record of a prior
    // agreement. "The server moved it" and "we have never reconciled this" look
    // identical here, so renaming would be acting on a hunch.
    const p = plan({
      local: new Map([["d1", "here.md"]]),
      server: new Map([["d1", "there.md"]]),
    });
    expect(p.renames).toEqual([]);
  });

  it("leaves a server-only note to the existing materialize step", () => {
    const p = plan({ server: new Map([["d1", "new.md"]]) });
    expect(p).toMatchObject({ renames: [], trash: [] });
  });
});

describe("planInbound — deletes", () => {
  it("trashes a note the server tombstoned", () => {
    const p = plan({
      baseline: new Map([["d1", "bye.md"]]),
      local: new Map([["d1", "bye.md"]]),
      tombstones: new Set(["d1"]),
    });
    expect(p.trash).toEqual([{ docId: "d1", path: "bye.md", reason: "deleted" }]);
    // Suppressed as well, so even if the trash step is skipped the note is not
    // re-registered as an unsyncable ghost.
    expect([...p.suppress]).toEqual(["bye.md"]);
  });

  it("removes the file when a note left the listing (access revoked)", () => {
    // `GET /api/notes` is ACL-filtered, so losing access looks like a delete —
    // hence the tombstone set, which says which of the two it was. Both end in
    // the vault's trash, but they are tagged differently because they carry
    // different risk and get different safety caps.
    const p = plan({
      baseline: new Map([["d1", "shared.md"]]),
      local: new Map([["d1", "shared.md"]]),
      tombstones: new Set(),
    });
    expect(p.trash).toEqual([{ docId: "d1", path: "shared.md", reason: "revoked" }]);
    expect([...p.revoked]).toEqual(["d1"]);
    // Suppressed too, so the outbound half can't re-register it on the way out.
    expect([...p.suppress]).toEqual(["shared.md"]);
  });

  it("does NOT remove a revoked file when the server didn't answer about deletions", () => {
    // `null` tombstones means "I don't know". Absence proves nothing then — it
    // could equally be a truncated response — and removing files on the strength
    // of a maybe is the one thing this module must never do.
    const p = plan({
      baseline: new Map([["d1", "shared.md"]]),
      local: new Map([["d1", "shared.md"]]),
      tombstones: null,
    });
    expect(p.trash).toEqual([]);
    expect([...p.revoked]).toEqual(["d1"]);
    expect([...p.suppress]).toEqual(["shared.md"]);
  });

  it("refuses to delete anything when the server did not report tombstones", () => {
    // `null` = "this server can't answer", which must never be read as
    // "nothing is deleted" OR as "everything is deleted".
    const p = plan({
      baseline: new Map([["d1", "bye.md"]]),
      local: new Map([["d1", "bye.md"]]),
      tombstones: null,
    });
    expect(p.trash).toEqual([]);
    expect([...p.revoked]).toEqual(["d1"]);
  });

  it("ignores a tombstone for a doc we never agreed was ours", () => {
    const p = plan({
      local: new Map([["d1", "mine.md"]]),
      tombstones: new Set(["d1"]),
    });
    expect(p.trash).toEqual([]);
  });

  it("is a no-op for a tombstoned note already gone from disk", () => {
    const p = plan({
      baseline: new Map([["d1", "bye.md"]]),
      tombstones: new Set(["d1"]),
    });
    expect(p.trash).toEqual([]);
  });

  it("suppresses a tombstoned note whose file is still on disk under another id", () => {
    // The undeletable-note bug. A note MATERIALIZED from the server has a local
    // index id Rust minted for the new file, which is not the server's docId; if
    // the registry mapping that joined the two has since been pruned, the doc
    // reads as "gone locally" here while the file is very much still there. The
    // outbound half then re-registered it under a brand-new docId, so a deleted
    // note came back — and deleting it again just repeated the cycle.
    const p = plan({
      baseline: new Map([["server-id", "naveed-test.md"]]),
      local: new Map([["local-index-id", "naveed-test.md"]]),
      tombstones: new Set(["server-id"]),
    });
    expect([...p.suppress]).toEqual(["naveed-test.md"]);
    // Suppress only. Without a docId match we cannot prove the file at that path
    // is still this note, and a wrong guess here deletes someone's work.
    expect(p.trash).toEqual([]);
  });

  it("trashes deepest paths first", () => {
    const p = plan({
      baseline: new Map([
        ["d1", "a.md"],
        ["d2", "A/B/deep.md"],
        ["d3", "A/mid.md"],
      ]),
      local: new Map([
        ["d1", "a.md"],
        ["d2", "A/B/deep.md"],
        ["d3", "A/mid.md"],
      ]),
      tombstones: new Set(["d1", "d2", "d3"]),
    });
    expect(p.trash.map((t) => t.path)).toEqual(["A/B/deep.md", "A/mid.md", "a.md"]);
  });
});

describe("planInbound — circuit breakers", () => {
  /**
   * `dead: true` builds a vault whose docs are all ABSENT from the server
   * listing (the delete/revoke shape); `false` builds one where every doc moved
   * (the rename shape). `keep` lists docIds to leave in the listing untouched,
   * so a case can isolate a few deletions without the remaining 97 reading as
   * mass revocations.
   */
  function manyDocs(n: number, dead: boolean, keep: string[] = []) {
    const baseline = new Map<string, string>();
    const local = new Map<string, string>();
    const server = new Map<string, string>();
    const kept = new Set(keep);
    for (let i = 0; i < n; i++) {
      baseline.set(`d${i}`, `n${i}.md`);
      local.set(`d${i}`, `n${i}.md`);
      if (!dead) server.set(`d${i}`, `moved-${i}.md`);
      else if (kept.has(`d${i}`)) server.set(`d${i}`, `n${i}.md`);
    }
    return { baseline, local, server };
  }

  it("abandons the whole trash category past the safety limit", () => {
    // A teammate tidying up deletes a few notes. A bug in this file, a permission
    // glitch, or a truncated response "deletes" most of the vault — and nothing
    // inside can tell those apart, so cap the blast radius instead.
    const { baseline, local } = manyDocs(100, true);
    const p = plan({
      baseline,
      local,
      tombstones: new Set([...baseline.keys()]),
    });
    expect(p.trash).toEqual([]);
    expect(p.rejected).toHaveLength(100);
    expect(p.rejected[0].reason).toContain("safety limit");
    expect(p.rejected[0].reason).toContain("deletions");
  });

  it("allows a small delete under the limit", () => {
    const survivors = Array.from({ length: 97 }, (_, i) => `d${i + 3}`);
    const { baseline, local, server } = manyDocs(100, true, survivors);
    const p = plan({
      baseline,
      local,
      server,
      tombstones: new Set(["d0", "d1", "d2"]),
    });
    expect(p.trash).toHaveLength(3);
    expect(p.rejected).toEqual([]);
  });

  it("caps deletions and revocations against separate budgets", () => {
    // Revocation gets the looser cap: losing a whole shared folder is an
    // ordinary admin action, while a mass DELETE is far more likely to be a bug.
    // They must not consume each other's allowance either — a mass revoke can't
    // be allowed to refuse one legitimate delete riding along with it.
    const { baseline, local, server } = manyDocs(100, true, ["d99"]);
    const p = plan({ baseline, local, server, tombstones: new Set(["d0"]) });

    // 99 revocations against a cap of 50 → the whole revoked group is refused…
    expect(p.trash).toEqual([{ docId: "d0", path: "n0.md", reason: "deleted" }]);
    expect(p.rejected).toHaveLength(98);
    expect(p.rejected[0].reason).toContain("access removals");

    // …while 40 of them (under the cap) go through, alongside the delete.
    const keep = Array.from({ length: 59 }, (_, i) => `d${i + 41}`);
    const partial = manyDocs(100, true, keep);
    const q = plan({
      baseline: partial.baseline,
      local: partial.local,
      server: partial.server,
      tombstones: new Set(["d0"]),
    });
    expect(q.trash.filter((t) => t.reason === "revoked")).toHaveLength(40);
    expect(q.trash.filter((t) => t.reason === "deleted")).toHaveLength(1);
    expect(q.rejected).toEqual([]);
  });

  it("allows up to five deletes even in a tiny vault", () => {
    // 20% of a 3-note vault is 1, which would make ordinary tidying up impossible.
    const { baseline, local } = manyDocs(3, true);
    const p = plan({ baseline, local, tombstones: new Set(["d0", "d1", "d2"]) });
    expect(p.trash).toHaveLength(3);
  });

  it("abandons the whole rename category past its own limit", () => {
    const { baseline, local, server } = manyDocs(100, false);
    const p = plan({ baseline, local, server });
    expect(p.renames).toEqual([]);
    expect(p.rejected).toHaveLength(100);
  });
});

describe("path safety", () => {
  it("rejects paths that would escape or hide the note", () => {
    // `rel_path` is not validated anywhere on the way in — MCP inserts whatever
    // string it's given — and Rust's `resolve_in_vault` deliberately PERMITS
    // `.context/`, since that's how the vault config is read. So the guard has to
    // be here, on the side that turns a server string into a destination.
    for (const bad of [
      ".context/config.json",
      "../escape.md",
      "/absolute.md",
      "a\\b.md",
      "a/./b.md",
      "a//b.md",
      ".hidden.md",
      "node_modules/x.md",
      "no-extension",
      "script.exe",
      "",
      "control\u0000char.md",
    ]) {
      expect(isSafeNotePath(bad), bad).toBe(false);
    }
  });

  it("accepts ordinary note paths", () => {
    for (const ok of ["a.md", "A/B/c.md", "Notes/My Note.md", "page.html", "board.canvas"]) {
      expect(isSafeNotePath(ok), ok).toBe(true);
    }
  });

  it("accepts folder paths without requiring an extension", () => {
    expect(isSafeFolderPath("Archive/2026")).toBe(true);
    expect(isSafeFolderPath(".git")).toBe(false);
  });

  it("never renames a note ONTO an unsafe path", () => {
    const p = plan({
      baseline: new Map([["d1", "ok.md"]]),
      local: new Map([["d1", "ok.md"]]),
      server: new Map([["d1", ".context/config.json"]]),
    });
    expect(p.renames).toEqual([]);
    expect(p.rejected[0]).toMatchObject({ kind: "rename", docId: "d1" });
  });
});

/**
 * The BenAI OS vault, 2026-09-04, after migration 023 merged its 71
 * case-duplicated folders and 164 notes.
 *
 * The merge keeps ONE server row per case-insensitive path, and the one it kept
 * spells the folder `Projects/Community`. The directory on disk is
 * `Projects/community`. Compared exactly, every one of those notes is "on disk
 * under one path, on the server under another" — 164 renames a pass, each a
 * no-op or a refusal on a filesystem that has only one such directory — while
 * `reconcile` separately re-registered all 235. The header read
 * "Syncing 225/235", finished nothing, and started again.
 */
describe("planInbound — a case-variant spelling is the same file", () => {
  const server = new Map([["doc-1", "Projects/Community/a.md"]]);
  const local = new Map([["doc-1", "Projects/community/a.md"]]);

  it("plans no rename when only the case differs", () => {
    const p = plan({ server, local, baseline: new Map(local) });
    expect(p.renames).toEqual([]);
    expect(p.trash).toEqual([]);
    expect(p.suppress.size).toBe(0);
  });

  it("still moves a note the server genuinely renamed", () => {
    const p = plan({
      server: new Map([["doc-1", "Projects/Community/renamed.md"]]),
      local,
      baseline: new Map(local),
    });
    expect(p.renames).toEqual([
      { docId: "doc-1", from: "Projects/community/a.md", to: "Projects/Community/renamed.md" },
    ]);
  });

  it("leaves an outbound case-only rename to the outbound side", () => {
    // We moved it, the server has not caught up: `srv === prev` up to case.
    const p = plan({
      server: new Map([["doc-1", "Projects/Community/a.md"]]),
      local: new Map([["doc-1", "Projects/community/moved.md"]]),
      baseline: new Map([["doc-1", "Projects/community/a.md"]]),
    });
    expect(p.renames).toEqual([]);
  });
});
