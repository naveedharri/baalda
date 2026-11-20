import { describe, expect, it } from "vitest";
import {
  ROOT_FROZEN_MESSAGE,
  VIEW_ONLY_FOLDER_MESSAGE,
  VIEW_ONLY_ROOT_MESSAGE,
  createBlockReason,
} from "../createGate";

const base = {
  rootFrozen: false,
  syncEnabled: true,
  canCreateRoot: true as boolean | null,
  lockedForCaller: (_: string) => false,
};

describe("createBlockReason (#414)", () => {
  it("refuses a folder this person can only view", () => {
    const locked = new Set(["Kitchen"]);
    const r = createBlockReason({ ...base, dir: "Kitchen", lockedForCaller: (p) => locked.has(p) });
    expect(r).toBe(VIEW_ONLY_FOLDER_MESSAGE);
  });

  it("allows a folder that is not padlocked for them (a lifted folder in a view-only vault)", () => {
    const locked = new Set(["Kitchen"]);
    expect(
      createBlockReason({ ...base, dir: "Kitchen/Mine", lockedForCaller: (p) => locked.has(p) }),
    ).toBeNull();
  });

  it("refuses the top level only when the server said so", () => {
    expect(createBlockReason({ ...base, dir: "", canCreateRoot: false })).toBe(VIEW_ONLY_ROOT_MESSAGE);
    expect(createBlockReason({ ...base, dir: "", canCreateRoot: true })).toBeNull();
    // Unknown (not fetched yet, older server): allow, the server decides.
    expect(createBlockReason({ ...base, dir: "", canCreateRoot: null })).toBeNull();
  });

  it("keeps the frozen-root refusal, with sync on or off", () => {
    expect(createBlockReason({ ...base, dir: "", rootFrozen: true })).toBe(ROOT_FROZEN_MESSAGE);
    expect(createBlockReason({ ...base, dir: "", rootFrozen: true, syncEnabled: false })).toBe(
      ROOT_FROZEN_MESSAGE,
    );
    expect(createBlockReason({ ...base, dir: "Notes", rootFrozen: true })).toBeNull();
  });

  it("never refuses in a local folder (sync off)", () => {
    expect(
      createBlockReason({
        ...base,
        dir: "Kitchen",
        syncEnabled: false,
        canCreateRoot: false,
        lockedForCaller: () => true,
      }),
    ).toBeNull();
    expect(createBlockReason({ ...base, dir: "", syncEnabled: false, canCreateRoot: false })).toBeNull();
  });
});
