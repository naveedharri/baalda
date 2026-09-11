// The one label rule (src/lib/notePath.ts). `sanitizeFileStem`'s cases are
// inherited from the retired `lib/editor/titleFollow.test.ts`.
import { describe, expect, it } from "vitest";
import { displayName, noteLabel, sanitizeFileStem, stemOf } from "../notePath";

describe("stemOf", () => {
  it("drops the directory and the extension", () => {
    expect(stemOf("Notes/Untitled.md")).toBe("Untitled");
    expect(stemOf("a.md")).toBe("a");
    expect(stemOf("Page.html")).toBe("Page");
  });
  it("leaves a name with no extension alone", () => {
    expect(stemOf("Work/README")).toBe("README");
  });
});

describe("noteLabel", () => {
  it("hides a note or page extension", () => {
    expect(noteLabel("Work/Q3 plan.md")).toBe("Q3 plan");
    expect(noteLabel("index.html")).toBe("index");
    expect(noteLabel("legacy.HTM")).toBe("legacy");
  });
  it("keeps every other extension — it is how two previews tell apart", () => {
    expect(noteLabel("Papers/spec.pdf")).toBe("spec.pdf");
    expect(noteLabel("shot.png")).toBe("shot.png");
  });
  it("keeps dots inside the stem", () => {
    expect(noteLabel("Daily/2026.09.11 notes.md")).toBe("2026.09.11 notes");
  });
  it("handles a name with no extension at all", () => {
    expect(noteLabel("Work/LICENSE")).toBe("LICENSE");
  });
});

describe("displayName", () => {
  it("is noteLabel's name-level twin and never strips a folder's dots", () => {
    expect(displayName("Q3 plan.md", false)).toBe("Q3 plan");
    expect(displayName("v1.2", true)).toBe("v1.2");
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
