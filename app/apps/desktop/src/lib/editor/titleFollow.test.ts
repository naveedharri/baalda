import { describe, expect, it } from "vitest";
import { firstHeading, planTitleRename, sanitizeFileStem } from "./titleFollow";

describe("firstHeading", () => {
  it("reads a first-line H1", () => {
    expect(firstHeading("# Untitled")).toBe("Untitled");
    expect(firstHeading("#   Meeting notes  ")).toBe("Meeting notes");
    expect(firstHeading("# Closed #")).toBe("Closed");
  });
  it("ignores lower headings, body text and frontmatter", () => {
    expect(firstHeading("## Section")).toBeNull();
    expect(firstHeading("plain text")).toBeNull();
    expect(firstHeading("---")).toBeNull();
    expect(firstHeading("#")).toBeNull();
  });
});

describe("sanitizeFileStem", () => {
  it("drops filesystem-unsafe characters and tidies whitespace", () => {
    expect(sanitizeFileStem('Q3: plan / "draft"?')).toBe("Q3 plan draft");
    expect(sanitizeFileStem("  a   b  ")).toBe("a b");
  });
  it("refuses names that would hide or break the file", () => {
    expect(sanitizeFileStem(".hidden")).toBe("hidden");
    expect(sanitizeFileStem("trailing...")).toBe("trailing");
    expect(sanitizeFileStem("???")).toBeNull();
  });
});

describe("planTitleRename", () => {
  it("renames a note still named after its heading", () => {
    expect(
      planTitleRename({ path: "Untitled.md", lastHeading: "Untitled", heading: "Roadmap" }),
    ).toBe("Roadmap.md");
    expect(
      planTitleRename({
        path: "Work/Untitled 2.md",
        lastHeading: "Untitled 2",
        heading: "Q3: plan",
      }),
    ).toBe("Work/Q3 plan.md");
  });
  it("leaves a deliberately named file alone", () => {
    expect(
      planTitleRename({ path: "2026-09-08.md", lastHeading: "Standup", heading: "Retro" }),
    ).toBeNull();
  });
  it("does nothing when the heading is gone, unchanged or unusable", () => {
    expect(planTitleRename({ path: "Untitled.md", lastHeading: "Untitled", heading: null })).toBeNull();
    expect(
      planTitleRename({ path: "Untitled.md", lastHeading: "Untitled", heading: "Untitled" }),
    ).toBeNull();
    expect(planTitleRename({ path: "Untitled.md", lastHeading: "Untitled", heading: "???" })).toBeNull();
    expect(planTitleRename({ path: "Untitled.md", lastHeading: null, heading: "New" })).toBeNull();
  });
  it("keeps the file's own extension", () => {
    expect(planTitleRename({ path: "Page.html", lastHeading: "Page", heading: "Landing" })).toBe(
      "Landing.html",
    );
  });
});
