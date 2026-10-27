import { describe, expect, it } from "vitest";
import { publishNotes } from "../publishNotes";

const f = (path: string, sha256: string, executable = false) => ({ path, sha256, executable });

describe("publishNotes", () => {
  it("calls v1 the first version", () => {
    expect(publishNotes([f("SKILL.md", "a")], null)).toBe("First version");
  });

  it("names a few changed files, SKILL.md first", () => {
    const prev = [f("SKILL.md", "a"), f("scripts/run.py", "b"), f("old.md", "c")];
    const now = [f("scripts/run.py", "b2"), f("SKILL.md", "a2"), f("new.md", "d")];
    expect(publishNotes(now, prev)).toBe("Updated SKILL.md, scripts/run.py, added new.md, removed old.md");
  });

  it("counts when many changed", () => {
    const prev = [f("SKILL.md", "a")];
    const now = [f("SKILL.md", "a"), f("x1", "1"), f("x2", "2"), f("x3", "3")];
    expect(publishNotes(now, prev)).toBe("Added 3 files");
  });

  it("notices a permission-only change", () => {
    expect(publishNotes([f("run.sh", "a", true)], [f("run.sh", "a", false)])).toBe("Updated run.sh");
    expect(publishNotes([f("run.sh", "a")], [f("run.sh", "a")])).toBe("No file changes");
  });
});
