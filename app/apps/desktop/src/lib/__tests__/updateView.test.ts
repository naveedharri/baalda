import { describe, expect, it } from "vitest";
import { menuUpdateView, updateView } from "../updateView";

describe("updateView", () => {
  it("reads progress as a whole percent", () => {
    const v = updateView({ phase: "downloading", version: "0.1.99", downloaded: 41, total: 66 }, "0.1.98");
    expect(v).toMatchObject({ tone: "busy", title: "Updating to 0.1.99", percent: 62, action: null });
  });

  it("offers Restart when ready and Try again after a failure", () => {
    expect(updateView({ phase: "ready", version: "0.1.99" }, "0.1.98").action).toBe("restart");
    expect(updateView({ phase: "failed", version: "0.1.99", message: "" }, "0.1.98")).toMatchObject({
      tone: "error",
      action: "retry",
      sub: "The download was interrupted. Try again later.",
    });
  });

  it("words an updater failure plainly, never with the raw error text", () => {
    const raw = "StartingBinary found current_exe() that contains a symlink on a non-allowed platform: /var";
    expect(updateView({ phase: "error", message: raw }, "0.1.114").sub).toBe("Couldn't check for updates. Try again later.");
    expect(updateView({ phase: "failed", version: "0.1.115", message: raw }, "0.1.114").sub).not.toContain("StartingBinary");
  });

  it("never shows an update error in the account menu either", () => {
    for (const s of [{ phase: "error", message: "offline" }, { phase: "failed", version: "0.1.99", message: "" }] as const) {
      const v = menuUpdateView(updateView(s, "0.1.98"));
      expect(v.tone).not.toBe("error");
      expect(v.sub).toBe("");
    }
    const ready = updateView({ phase: "ready", version: "0.1.99" }, "0.1.98");
    expect(menuUpdateView(ready)).toEqual(ready);
  });
});
