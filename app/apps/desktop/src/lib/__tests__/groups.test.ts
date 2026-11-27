import { describe, expect, it } from "vitest";
import { filterGroups, groupAccessSummary, groupColor, groupCountLine, groupNameProblem, nextGroupColor, groupDeleteNote, groupOpensWholeVault, groupRemoveNote } from "../groups";
import type { AccessGroup } from "../api";

const g = (over: Partial<AccessGroup>): AccessGroup => ({
  id: "g1", name: "Design", color: null, autoJoin: false, createdAt: "", memberIds: [], invited: [], grants: [], skillCount: 0, ...over,
});

describe("groups helpers", () => {
  it("summarises what a group gives", () => {
    expect(groupAccessSummary(null)).toBeNull();
    expect(groupAccessSummary([])).toBe("No access");
    expect(groupAccessSummary([{ resourceType: "vault", resourceId: "o", permission: "edit", path: null }])).toBe("Can edit everything");
    expect(groupAccessSummary([
      { resourceType: "vault", resourceId: "o", permission: "view", path: null },
      { resourceType: "folder", resourceId: "f", permission: "edit", path: "Specs/Design" },
    ])).toBe("Can view everything · Can edit Design");
    expect(groupAccessSummary([
      { resourceType: "folder", resourceId: "a", permission: "edit", path: "A" },
      { resourceType: "folder", resourceId: "b", permission: "edit", path: "B" },
      { resourceType: "file", resourceId: "c", permission: "view", path: "C/n.md" },
    ])).toBe("Can edit A and 1 more · Can view n.md");
  });

  it("counts, filters, colours and checks names", () => {
    expect(groupCountLine({ memberIds: ["a"], invited: [{ invitationId: "i", email: "x" }] })).toBe("1 member, 1 invited");
    const groups = [g({ id: "1", name: "Design", memberIds: ["u1"] }), g({ id: "2", name: "Sales" })];
    expect(filterGroups("ana", groups, [{ userId: "u1", name: "Ana", email: null }]).map((x) => x.id)).toEqual(["1"]);
    expect(filterGroups("sal", groups, []).map((x) => x.id)).toEqual(["2"]);
    expect(groupColor({ id: "x", color: "teal" })).toBe("teal");
    expect(groupColor({ id: "x", color: null })).toBe(groupColor({ id: "x", color: null }));
    expect(nextGroupColor([{ id: "a", color: "violet" }])).toBe("green");
    expect(groupNameProblem("  ", groups)).toMatch(/name/);
    expect(groupNameProblem("design", groups)).toMatch(/already/);
    expect(groupNameProblem("design", groups, "1")).toBeNull();
  });

  it("a group's No access rows are named as exceptions, never as access", () => {
    const vault = { resourceType: "vault" as const, resourceId: "org", permission: "edit" as const, path: null };
    const hidden = (path: string) => ({ resourceType: "folder" as const, resourceId: path, permission: "denied" as const, path });
    expect(groupAccessSummary([vault, hidden("HR")])).toBe("Can edit everything except HR");
    expect(groupAccessSummary([vault, hidden("HR"), hidden("Board/Pay")])).toBe("Can edit everything except HR and 1 more");
    expect(groupAccessSummary([hidden("HR")])).toBe("No access");
    expect(groupOpensWholeVault([hidden("HR")])).toBe(false);
  });
});

describe("group removal and deletion say plainly what is lost", () => {
  const whole = [{ resourceType: "vault" as const, resourceId: "org", permission: "edit" as const, path: null }];
  const folder = [{ resourceType: "folder" as const, resourceId: "f", permission: "view" as const, path: "Sales" }];

  it("knows a group that opens the whole vault", () => {
    expect(groupOpensWholeVault(whole)).toBe(true);
    expect(groupOpensWholeVault(folder)).toBe(false);
    expect(groupOpensWholeVault(null)).toBe(false);
  });

  it("removing someone from a whole-vault group names the loss, own notes included", () => {
    const t = groupRemoveNote("Everyone", whole, { self: false, name: "Mia" });
    expect(t).toContain("Everyone opens the whole vault");
    expect(t).toContain("everything else leaves their computer, notes they wrote included");
    expect(t).toContain("stays on the server");
    expect(t).toContain("adding them back returns it");
  });

  it("leaving it yourself speaks to you", () => {
    const t = groupRemoveNote("Everyone", whole, { self: true, name: "Me" });
    expect(t).toContain("you keep only your own access");
    expect(t).toContain("leaves this computer, notes you wrote included");
    expect(t).toContain("adding yourself back");
  });

  it("a narrower group still says notes written there go too", () => {
    expect(groupRemoveNote("Sales", folder, { self: false, name: "Sam" })).toBe(
      "Sam loses what Sales gave, notes they wrote there included. Their own access and other groups stay, and nothing is deleted for the team.",
    );
  });

  it("deleting a whole-vault group warns it cannot be rebuilt exactly", () => {
    const t = groupDeleteNote("Everyone", whole, 12);
    expect(t).toContain("Its 12 members keep only their own access");
    expect(t).toContain("notes they wrote included");
    expect(t).toContain("not exactly who saw what before");
    expect(t).toContain("This can't be undone.");
    expect(groupDeleteNote("Sales", folder, 1)).toContain("Its member loses what Sales gave");
  });
});

