import { describe, expect, it } from "vitest";
import {
  autoRestoredNoticeText,
  isInsideVaultsRoot,
  planMissingFolder,
  reboundToastText,
} from "../missingFolder";

const root = "/Users/me/Documents/Baalda Vaults";

describe("planMissingFolder", () => {
  it("recreates a folder that lived inside the vaults root", () => {
    expect(planMissingFolder({ path: `${root}/Hello 4`, root, stampMatches: null })).toEqual({
      kind: "recreate",
    });
  });

  it("asks for a folder outside the vaults root", () => {
    expect(
      planMissingFolder({ path: "/Volumes/USB/Notes", root, stampMatches: null }),
    ).toEqual({ kind: "ask" });
  });

  it("rebinds to another folder carrying this vault's stamp", () => {
    expect(
      planMissingFolder({ path: `${root}/Hello 4`, root, stampMatches: `${root}/Hello Renamed` }),
    ).toEqual({ kind: "rebind", path: `${root}/Hello Renamed` });
    // Outside the root too: the stamp proves it is this vault.
    expect(
      planMissingFolder({ path: "/Volumes/USB/Notes", root, stampMatches: "/Users/me/Notes" }),
    ).toEqual({ kind: "rebind", path: "/Users/me/Notes" });
  });

  it("asks when the missing path is the vaults root itself", () => {
    expect(planMissingFolder({ path: root, root, stampMatches: null })).toEqual({ kind: "ask" });
    expect(planMissingFolder({ path: `${root}/`, root, stampMatches: null })).toEqual({
      kind: "ask",
    });
  });

  it("compares paths case-insensitively and normalised", () => {
    expect(
      planMissingFolder({
        path: "/users/ME/documents/baalda vaults/Hello 4/",
        root: `${root}/`,
        stampMatches: null,
      }),
    ).toEqual({ kind: "recreate" });
    expect(isInsideVaultsRoot("C:\\Users\\Me\\Baalda Vaults\\A", "c:/users/me/baalda vaults")).toBe(
      true,
    );
  });

  it("asks when the root is unknown or the vault cannot sync down", () => {
    expect(planMissingFolder({ path: `${root}/A`, root: null, stampMatches: null })).toEqual({
      kind: "ask",
    });
    expect(
      planMissingFolder({ path: `${root}/A`, root, stampMatches: null, canSync: false }),
    ).toEqual({ kind: "ask" });
  });

  it("does not treat a sibling with the same prefix, or an escape, as inside", () => {
    expect(isInsideVaultsRoot(`${root} Old/A`, root)).toBe(false);
    expect(isInsideVaultsRoot(`${root}/../A`, root)).toBe(false);
  });

  it("ignores a stamp match that is the missing path itself", () => {
    expect(
      planMissingFolder({ path: `${root}/A`, root, stampMatches: `${root}/a` }),
    ).toEqual({ kind: "recreate" });
  });
});

describe("copy", () => {
  it("says what happened", () => {
    expect(autoRestoredNoticeText("Hello 4")).toBe(
      "Hello 4's folder was missing, so Baalda restored it in Baalda Vaults and is syncing it.",
    );
    expect(reboundToastText("Hello 4", `${root}/Hello Renamed/`)).toBe(
      "Hello 4 moved to Hello Renamed.",
    );
  });
});
