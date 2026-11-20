import { describe, expect, it } from "vitest";
import { filterGroups, groupAccessSummary, groupColor, groupCountLine, groupNameProblem, nextGroupColor } from "../groups";
import { groupFloor } from "../../components/MemberAccessBoard";
import type { AccessGroup } from "../api";

const g = (over: Partial<AccessGroup>): AccessGroup => ({
  id: "g1", name: "Design", color: null, autoJoin: false, createdAt: "", memberIds: [], invited: [], grants: [], skillCount: 0, ...over,
});

describe("groups helpers", () => {
  it("summarises what a group gives", () => {
    expect(groupAccessSummary(null)).toBeNull();
    expect(groupAccessSummary([])).toBe("No access yet");
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

  it("a group's board cannot drop a row below what an ancestor grant gives", () => {
    const grants = [
      { resourceType: "folder" as const, permission: "edit" as const, path: "Specs" },
      { resourceType: "vault" as const, permission: "view" as const, path: null },
    ];
    expect(groupFloor("Specs/a.md", grants)).toEqual({ mode: "open", from: "Specs" });
    expect(groupFloor("Specs", grants)).toEqual({ mode: "readonly", from: null });
    expect(groupFloor("Other/b.md", grants.slice(0, 1))).toEqual({ mode: "private", from: null });
    expect(groupFloor("Specsheet.md", grants.slice(0, 1)).mode).toBe("private");
  });
});
