import { describe, expect, it } from "vitest";
import { ancestorPaths } from "../accessTree";
import {
  MODE_LABEL,
  buildOrgRowsByPath,
  clearedCountPhrase,
  effectiveTeamMode,
  overrideCountPhrase,
  type OrgRow,
  type TeamMode,
} from "../accessMode";

/** Build the org-row map the way the panel does: path → the rows sitting on it. */
function rows(spec: Record<string, OrgRow[]>): Map<string, Set<OrgRow>> {
  return new Map(Object.entries(spec).map(([path, list]) => [path, new Set(list)]));
}

function resolve(vaultMode: TeamMode, path: string, spec: Record<string, OrgRow[]> = {}) {
  return effectiveTeamMode({
    vaultMode,
    path,
    ancestors: ancestorPaths(path),
    orgRowsByPath: rows(spec),
  });
}

describe("effectiveTeamMode — no rows at all", () => {
  it("takes the vault's mode, and says so", () => {
    for (const mode of ["open", "readonly", "private"] as TeamMode[]) {
      expect(resolve(mode, "Projects/Plan.md")).toEqual({ mode, source: "vault" });
    }
  });

  it("resolves a root-level note with no ancestors", () => {
    expect(resolve("open", "Inbox.md")).toEqual({ mode: "open", source: "vault" });
  });
});

describe("effectiveTeamMode — denied is absolute", () => {
  it("beats an open vault on the item itself", () => {
    expect(resolve("open", "Secret.md", { "Secret.md": ["denied"] })).toEqual({
      mode: "private",
      source: "self",
      sourcePath: "Secret.md",
    });
  });

  it("inherits from a folder above", () => {
    expect(
      resolve("open", "HR/Pay/Bands.md", { HR: ["denied"] }),
    ).toEqual({ mode: "private", source: "ancestor", sourcePath: "HR" });
  });

  it("beats an edit grant on the same item", () => {
    expect(resolve("private", "HR/Note.md", { "HR/Note.md": ["denied", "edit"] }).mode).toBe(
      "private",
    );
  });

  it("beats an edit grant sitting closer to the note", () => {
    // The nearest row is the edit grant, but denied is checked across the whole
    // chain first — exactly as the server resolves the org deny before grants.
    expect(resolve("open", "HR/Pay/Bands.md", { HR: ["denied"], "HR/Pay": ["edit"] }).mode).toBe(
      "private",
    );
  });

  it("names the NEAREST denied ancestor", () => {
    expect(
      resolve("open", "A/B/C/Note.md", { A: ["denied"], "A/B": ["denied"] }).sourcePath,
    ).toBe("A/B");
  });
});

describe("effectiveTeamMode — locked caps at read-only", () => {
  it("caps an open vault", () => {
    expect(resolve("open", "Docs/Spec.md", { Docs: ["locked"] })).toEqual({
      mode: "readonly",
      source: "ancestor",
      sourcePath: "Docs",
    });
  });

  it("caps an edit grant on the very same item (a lock applies after grants)", () => {
    expect(resolve("private", "Docs/Spec.md", { "Docs/Spec.md": ["locked", "edit"] }).mode).toBe(
      "readonly",
    );
  });

  it("caps a vault that is open or read-only, with no per-item grant needed", () => {
    expect(resolve("open", "Docs/Spec.md", { "Docs/Spec.md": ["locked"] }).mode).toBe("readonly");
    expect(resolve("readonly", "Docs/Spec.md", { "Docs/Spec.md": ["locked"] }).mode).toBe(
      "readonly",
    );
  });

  it("loses to a deny", () => {
    expect(resolve("open", "Docs/Spec.md", { Docs: ["locked", "denied"] }).mode).toBe("private");
  });

  it("is PRIVATE, not read-only, when nothing grants access for it to cap", () => {
    // A lock is a ceiling, not a floor. The server consults `isLocked` only
    // once a permission has resolved above `none`, so a bare lock in a Private
    // vault leaves the team with nothing at all — and badging that "Read-only"
    // was the panel contradicting the enforcer. (The state is reachable: a
    // stale cached vault mode once let the panel write a lock where it should
    // have written a view grant.)
    expect(resolve("private", "Docs/Spec.md", { Docs: ["locked"] })).toEqual({
      mode: "private",
      source: "vault",
    });
  });

  it("caps, rather than blocks, once a grant reaches the item", () => {
    expect(resolve("private", "Docs/Spec.md", { Docs: ["locked", "view"] }).mode).toBe("readonly");
    expect(resolve("private", "Docs/Spec.md", { Docs: ["locked", "edit"] }).mode).toBe("readonly");
    // A grant on an ancestor counts too.
    expect(resolve("private", "Docs/Spec.md", { Docs: ["locked"], "Docs/Spec.md": [] }).mode).toBe(
      "private",
    );
    expect(resolve("private", "Docs/Deep/Spec.md", { Docs: ["edit"], "Docs/Deep": ["locked"] }).mode).toBe(
      "readonly",
    );
  });
});

describe("effectiveTeamMode — grants lift a restricted vault", () => {
  it("an edit grant opens an item in a private vault", () => {
    expect(resolve("private", "Team/Plan.md", { Team: ["edit"] })).toEqual({
      mode: "open",
      source: "ancestor",
      sourcePath: "Team",
    });
  });

  it("an edit grant opens an item in a read-only vault", () => {
    expect(resolve("readonly", "Team/Plan.md", { "Team/Plan.md": ["edit"] })).toEqual({
      mode: "open",
      source: "self",
      sourcePath: "Team/Plan.md",
    });
  });

  it("a view grant makes an item read-only in a private vault", () => {
    expect(resolve("private", "Team/Plan.md", { Team: ["view"] })).toEqual({
      mode: "readonly",
      source: "ancestor",
      sourcePath: "Team",
    });
  });

  it("an edit grant outranks a view grant on a folder above it", () => {
    expect(
      resolve("private", "Team/Sub/Plan.md", { Team: ["view"], "Team/Sub": ["edit"] }).mode,
    ).toBe("open");
  });

  it("a view grant below an edit grant still opens (grants only ever raise)", () => {
    expect(
      resolve("private", "Team/Sub/Plan.md", { Team: ["edit"], "Team/Sub": ["view"] }).mode,
    ).toBe("open");
  });

  it("reports the vault, not a redundant grant, when the vault already opens it", () => {
    // Nothing would change by clearing this row, so pointing at it would send
    // someone to the wrong control.
    expect(resolve("open", "Team/Plan.md", { Team: ["edit"] })).toEqual({
      mode: "open",
      source: "vault",
    });
  });

  it("reports the vault when a read-only vault already caps it", () => {
    expect(resolve("readonly", "Team/Plan.md", { Team: ["view"] })).toEqual({
      mode: "readonly",
      source: "vault",
    });
  });
});

describe("effectiveTeamMode — the bug this function exists to fix", () => {
  it("badges a folder explicitly Shared inside a Private vault as Shared", () => {
    // The row badges used to ignore per-item edit/view grants entirely and fall
    // straight back to the vault's mode, so this read "Private" in the list
    // while the detail pane's tri-state said Shared — on the same screen.
    expect(resolve("private", "Shared Notes", { "Shared Notes": ["edit"] }).mode).toBe("open");
    expect(resolve("private", "Shared Notes/Deep/Note.md", { "Shared Notes": ["edit"] }).mode).toBe(
      "open",
    );
  });
});

describe("effectiveTeamMode — an unrelated sibling never bleeds across", () => {
  it("ignores rows on a path that merely shares a prefix", () => {
    // "Team" is not an ancestor of "TeamNotes/x.md" — string prefixes are not
    // path ancestry.
    expect(resolve("private", "TeamNotes/x.md", { Team: ["edit"] }).mode).toBe("private");
  });
});

describe("MODE_LABEL", () => {
  it("calls open mode Shared, matching every control on the page", () => {
    expect(MODE_LABEL).toEqual({
      open: "Shared",
      readonly: "Read-only",
      private: "Private",
    });
  });
});

describe("overrideCountPhrase", () => {
  it("is empty when there is nothing to replace", () => {
    expect(overrideCountPhrase(0, 0)).toBe("");
  });

  it("singularises each half independently", () => {
    expect(overrideCountPhrase(1, 0)).toBe("1 folder setting");
    expect(overrideCountPhrase(0, 1)).toBe("1 note setting");
    expect(overrideCountPhrase(1, 1)).toBe("1 folder setting and 1 note setting");
  });

  it("pluralises and joins", () => {
    expect(overrideCountPhrase(3, 12)).toBe("3 folder settings and 12 note settings");
    expect(overrideCountPhrase(0, 4)).toBe("4 note settings");
    expect(overrideCountPhrase(2, 0)).toBe("2 folder settings");
  });
});

describe("clearedCountPhrase", () => {
  it("pluralises the server's single total", () => {
    expect(clearedCountPhrase(4)).toBe("4 folder and note settings");
    expect(clearedCountPhrase(200)).toBe("200 folder and note settings");
  });

  it("reads naturally for exactly one, which the plural wording cannot", () => {
    // "1 folder and note setting" would describe one impossible thing.
    expect(clearedCountPhrase(1)).toBe("1 folder or note setting");
  });
});

describe("buildOrgRowsByPath", () => {
  const entries = [
    { id: "f1", path: "Projects" },
    { id: "f2", path: "Projects/Q3" },
    { id: "n1", path: "Projects/Q3/Plan.md" },
  ];
  const orgRow = (id: string, permission: OrgRow, resourceType: "folder" | "file" = "folder") => ({
    id: `s_${id}_${permission}`,
    resourceType,
    resourceId: id,
    principalType: "org" as const,
    permission,
  });
  const userRow = (id: string, permission: OrgRow) => ({
    ...orgRow(id, permission),
    id: `u_${id}_${permission}`,
    principalType: "user" as const,
    principalId: "user_sam",
  });

  it("maps override resource ids to paths through the entries", () => {
    const map = buildOrgRowsByPath(
      entries,
      null,
      [
        { resourceId: "f2", permission: "edit" },
        { resourceId: "n1", permission: "denied" },
      ],
      [],
      [],
    );
    expect([...map.keys()].sort()).toEqual(["Projects/Q3", "Projects/Q3/Plan.md"]);
    expect(map.get("Projects/Q3")).toEqual(new Set(["edit"]));
    expect(map.get("Projects/Q3/Plan.md")).toEqual(new Set(["denied"]));
  });

  it("falls back to the local tree for an id the entries do not carry", () => {
    // The local-tree map is the fallback while the server listing is in flight
    // or was refused.
    const map = buildOrgRowsByPath(
      [],
      new Map([["f9", "Archive"]]),
      [{ resourceId: "f9", permission: "locked" }],
      [],
      [],
    );
    expect(map.get("Archive")).toEqual(new Set(["locked"]));
  });

  it("prefers the entries over the local tree when both name an id", () => {
    // The server structure still lists an item that has left the disk; a disk
    // path for the same id is the stale one.
    const map = buildOrgRowsByPath(
      [{ id: "f1", path: "Projects" }],
      new Map([["f1", "Old Name"]]),
      [{ resourceId: "f1", permission: "edit" }],
      [],
      [],
    );
    expect(map.has("Projects")).toBe(true);
    expect(map.has("Old Name")).toBe(false);
  });

  it("drops a row whose id resolves to no path at all", () => {
    const map = buildOrgRowsByPath(entries, null, [{ resourceId: "ghost", permission: "edit" }], [], []);
    expect(map.size).toBe(0);
  });

  it("unions the store's lock and deny overlay with the overrides", () => {
    const map = buildOrgRowsByPath(
      entries,
      null,
      [{ resourceId: "f1", permission: "edit" }],
      [orgRow("f1", "locked")],
      [orgRow("n1", "denied", "file")],
    );
    expect(map.get("Projects")).toEqual(new Set(["edit", "locked"]));
    expect(map.get("Projects/Q3/Plan.md")).toEqual(new Set(["denied"]));
  });

  it("dedupes a row both sources report", () => {
    const map = buildOrgRowsByPath(
      entries,
      null,
      [{ resourceId: "f1", permission: "locked" }],
      [orgRow("f1", "locked")],
      [],
    );
    expect(map.get("Projects")).toEqual(new Set(["locked"]));
  });

  it("excludes per-USER rows — those are the Restricted overlay, not the mode", () => {
    const map = buildOrgRowsByPath(
      entries,
      null,
      null,
      [userRow("f1", "locked")],
      [userRow("n1", "denied")],
    );
    expect(map.size).toBe(0);
  });

  it("keeps org rows while dropping user rows on the SAME resource", () => {
    const map = buildOrgRowsByPath(entries, null, null, [orgRow("f1", "locked"), userRow("f1", "locked")], []);
    expect(map.get("Projects")).toEqual(new Set(["locked"]));
  });

  it("returns an empty map with nothing to map", () => {
    expect(buildOrgRowsByPath([], null, null, [], []).size).toBe(0);
  });
});
