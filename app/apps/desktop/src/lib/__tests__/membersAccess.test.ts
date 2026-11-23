import { describe, expect, it } from "vitest";
import {
  accessSources,
  countLine,
  everyoneLabel,
  filterPeople,
  invitationAccessLabel,
  needsAccessConfirm,
  isValidEmail,
  tickGrantMode,
  reduceAccessCopy,
  lastActiveLabel,
  splitEmails,
} from "../membersAccess";
import { addChips } from "../../components/InvitePeopleDialog";

describe("members and access rules", () => {
  it("only taking access away entirely asks for confirmation", () => {
    expect(needsAccessConfirm("open", "private")).toBe(true);
    expect(needsAccessConfirm("readonly", "private")).toBe(true);
    expect(needsAccessConfirm("custom", "private")).toBe(true);
    expect(needsAccessConfirm(null, "private")).toBe(true);
    // View-only and widening apply straight away.
    expect(needsAccessConfirm("open", "readonly")).toBe(false);
    expect(needsAccessConfirm(null, "readonly")).toBe(false);
    expect(needsAccessConfirm("private", "open")).toBe(false);
    // Already No access: nothing to confirm.
    expect(needsAccessConfirm("private", "private")).toBe(false);
  });

  it("a never-shared vault reads as Only what's shared and says authors keep their notes", () => {
    expect(everyoneLabel("private", "none")).toEqual({ label: "Only what's shared", sub: "Members also keep notes they wrote" });
    expect(everyoneLabel("private", "sealed")).toEqual({ label: "Only what's shared", sub: null });
    expect(everyoneLabel("open", "edit")).toEqual({ label: "Can edit", sub: null });
  });

  it("filters by name or email and counts", () => {
    const members = [
      { userId: "a", memberId: "1", role: "owner" as const, name: "Ana Ruiz", email: "ana@team.com", image: null, joinedAt: null, lastActiveAt: null },
      { userId: "b", memberId: "2", role: "member" as const, name: "Lee", email: "lee@team.com", image: null, joinedAt: null, lastActiveAt: null },
    ];
    const invitations = [{ id: "i", email: "maya@team.com", role: "member", status: "pending", createdAt: null, expiresAt: null, access: null }];
    expect(filterPeople("ANA", members, invitations).members.map((m) => m.userId)).toEqual(["a"]);
    expect(filterPeople("maya", members, invitations).invitations).toHaveLength(1);
    expect(countLine("", 4, 1)).toBe("4 people · 1 invite pending");
    expect(countLine("", 1, 0)).toBe("1 person");
    expect(countLine("x", 1, 0)).toBe("1 person found");
    expect(invitationAccessLabel(null)).toBe("Default");
  });

  it("last active prefers live presence", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    expect(lastActiveLabel(true, null, now)).toBe("Now");
    expect(lastActiveLabel(false, null, now)).toBe("—");
    expect(lastActiveLabel(false, "2026-10-04T10:00:00Z", now)).toBe("2 hours ago");
  });

  it("splits, de-duplicates and validates invite emails", () => {
    expect(splitEmails("a@x.io, b@x.io;c@x.io\nd@x.io")).toEqual(["a@x.io", "b@x.io", "c@x.io", "d@x.io"]);
    expect(addChips(["A@x.io"], "a@x.io b@x.io")).toEqual(["A@x.io", "b@x.io"]);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("ok@team.com")).toBe(true);
  });
});

import { canActOnMember, canSetMemberAccess } from "../../components/memberRoles";

describe("who may change a person's access", () => {
  const args = (myRole: string, target: { userId: string; role: string }) =>
    ({ canManage: true, myUserId: "me", myRole, target });
  it("owner: anyone, including themselves", () => {
    expect(canSetMemberAccess(args("owner", { userId: "me", role: "owner" }))).toBe(true);
    expect(canSetMemberAccess(args("owner", { userId: "a", role: "admin" }))).toBe(true);
    // Role change / remove are unchanged: never yourself.
    expect(canActOnMember(args("owner", { userId: "me", role: "owner" }))).toBe(false);
  });
  it("admin: everyone except the owner", () => {
    expect(canSetMemberAccess(args("admin", { userId: "me", role: "admin" }))).toBe(true);
    expect(canSetMemberAccess(args("admin", { userId: "m", role: "member" }))).toBe(true);
    expect(canSetMemberAccess(args("admin", { userId: "a", role: "admin" }))).toBe(true);
    // Role change / remove stay stricter: an admin never touches another admin.
    expect(canActOnMember(args("admin", { userId: "a", role: "admin" }))).toBe(false);
    expect(canSetMemberAccess(args("admin", { userId: "o", role: "owner" }))).toBe(false);
  });
  it("member or no manage right: nobody", () => {
    expect(canSetMemberAccess(args("member", { userId: "me", role: "member" }))).toBe(false);
    expect(canSetMemberAccess({ ...args("owner", { userId: "me", role: "owner" }), canManage: false })).toBe(false);
  });
});

describe("what a tick grants", () => {
  it("prefers the person's level, then Everyone's, then Can edit", () => {
    expect(tickGrantMode("readonly", "open")).toBe("readonly");
    expect(tickGrantMode("open", "readonly")).toBe("open");
    expect(tickGrantMode("custom", "readonly")).toBe("readonly");
    expect(tickGrantMode("private", "open")).toBe("open");
    expect(tickGrantMode(null, "private")).toBe("open");
    expect(tickGrantMode("custom", null)).toBe("open");
  });
});

describe("confirm copy for taking access away", () => {
  it("names the outcome in plain words", () => {
    expect(reduceAccessCopy({ kind: "item", name: "Specs" }, "private")).toMatchObject({ title: "Remove access to “Specs”?", button: "Remove access" });
    expect(reduceAccessCopy({ kind: "item", name: "Specs" }, "readonly")).toEqual({
      title: "Make “Specs” view only?", button: "Make view only", outcome: "They can still read it but no longer edit.",
    });
    expect(reduceAccessCopy({ kind: "person", name: "Sara", self: false }, "private").title).toBe("Remove Sara's access to this vault?");
    expect(reduceAccessCopy({ kind: "person", name: "Sara", self: false }, "readonly").title).toBe("Make Sara view only across the vault?");
    expect(reduceAccessCopy({ kind: "person", name: "Me", self: true }, "private")).toMatchObject({
      title: "Remove your access to this vault?", outcome: expect.stringContaining("removed from your devices"),
    });
    expect(reduceAccessCopy({ kind: "everyone" }, "private").title).toBe("Set default access to Only what's shared?");
    expect(reduceAccessCopy({ kind: "everyone" }, "readonly").title).toBe("Set default access to Can view?");
    for (const to of ["private", "readonly"] as const) {
      const c = reduceAccessCopy({ kind: "everyone" }, to);
      expect(`${c.title} ${c.button} ${c.outcome}`).not.toMatch(/narrow|apply/i);
    }
  });
});

describe("roster patches after a write (#307)", () => {
  it("patches one member's level, the Everyone row and invitations", async () => {
    const m = await import("../membersAccess");
    const ov = {
      members: [
        { userId: "a", access: { level: "edit" } },
        { userId: "b", access: { level: "edit" } },
      ],
      invitations: [{ id: "i1", email: "x@y.z", role: "member", status: "pending", createdAt: null, expiresAt: null, access: null }],
    } as unknown as Parameters<typeof m.withMemberLevel>[0];
    const next = m.withMemberLevel(ov, "b", m.levelOfMode("private"));
    expect(next.members.map((x) => x.access?.level)).toEqual(["edit", "none"]);
    expect(m.withoutInvitation(ov, "i1").invitations).toEqual([]);
    const inv = m.withNewInvitations(
      ov,
      [{ email: "X@y.z", invitationId: "i2", emailed: true }, { email: "bad@y.z", emailed: false, error: "no" }],
      { role: "admin", access: "readonly" },
      "2026-10-05T00:00:00.000Z",
    );
    expect(inv.invitations.map((i) => i.id)).toEqual(["i2"]);
    const t = m.patchedTeamAccess({ mode: "open", posture: "edit", grantId: "g", overrides: [{} as never] }, "readonly");
    expect(t).toMatchObject({ mode: "readonly", posture: "view", overrides: [] });
  });
});

import { freshViewerRole, roleManages, withViewerRole } from "../membersAccess";

describe("the viewer's role follows the freshest authority", () => {
  const row = (userId: string, role: "owner" | "admin" | "member") => ({
    userId, memberId: `m-${userId}`, role, name: null, email: null, image: null, joinedAt: null, lastActiveAt: null,
  });
  it("the overview's own row beats a role the store learned at launch", () => {
    const ov = { members: [row("o", "owner"), row("me", "admin")], canManage: true };
    expect(freshViewerRole(ov, "me", "member")).toBe("admin");
    expect(roleManages(freshViewerRole(ov, "me", "member"))).toBe(true);
  });
  it("a demotion wins too, and a missing row falls back to the server's canManage", () => {
    expect(freshViewerRole({ members: [row("me", "member")], canManage: false }, "me", "admin")).toBe("member");
    expect(freshViewerRole({ members: [], canManage: false }, "me", "admin")).toBe("member");
    expect(freshViewerRole({ members: [], canManage: true }, "me", "admin")).toBe("admin");
  });
  it("before the overview answers, the store's role stands", () => {
    expect(freshViewerRole(null, "me", "member")).toBe("member");
    expect(roleManages("member")).toBe(false);
    expect(roleManages(undefined)).toBe(false);
  });
  it("withViewerRole patches only the viewer's row and keeps identity when unchanged", () => {
    const list = [
      { id: "1", organizationId: "org", userId: "me", role: "member" },
      { id: "2", organizationId: "org", userId: "x", role: "owner" },
    ];
    const next = withViewerRole(list, "org", "me", "admin");
    expect(next).not.toBe(list);
    expect(next.map((m) => m.role)).toEqual(["admin", "owner"]);
    expect(withViewerRole(next, "org", "me", "admin")).toBe(next);
    expect(withViewerRole([], "org", "me", "admin", "m-me")).toEqual([
      { id: "m-me", organizationId: "org", userId: "me", role: "admin" },
    ]);
  });
});

describe("where a person's access comes from", () => {
  const design = { name: "Design", summary: "Can edit Design" };
  it("starts at default access when there are no groups", () => {
    expect(accessSources({ level: "none", own: false, defaultLabel: "No access", groups: [] }))
      .toEqual({ short: "Default access", lines: ["Default access: No access."], sentence: "From default access (no access). Choosing a level here sets it just for them." });
  });
  it("names the groups that add something, and skips groups that give nothing", () => {
    const empty = { name: "Sales", summary: "No access yet" };
    expect(accessSources({ level: "custom", own: false, defaultLabel: "No access", groups: [design, empty] }))
      .toEqual({
        short: "Default + Design",
        lines: ["Default access: No access.", "Design group: Can edit Design."],
        sentence: "From default access (no access) and the Design group (can edit Design). Choosing a level here sets it just for them.",
      });
    const two = accessSources({ level: "custom", own: false, defaultLabel: "Can view", groups: [design, { name: "Ops", summary: "Can edit Ops" }] });
    expect(two.short).toBe("Default + 2 groups");
  });
  it("says a person's own setting replaces default access and groups", () => {
    expect(accessSources({ level: "view", own: true, defaultLabel: "No access", groups: [design] })).toEqual({
      short: "Set just for them",
      lines: ["Set just for them: Can view everything.", "Default access and access groups don't change this."],
      sentence: "Set just for them. Default access and access groups don't change it.",
    });
    expect(accessSources({ level: "edit", own: true, isSelf: true, defaultLabel: "No access", groups: [] }).lines)
      .toEqual(["Set just for you: Can edit everything.", "Default access doesn't change this."]);
  });
  it("explains a mixed level with no group behind it", () => {
    expect(accessSources({ level: "custom", own: false, defaultLabel: "Can edit", groups: [] })).toEqual({
      short: "Default, with changes",
      lines: ["Default access: Can edit.", "Some folders or notes are set differently for them."],
      sentence: "From default access (can edit), with some folders or notes set differently. Choosing a level here sets it just for them.",
    });
  });
});
