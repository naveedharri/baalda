import { describe, expect, it } from "vitest";
import {
  PRESENCE_PALETTE,
  colorForUser,
  hashString,
  presenceUser,
  ringShowsColor,
  statusTone,
} from "../color";

describe("presence color mapping (spec 04 §5)", () => {
  it("is deterministic for a given user id", () => {
    expect(colorForUser("user-abc")).toBe(colorForUser("user-abc"));
    expect(colorForUser("user-xyz")).toBe(colorForUser("user-xyz"));
  });

  it("always returns a palette color", () => {
    for (const id of ["a", "b", "c", "long-user-id-123", "0", ""]) {
      expect(PRESENCE_PALETTE as readonly string[]).toContain(colorForUser(id));
    }
  });

  it("different ids generally map to different colors", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `user-${i}`);
    const colors = new Set(ids.map(colorForUser));
    // Not a perfect hash, but the spread should be wide across a small sample.
    expect(colors.size).toBeGreaterThan(4);
  });

  it("hashString is stable and unsigned", () => {
    const h = hashString("hello");
    expect(h).toBe(hashString("hello"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });

  it("presenceUser bundles id, name, and a deterministic color", () => {
    const u = presenceUser("user-abc", "Ada");
    expect(u).toEqual({ id: "user-abc", name: "Ada", color: colorForUser("user-abc") });
  });

  it("presenceUser carries the chosen status when one is set", () => {
    expect(presenceUser("u", "Ada", "away").status).toBe("away");
    expect(presenceUser("u", "Ada").status).toBeUndefined();
  });
});

describe("availability tone mapping", () => {
  it("folds each activity status to a tone", () => {
    expect(statusTone("online")).toBe("online");
    expect(statusTone("away")).toBe("away");
    expect(statusTone("busy")).toBe("busy");
    // Invisible reads as offline to teammates.
    expect(statusTone("invisible")).toBe("offline");
  });

  it("treats an absent status as present", () => {
    expect(statusTone(undefined)).toBe("online");
  });

  it("shows a coloured ring only for present tones", () => {
    expect(ringShowsColor("online")).toBe(true);
    expect(ringShowsColor("busy")).toBe(true);
    expect(ringShowsColor("away")).toBe(false);
    expect(ringShowsColor("offline")).toBe(false);
  });
});
