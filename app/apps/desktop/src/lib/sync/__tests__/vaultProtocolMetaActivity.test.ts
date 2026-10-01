import { describe, expect, it } from "vitest";
import { parseServerControl } from "../vaultProtocol";

// #262 / #260: the two frames the server added so the desktop stops pulling
// the whole registry per stamped note and stops polling the Activity feed.
describe("parseServerControl — meta registry + activity frames", () => {
  it("keeps the meta flag on a stamp-only registry frame", () => {
    expect(parseServerControl(JSON.stringify({ t: "registry", meta: true }))).toEqual({
      t: "registry",
      meta: true,
    });
  });

  it("a plain registry frame (and any non-true meta) stays structural", () => {
    expect(parseServerControl(JSON.stringify({ t: "registry" }))).toEqual({ t: "registry" });
    expect(parseServerControl(JSON.stringify({ t: "registry", meta: "yes" }))).toEqual({ t: "registry" });
  });

  it("parses the activity frame", () => {
    expect(parseServerControl(JSON.stringify({ t: "activity" }))).toEqual({ t: "activity" });
  });
});
