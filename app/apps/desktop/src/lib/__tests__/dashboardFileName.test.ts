import { describe, expect, it } from "vitest";
import { fileNameFromTitle } from "../../components/HomeDashboardDialog";
import { DASHBOARD_TEMPLATES } from "../dashboard/templates";

describe("fileNameFromTitle", () => {
  it("turns a template title into a name every file system accepts", () => {
    expect(fileNameFromTitle("Orbit: Agentic OS")).toBe("Orbit - Agentic OS");
    expect(fileNameFromTitle("Sales / Pipeline?")).toBe("Sales Pipeline");
    expect(fileNameFromTitle("  .hidden.  ")).toBe("hidden");
    expect(fileNameFromTitle(":")).toBe("-");
    expect(fileNameFromTitle("***")).toBe("Dashboard");
  });
  it("gives every built-in template a valid default name", () => {
    for (const t of DASHBOARD_TEMPLATES) {
      const n = fileNameFromTitle(t.name);
      expect(n, t.name).not.toMatch(/[\\/:*?"<>|\x00-\x1f]/);
      expect(n.startsWith("."), t.name).toBe(false);
    }
  });
});
