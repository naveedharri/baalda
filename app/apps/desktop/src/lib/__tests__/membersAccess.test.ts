import { describe, expect, it } from "vitest";
import {
  countLine,
  everyoneLabel,
  filterPeople,
  invitationAccessLabel,
  isNarrowing,
  isValidEmail,
  tickGrantMode,
  reduceAccessCopy,
  lastActiveLabel,
  splitEmails,
} from "../membersAccess";
import { addChips } from "../../components/InvitePeopleDialog";

describe("members and access rules", () => {
  it("only a narrowing asks for confirmation", () => {
    expect(isNarrowing("open", "readonly")).toBe(true);
    expect(isNarrowing("readonly", "private")).toBe(true);
    expect(isNarrowing("private", "open")).toBe(false);
    expect(isNarrowing("readonly", "open")).toBe(false);
    // Unknown or custom: anything short of edit may take something away.
    expect(isNarrowing(null, "readonly")).toBe(true);
    expect(isNarrowing("custom", "open")).toBe(false);
  });

  it("a never-shared vault reads as No access and says authors keep their notes", () => {
    expect(everyoneLabel("private", "none")).toEqual({ label: "No access", sub: "Members keep notes they wrote" });
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
  it("admin: members and themselves only", () => {
    expect(canSetMemberAccess(args("admin", { userId: "me", role: "admin" }))).toBe(true);
    expect(canSetMemberAccess(args("admin", { userId: "m", role: "member" }))).toBe(true);
    expect(canSetMemberAccess(args("admin", { userId: "a", role: "admin" }))).toBe(false);
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
    expect(reduceAccessCopy({ kind: "everyone" }, "private").title).toBe("Set everyone to No access?");
    expect(reduceAccessCopy({ kind: "everyone" }, "readonly").title).toBe("Make the vault view only for everyone?");
    for (const to of ["private", "readonly"] as const) {
      const c = reduceAccessCopy({ kind: "everyone" }, to);
      expect(`${c.title} ${c.button} ${c.outcome}`).not.toMatch(/narrow|apply/i);
    }
  });
});
