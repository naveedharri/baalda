import { describe, expect, it } from "vitest";
import { planBinarySync, type LocalAttachment, type ServerBlob } from "../attachments";
import { planInbound } from "../inbound";

// A teammate renamed or moved a file (or its folder). This device holds the
// file by id at the OLD path with the same bytes: the local file must follow,
// not be "agreed" where it is. Left behind, it kept the old folder alive and
// the next pass registered that folder again: the move came back as a twin.

const L = (relPath: string, sha256: string): LocalAttachment => ({ relPath, sha256 });
const S = (id: string, relPath: string, sha256: string, docId: string): ServerBlob => ({ id, relPath, sha256, docId });

describe("planBinarySync: following a teammate's move", () => {
  const ids = new Map([["Team/sheet.csv", "f1"]]);
  const ctx = { docIdFor: (p: string) => ids.get(p) ?? null, baseFor: () => "sha-a" };

  it("moves the local file to the server's path, keeping the id", () => {
    const plan = planBinarySync([L("Team/sheet.csv", "sha-a")], [S("b1", "Renamed/sheet.csv", "sha-a", "f1")], ctx);
    expect(plan.toFollow).toEqual([{ docId: "f1", from: "Team/sheet.csv", to: "Renamed/sheet.csv", sha256: "sha-a" }]);
    expect(plan.agreed).toEqual([]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.toDownload).toEqual([]);
  });

  it("does not move onto a path already taken here", () => {
    const plan = planBinarySync(
      [L("Team/sheet.csv", "sha-a"), L("Renamed/sheet.csv", "sha-other")],
      [S("b1", "Renamed/sheet.csv", "sha-a", "f1")],
      ctx,
    );
    expect(plan.toFollow).toEqual([]);
  });

  it("the same path is simply agreed", () => {
    const plan = planBinarySync([L("Team/sheet.csv", "sha-a")], [S("b1", "Team/sheet.csv", "sha-a", "f1")], ctx);
    expect(plan.toFollow).toEqual([]);
    expect(plan.agreed).toHaveLength(1);
  });
});

describe("planInbound: a folder a teammate moved", () => {
  it("names the move so the registry can carry the folder's files along", () => {
    const plan = planInbound({
      server: new Map([["n1", "New/a.md"]]),
      tombstones: new Set<string>(),
      baseline: new Map([["n1", "Old/a.md"]]),
      local: new Map([["n1", "Old/a.md"]]),
      serverFolders: new Set(["New"]),
      serverFolderIds: new Map([["fold1", "New"]]),
      localFolders: new Set(["Old"]),
      folderTombstones: new Set<string>(),
      localFolderIds: new Map([["Old", "fold1"]]),
      authoritative: false,
      authoritativeRevoked: undefined,
      localFiles: new Map<string, string>(),
      authoredByMe: new Set<string>(),
    });
    expect(plan.movedFolders).toEqual([{ from: "Old", to: "New" }]);
    expect(plan.removeFolders).toContain("Old");
    expect(plan.renames).toEqual([{ docId: "n1", from: "Old/a.md", to: "New/a.md" }]);
  });
});
