import { describe, expect, it } from "vitest";
import { isSafeFolderPath, isSafeNotePath, planInbound } from "../inbound";

/**
 * `planInbound` decides whether to move or delete files on someone's disk, so it
 * is written as a pure function and tested as a table. Every rule gets a case,
 * and the two that matter most get their own names:
 *   - a note the server RENAMED must move, not duplicate;
 *   - a note that merely left the listing (a revoked share) must NOT be touched.
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

  it("never deletes a local folder the server no longer lists", () => {
    // Folders are hard-deleted server-side with no tombstone, and the folder
    // listing is permission-filtered, so "absent" is irreducibly ambiguous.
    // Inbound folders are create-only, permanently.
    const p = plan({ localFolders: new Set(["Gone"]) });
    expect(p).toMatchObject({ createFolders: [], trash: [], renames: [] });
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
    expect(p.trash).toEqual([{ docId: "d1", path: "bye.md" }]);
    // Suppressed as well, so even if the trash step is skipped the note is not
    // re-registered as an unsyncable ghost.
    expect([...p.suppress]).toEqual(["bye.md"]);
  });

  it("KEEPS the file when a note merely left the listing (revoked share)", () => {
    // The test the whole tombstone design exists for. `GET /api/notes` is
    // ACL-filtered, so losing a share looks exactly like a delete. Removing files
    // on absence would mean an unshare destroys a teammate's local notes.
    const p = plan({
      baseline: new Map([["d1", "shared.md"]]),
      local: new Map([["d1", "shared.md"]]),
      tombstones: new Set(),
    });
    expect(p.trash).toEqual([]);
    expect([...p.revoked]).toEqual(["d1"]);
    // Still suppressed: keep the file, stop claiming it.
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
  function manyDocs(n: number, dead: boolean) {
    const baseline = new Map<string, string>();
    const local = new Map<string, string>();
    const server = new Map<string, string>();
    for (let i = 0; i < n; i++) {
      baseline.set(`d${i}`, `n${i}.md`);
      local.set(`d${i}`, `n${i}.md`);
      if (!dead) server.set(`d${i}`, `moved-${i}.md`);
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
  });

  it("allows a small delete under the limit", () => {
    const { baseline, local } = manyDocs(100, true);
    const p = plan({
      baseline,
      local,
      tombstones: new Set(["d1", "d2", "d3"]),
    });
    expect(p.trash).toHaveLength(3);
    expect(p.rejected).toEqual([]);
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
