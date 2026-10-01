import { describe, expect, it, vi } from "vitest";
import { parseServerControl } from "../sync/vaultProtocol";
import { hintUpdateAvailable, setUpdateHintHandler } from "../updateHint";

/**
 * #269: the server's `version-available` frame is parsed strictly and routed
 * to the app's updater as a hint — nothing more.
 */
describe("version-available hint", () => {
  it("parses a well-formed frame and ignores malformed ones", () => {
    expect(parseServerControl(JSON.stringify({ t: "version-available", version: "0.1.80" }))).toEqual({
      t: "version-available",
      version: "0.1.80",
    });
    expect(parseServerControl(JSON.stringify({ t: "version-available" }))).toBeNull();
    expect(parseServerControl(JSON.stringify({ t: "version-available", version: 7 }))).toBeNull();
    expect(
      parseServerControl(JSON.stringify({ t: "version-available", version: "x".repeat(200) })),
    ).toBeNull();
  });

  it("reaches the registered handler, and is a no-op without one", () => {
    const seen: string[] = [];
    setUpdateHintHandler((v) => seen.push(v));
    hintUpdateAvailable("0.1.80");
    setUpdateHintHandler(null);
    hintUpdateAvailable("0.1.81");
    expect(seen).toEqual(["0.1.80"]);
  });

  it("never lets a failing handler escape into the sync layer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setUpdateHintHandler(() => {
      throw new Error("boom");
    });
    expect(() => hintUpdateAvailable("0.1.80")).not.toThrow();
    setUpdateHintHandler(null);
    warn.mockRestore();
  });
});
