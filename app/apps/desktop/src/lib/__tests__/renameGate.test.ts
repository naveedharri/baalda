import { describe, expect, it } from "vitest";
import { renameBlockReason, renameRefusedMessage } from "../renameGate";

const base = {
  syncEnabled: true,
  rootFrozen: false,
  canCreateRoot: true as boolean | null,
};

describe("renameBlockReason", () => {
  it("refuses renaming a folder this person can only view", () => {
    const why = renameBlockReason({ ...base, path: "Team/Plans", isDir: true, lockedForCaller: (p) => p === "Team/Plans" });
    expect(why).toMatch(/only view the folder Plans/);
  });

  it("refuses a note under a view-only folder (the padlock is inherited by the caller)", () => {
    const why = renameBlockReason({ ...base, path: "Team/a.md", isDir: false, lockedForCaller: () => true });
    expect(why).toMatch(/only view a,/);
  });

  it("allows an editable item, and anything in a local-only vault", () => {
    expect(renameBlockReason({ ...base, path: "Mine", isDir: true, lockedForCaller: () => false })).toBeNull();
    expect(renameBlockReason({ ...base, syncEnabled: false, path: "X", isDir: true, lockedForCaller: () => true })).toBeNull();
  });

  it("refuses a move INTO a folder this person can't add to", () => {
    const why = renameBlockReason({
      ...base,
      path: "Mine/n.md",
      isDir: false,
      destDir: "Locked",
      lockedForCaller: (p) => p === "Locked",
    });
    expect(why).toMatch(/can't add to it/);
  });

  it("a plain rename in place is not judged as a move", () => {
    expect(
      renameBlockReason({ ...base, path: "Locked/n.md", isDir: false, destDir: "Locked", lockedForCaller: (p) => p === "Locked/n.md" ? false : p === "Locked" }),
    ).toBeNull();
  });
});

describe("renameBlockReason: creator rule", () => {
  const open = { ...base, path: "Shared/n.md", isDir: false, lockedForCaller: () => false };
  it("a plain member can't rename what someone else created", () => {
    expect(renameBlockReason({ ...open, role: "member", authoredByMe: () => false })).toMatch(/Only the person who created this/);
    expect(renameBlockReason({ ...open, role: "member", authoredByMe: () => true })).toBeNull();
  });
  it("owners and admins rename anything; an unknown role is left to the server", () => {
    expect(renameBlockReason({ ...open, role: "owner", authoredByMe: () => false })).toBeNull();
    expect(renameBlockReason({ ...open, role: "admin", authoredByMe: () => false })).toBeNull();
    expect(renameBlockReason({ ...open, role: null, authoredByMe: () => false })).toBeNull();
  });
});

describe("renameRefusedMessage", () => {
  it("names the creator rule and a taken name", () => {
    expect(renameRefusedMessage("Plans", true, "rename_not_creator", 403)).toMatch(/Only the person who created Plans/);
    expect(renameRefusedMessage("Plans", true, null, 409)).toMatch(/already exists/);
  });

  it("says the name was put back", () => {
    expect(renameRefusedMessage("Team/Plans", true, "no_write_access")).toBe(
      "You can only view the folder Plans, so it can't be renamed or moved. Its name was put back.",
    );
    expect(renameRefusedMessage("a.md", false, null)).toBe("You can only view a, so it can't be renamed or moved. Its name was put back.");
  });
});
