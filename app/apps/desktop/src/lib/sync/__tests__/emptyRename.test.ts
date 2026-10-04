// A renamed EMPTY note pairs only as the window's unique empty pair.
import { describe, expect, it } from "vitest";
import { EMPTY_SHA256, pickUniqueEmptyRename } from "../emptyRename";

const shas = (m: Record<string, string | null>) => (p: string) => m[p];

describe("pickUniqueEmptyRename", () => {
  it("pairs one empty delete with one empty create in the same folder", () => {
    const sha = shas({ "Projects/New name.md": EMPTY_SHA256 });
    expect(pickUniqueEmptyRename("Projects/Untitled.md", 1, ["Projects/New name.md"], sha)).toBe(
      "Projects/New name.md",
    );
  });

  it("pairs a move to another folder when the basename is kept", () => {
    const sha = shas({ "Archive/Untitled.md": EMPTY_SHA256 });
    expect(pickUniqueEmptyRename("Projects/Untitled.md", 1, ["Archive/Untitled.md"], sha)).toBe(
      "Archive/Untitled.md",
    );
  });

  it("does not pair across folders under a different name", () => {
    const sha = shas({ "Archive/Other.md": EMPTY_SHA256 });
    expect(pickUniqueEmptyRename("Projects/Untitled.md", 1, ["Archive/Other.md"], sha)).toBeNull();
  });

  it("two empty deletes and two empty creates do not pair", () => {
    const sha = shas({ "a/x.md": EMPTY_SHA256, "a/y.md": EMPTY_SHA256 });
    expect(pickUniqueEmptyRename("a/p.md", 2, ["a/x.md", "a/y.md"], sha)).toBeNull();
    // …nor does one delete facing two empty candidates.
    expect(pickUniqueEmptyRename("a/p.md", 1, ["a/x.md", "a/y.md"], sha)).toBeNull();
  });

  it("ignores candidates with content or no indexed hash", () => {
    const sha = shas({ "a/x.md": "abc", "a/y.md": null, "a/z.md": EMPTY_SHA256 });
    expect(pickUniqueEmptyRename("a/p.md", 1, ["a/x.md", "a/y.md", "a/z.md"], sha)).toBe("a/z.md");
    expect(pickUniqueEmptyRename("a/p.md", 1, ["a/x.md", "a/y.md"], sha)).toBeNull();
  });
});
