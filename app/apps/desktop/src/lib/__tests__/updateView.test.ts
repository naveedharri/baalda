import { describe, expect, it } from "vitest";
import { showsSidebarUpdateLine, updateView } from "../updateView";

describe("updateView", () => {
  it("reads progress as a whole percent and hides the sidebar line when up to date", () => {
    const v = updateView({ phase: "downloading", version: "0.1.99", downloaded: 41, total: 66 }, "0.1.98");
    expect(v).toMatchObject({ tone: "busy", title: "Updating to 0.1.99", percent: 62, action: null });
    expect(showsSidebarUpdateLine(v)).toBe(true);
    expect(showsSidebarUpdateLine(updateView({ phase: "uptodate" }, "0.1.98"))).toBe(false);
  });

  it("offers Restart when ready and Try again after a failure", () => {
    expect(updateView({ phase: "ready", version: "0.1.99" }, "0.1.98").action).toBe("restart");
    expect(updateView({ phase: "failed", version: "0.1.99", message: "" }, "0.1.98")).toMatchObject({
      tone: "error",
      action: "retry",
      sub: "The download was interrupted",
    });
  });
});
