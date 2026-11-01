import { describe, expect, it } from "vitest";
import { conversionSafe } from "./conversionSafety";

describe("conversionSafe (zero data loss before converting)", () => {
  it("(a) another member with an account key is enough", () => {
    expect(conversionSafe({ otherMembersWithKeys: 1, hasPasswordWrap: false })).toBe(true);
    expect(conversionSafe({ otherMembersWithKeys: 3, hasPasswordWrap: false, approvedDevices: 1 })).toBe(true);
  });
  it("(b) a password wrap of the account key is enough", () => {
    expect(conversionSafe({ otherMembersWithKeys: 0, hasPasswordWrap: true, approvedDevices: 1 })).toBe(true);
  });
  it("(c) two or more approved computers are enough", () => {
    expect(conversionSafe({ otherMembersWithKeys: 0, hasPasswordWrap: false, approvedDevices: 2 })).toBe(true);
  });
  it("none of them: not yet", () => {
    expect(conversionSafe({ otherMembersWithKeys: 0, hasPasswordWrap: false, approvedDevices: 1 })).toBe(false);
  });
  it("unknown counts (older server) count as not met", () => {
    expect(conversionSafe({ hasPasswordWrap: false })).toBe(false);
    expect(conversionSafe({ otherMembersWithKeys: null, hasPasswordWrap: false, approvedDevices: null })).toBe(false);
  });
});
