import { describe, expect, it } from "vitest";
import {
  checkFailure,
  chunk,
  frameTargetsMe,
  membershipLostNotice,
  orgIdsToCheck,
  removalsFromCheck,
} from "../membershipLost";

describe("membershipLostNotice", () => {
  it("names the vault and the reason", () => {
    expect(membershipLostNotice("Acme", "removed")).toBe(
      "You were removed from Acme. Its files were removed from this device.",
    );
    expect(membershipLostNotice("Acme", "left")).toBe(
      "You left Acme. Its files were removed from this device.",
    );
    expect(membershipLostNotice("  ", "left")).toContain("this vault");
  });
});

describe("frameTargetsMe", () => {
  it("acts only for the signed-in user", () => {
    expect(frameTargetsMe("u1", "u1")).toBe(true);
    expect(frameTargetsMe("u2", "u1")).toBe(false);
    expect(frameTargetsMe("u1", null)).toBe(false);
  });
});

describe("orgIdsToCheck", () => {
  it("asks only about known, bound, no-longer-listed vaults", () => {
    expect(
      orgIdsToCheck({
        ledger: ["a", "b", "c", "a"],
        bound: { a: "/v/a", b: "/v/b", z: "/v/z" },
        listed: ["b"],
      }),
    ).toEqual(["a"]);
  });
  it("never asks about a vault bound by someone else (not in the ledger)", () => {
    expect(orgIdsToCheck({ ledger: [], bound: { z: "/v/z" }, listed: [] })).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits at 200 by default", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `o${i}`);
    expect(chunk(ids).map((c) => c.length)).toEqual([200, 200, 50]);
  });
});

describe("removalsFromCheck", () => {
  it("only notMember ids we asked about count", () => {
    expect(
      removalsFromCheck(["a", "b", "c"], { member: ["a"], notMember: ["b", "x"], unknown: ["c"] }),
    ).toEqual(["b"]);
  });
  it("an id listed in notMember AND elsewhere is not a removal", () => {
    expect(removalsFromCheck(["a"], { member: [], notMember: ["a"], unknown: ["a"] })).toEqual([]);
  });
  it("a malformed body is never a removal", () => {
    expect(removalsFromCheck(["a"], null)).toEqual([]);
    expect(removalsFromCheck(["a"], { notMember: "a" })).toEqual([]);
    expect(removalsFromCheck(["a"], {})).toEqual([]);
  });
});

describe("checkFailure", () => {
  it("404 is unsupported, everything else skips", () => {
    expect(checkFailure(404)).toBe("unsupported");
    expect(checkFailure(403)).toBe("skip");
    expect(checkFailure(500)).toBe("skip");
    expect(checkFailure(null)).toBe("skip");
  });
});
