import { describe, expect, it } from "vitest";
import { seenIdsToStore, unseenInvitations } from "./inviteSeen";

describe("unseenInvitations", () => {
  it("flags ids that were never seen", () => {
    expect(unseenInvitations([{ id: "a" }, { id: "b" }], new Set(["a"]))).toEqual(["b"]);
  });

  it("flags nothing when every id was seen", () => {
    expect(unseenInvitations([{ id: "a" }], ["a", "z"])).toEqual([]);
  });

  it("treats an empty seen set as all new", () => {
    expect(unseenInvitations([{ id: "a" }, { id: "b" }], [])).toEqual(["a", "b"]);
  });
});

describe("seenIdsToStore", () => {
  it("prunes ids no longer in the list", () => {
    // "old" was accepted or declined; storing only current ids drops it.
    const stored = seenIdsToStore([{ id: "a" }, { id: "b" }]);
    expect(stored).toEqual(["a", "b"]);
    expect(stored).not.toContain("old");
    expect(unseenInvitations([{ id: "a" }, { id: "c" }], stored)).toEqual(["c"]);
  });
});
