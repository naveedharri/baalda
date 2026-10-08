import { describe, expect, it } from "vitest";
import { canManageMemberAccess } from "../membersAccess";

const ROLES = ["owner", "admin", "member"] as const;

// viewer → target → [other person, self]. "Self" with a different role is
// impossible (an admin is never the owner); it follows the self rule.
const EXPECTED: Record<string, Record<string, [boolean, boolean]>> = {
  owner: { owner: [true, true], admin: [true, true], member: [true, true] },
  admin: { owner: [false, true], admin: [false, true], member: [true, true] },
  member: { owner: [false, false], admin: [false, false], member: [false, false] },
};

describe("canManageMemberAccess", () => {
  for (const viewer of ROLES) {
    for (const target of ROLES) {
      it(`${viewer} → ${target}`, () => {
        const [other, self] = EXPECTED[viewer][target];
        expect(canManageMemberAccess(viewer, target, false)).toBe(other);
        expect(canManageMemberAccess(viewer, target, true)).toBe(self);
      });
    }
  }

  it("unknown roles manage nobody", () => {
    expect(canManageMemberAccess(undefined, "member", false)).toBe(false);
    expect(canManageMemberAccess(null, "member", true)).toBe(false);
  });
});
