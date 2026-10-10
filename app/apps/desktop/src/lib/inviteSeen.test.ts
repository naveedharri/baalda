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

describe("onSeenInvitationsChanged", () => {
  it("hears every seen-set write, so all surfaces settle together", async () => {
    const { onSeenInvitationsChanged, saveSeenInvitations } = await import("./inviteSeen");
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = new EventTarget();
    try {
      const heard: string[][] = [];
      const off = onSeenInvitationsChanged((ids) => heard.push([...ids]));
      saveSeenInvitations([{ id: "a" }, { id: "b" }]);
      off();
      saveSeenInvitations([{ id: "c" }]);
      expect(heard).toEqual([["a", "b"]]);
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});
