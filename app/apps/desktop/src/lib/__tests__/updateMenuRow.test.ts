import { describe, expect, it } from "vitest";
import { isUpdateBusy, updateCheckToast, updateRowHint } from "../updateMenuRow";

describe("updateRowHint", () => {
  it("shows the running version when the updater has nothing to say", () => {
    expect(updateRowHint({ phase: "idle" }, "0.1.81")).toBe("0.1.81");
    expect(updateRowHint({ phase: "uptodate" }, "0.1.81-staging.42")).toBe("0.1.81-staging.42");
    expect(updateRowHint({ phase: "error", message: "offline" }, "0.1.81")).toBe("0.1.81");
    expect(updateRowHint({ phase: "idle" }, null)).toBe("…");
  });

  it("names a running check, an install, a pending release and a held restart", () => {
    expect(updateRowHint({ phase: "checking" }, "0.1.81")).toBe("Checking…");
    expect(updateRowHint({ phase: "downloading", version: "0.1.82", downloaded: 1, total: 2 }, "0.1.81")).toBe(
      "Updating…",
    );
    expect(updateRowHint({ phase: "pending", version: "0.1.82" }, "0.1.81")).toBe("Update on its way");
    expect(updateRowHint({ phase: "ready", version: "0.1.82" }, "0.1.81")).toBe("Restart to update");
  });
});

describe("updateCheckToast", () => {
  it("words each settled outcome like About's status line", () => {
    expect(updateCheckToast({ phase: "uptodate" })).toEqual({
      text: "You're on the latest version.",
      tone: "success",
    });
    expect(updateCheckToast({ phase: "pending", version: "0.1.82" })).toEqual({
      text: "An update is on its way.",
      tone: "neutral",
    });
    expect(updateCheckToast({ phase: "available", version: "0.1.82" })?.text).toBe(
      "Version 0.1.82 found — starting the download…",
    );
    expect(updateCheckToast({ phase: "error", message: "offline" })).toEqual({
      text: "Couldn't check for updates: offline",
      tone: "error",
    });
    expect(updateCheckToast({ phase: "idle" })).toBeNull();
  });
});

describe("isUpdateBusy", () => {
  it("matches the phases in which About disables its button", () => {
    expect(isUpdateBusy({ phase: "checking" })).toBe(true);
    expect(isUpdateBusy({ phase: "ready", version: "0.1.82" })).toBe(true);
    expect(isUpdateBusy({ phase: "pending", version: "0.1.82" })).toBe(false);
    expect(isUpdateBusy({ phase: "uptodate" })).toBe(false);
  });
});
