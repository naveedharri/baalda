import { describe, expect, it } from "vitest";
import { parseServerControl } from "../vaultProtocol";

// docs/SKILLS.md §3.4: the frame only says "refetch the manifest" for one vault.
describe("parseServerControl — skills-changed", () => {
  it("parses the frame with its orgId", () => {
    expect(parseServerControl(JSON.stringify({ t: "skills-changed", orgId: "org-1" }))).toEqual({
      t: "skills-changed",
      orgId: "org-1",
    });
  });

  it("rejects a frame without a usable orgId", () => {
    expect(parseServerControl(JSON.stringify({ t: "skills-changed" }))).toBeNull();
    expect(parseServerControl(JSON.stringify({ t: "skills-changed", orgId: "" }))).toBeNull();
    expect(parseServerControl(JSON.stringify({ t: "skills-changed", orgId: 7 }))).toBeNull();
  });
});
