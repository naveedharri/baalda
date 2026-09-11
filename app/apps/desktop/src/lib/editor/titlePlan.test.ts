// The inline title commits a RENAME, so its validation is the last thing
// between a typed character and a filesystem call. Every refusal has to name
// itself — "that didn't work" over a filename is the worst possible feedback.
import { describe, expect, it } from "vitest";
import { planInlineTitleRename, TITLE_REFUSAL_MESSAGE } from "./titlePlan";

describe("planInlineTitleRename", () => {
  it("keeps the folder and the extension", () => {
    expect(planInlineTitleRename("Projects/Old.md", "New name")).toEqual({
      ok: true,
      nextPath: "Projects/New name.md",
      stem: "New name",
    });
    expect(planInlineTitleRename("Root.md", "Moved")).toMatchObject({
      nextPath: "Moved.md",
    });
    expect(planInlineTitleRename("Page.html", "Other")).toMatchObject({
      nextPath: "Other.html",
    });
  });

  it("trims surrounding space and a trailing dot", () => {
    expect(planInlineTitleRename("A.md", "  Spaced  ")).toMatchObject({
      nextPath: "Spaced.md",
    });
    // A trailing dot is illegal on Windows and invisible on macOS; nobody types
    // it on purpose, so it is the one thing trimmed rather than refused.
    expect(planInlineTitleRename("A.md", "Ends.")).toMatchObject({
      nextPath: "Ends.md",
    });
  });

  it("refuses an empty name", () => {
    expect(planInlineTitleRename("A.md", "   ")).toEqual({ ok: false, reason: "empty" });
    // `...` is caught one rule earlier, by the more specific message.
    expect(planInlineTitleRename("A.md", "...")).toEqual({
      ok: false,
      reason: "leading-dot",
    });
    expect(planInlineTitleRename("A.md", "x.")).toMatchObject({ nextPath: "x.md" });
  });

  it("refuses path separators and the rest of the unsafe set", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(planInlineTitleRename("A.md", bad)).toEqual({
        ok: false,
        reason: "illegal-chars",
      });
    }
  });

  it("refuses a leading dot — a dotfile is hidden from the vault", () => {
    expect(planInlineTitleRename("A.md", ".hidden")).toEqual({
      ok: false,
      reason: "leading-dot",
    });
  });

  it("refuses a name past the cap", () => {
    expect(planInlineTitleRename("A.md", "x".repeat(120))).toEqual({
      ok: false,
      reason: "too-long",
    });
    expect(planInlineTitleRename("A.md", "x".repeat(100))).toMatchObject({ ok: true });
  });

  it("reports an unchanged name as a silent no-op", () => {
    expect(planInlineTitleRename("Projects/Old.md", "Old")).toEqual({
      ok: false,
      reason: "unchanged",
    });
    expect(planInlineTitleRename("Projects/Old.md", "  Old  ")).toEqual({
      ok: false,
      reason: "unchanged",
    });
    // A case-only edit IS a change: macOS is case-insensitive but case-
    // preserving, so `Old` → `OLD` is a rename the user can see.
    expect(planInlineTitleRename("Projects/Old.md", "OLD")).toMatchObject({ ok: true });
    expect(TITLE_REFUSAL_MESSAGE.unchanged).toBe("");
  });

  it("has a message for every refusal a person can hit", () => {
    for (const reason of ["empty", "illegal-chars", "leading-dot", "too-long"] as const) {
      expect(TITLE_REFUSAL_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });
});
