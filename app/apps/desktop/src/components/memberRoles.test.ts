import { describe, expect, it } from "vitest";
import { assignableRoles, canActOnMember } from "./memberRoles";

const ME = "user-me";
const THEM = "user-them";

function args(myRole: string | undefined, targetRole: string, opts?: { self?: boolean; canManage?: boolean }) {
  return {
    canManage: opts?.canManage ?? (myRole === "owner" || myRole === "admin"),
    myUserId: ME,
    myRole,
    target: { userId: opts?.self ? ME : THEM, role: targetRole },
  };
}

describe("canActOnMember / assignableRoles", () => {
  it("owner may act on admins and members", () => {
    expect(canActOnMember(args("owner", "member"))).toBe(true);
    expect(canActOnMember(args("owner", "admin"))).toBe(true);
    expect(assignableRoles(args("owner", "admin"))).toEqual(["member", "admin"]);
  });

  it("nobody acts on the owner or on themselves", () => {
    expect(canActOnMember(args("owner", "owner"))).toBe(false);
    expect(canActOnMember(args("admin", "owner"))).toBe(false);
    expect(canActOnMember(args("owner", "owner", { self: true }))).toBe(false);
    expect(canActOnMember(args("admin", "admin", { self: true }))).toBe(false);
  });

  it("admin may act on plain members only (promote allowed, admins off-limits)", () => {
    expect(canActOnMember(args("admin", "member"))).toBe(true);
    expect(assignableRoles(args("admin", "member"))).toEqual(["member", "admin"]);
    expect(canActOnMember(args("admin", "admin"))).toBe(false);
    expect(assignableRoles(args("admin", "admin"))).toEqual([]);
  });

  it("plain members and signed-out callers get nothing", () => {
    expect(canActOnMember(args("member", "member"))).toBe(false);
    expect(canActOnMember(args(undefined, "member"))).toBe(false);
    // canManage=false wins even if a stale role claims otherwise.
    expect(canActOnMember(args("owner", "member", { canManage: false }))).toBe(false);
  });
});
