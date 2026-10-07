import { describe, expect, it } from "vitest";
import {
  classifyLocalFolder,
  filterRecentsForWelcome,
  hiddenForeignFootnote,
  visibleFolders,
  welcomeShowsFolder,
  type LocalFolderClass,
} from "../vaultList";
import { planTurnOnSync } from "../turnOnSync";

const stamps: Record<string, { organizationId: string | null } | null> = {
  "/v/mine": { organizationId: "org-a" },
  "/v/theirs": { organizationId: "org-x" },
  "/v/plain": null,
  "/v/legacy": { organizationId: null },
};
const lookup = (p: string) => (p in stamps ? stamps[p] : undefined);
const members = new Set(["org-a", "org-b"]);

describe("classifyLocalFolder", () => {
  it("stamped for a vault the account is a member of is member", () => {
    expect(classifyLocalFolder({ path: "/v/mine" }, members, lookup)).toBe("member");
  });
  it("stamped for a vault the account is not in is foreign", () => {
    expect(classifyLocalFolder({ path: "/v/theirs" }, members, lookup)).toBe("foreign");
  });
  it("no stamp is local", () => {
    expect(classifyLocalFolder({ path: "/v/plain" }, members, lookup)).toBe("local");
  });
  it("a stamp without organizationId is local", () => {
    expect(classifyLocalFolder({ path: "/v/legacy" }, members, lookup)).toBe("local");
  });
  it("an unknown or unreadable stamp is local, never hidden", () => {
    expect(classifyLocalFolder({ path: "/v/unread" }, members, lookup)).toBe("local");
    expect(classifyLocalFolder({ path: "/v/theirs" }, members, () => undefined)).toBe("local");
  });
  it("accepts an array of member ids", () => {
    expect(classifyLocalFolder({ path: "/v/mine" }, ["org-a"], lookup)).toBe("member");
    expect(classifyLocalFolder({ path: "/v/mine" }, [], lookup)).toBe("foreign");
  });
  it("a binding to a member vault does not rescue a foreign stamp", () => {
    expect(
      classifyLocalFolder({ path: "/v/theirs" }, members, lookup, { "org-a": "/v/theirs" }),
    ).toBe("foreign");
  });
  it("agrees with planTurnOnSync on blocked-foreign", () => {
    const plan = planTurnOnSync({
      openPath: "/v/theirs",
      activeOrganizationId: null,
      orgIds: [...members],
      orgVaults: {},
      stampedOrgId: "org-x",
    });
    expect(plan.kind).toBe("blocked-foreign");
  });
});

describe("hiddenForeignFootnote", () => {
  it("is null for none and pluralises", () => {
    expect(hiddenForeignFootnote(0)).toBeNull();
    expect(hiddenForeignFootnote(1)).toBe("1 folder synced with another account isn't shown.");
    expect(hiddenForeignFootnote(3)).toBe("3 folders synced with another account aren't shown.");
  });
});

describe("welcome screen recents", () => {
  const recents = [
    { path: "/v/mine" },
    { path: "/v/theirs" },
    { path: "/v/plain" },
    { path: "/v/pending" },
  ];
  const classify = (memberIds: string[]) =>
    new Map<string, LocalFolderClass>(
      recents
        .filter((r) => r.path !== "/v/pending")
        .map((r) => [r.path, classifyLocalFolder(r, memberIds, lookup)]),
    );

  it("signed in shows member and local folders, hides foreign ones", () => {
    expect(filterRecentsForWelcome(recents, classify(["org-a"]), true).map((r) => r.path)).toEqual([
      "/v/mine",
      "/v/plain",
    ]);
  });
  it("signed out shows only local folders, no synced folder at all", () => {
    // Signed out there are no member vaults, so every stamped folder is foreign.
    expect(filterRecentsForWelcome(recents, classify([]), false).map((r) => r.path)).toEqual([
      "/v/plain",
    ]);
    // Even a folder still classed member (stale classes) is hidden signed out.
    expect(filterRecentsForWelcome(recents, classify(["org-a"]), false).map((r) => r.path)).toEqual(
      ["/v/plain"],
    );
  });
  it("an unsettled folder is never shown", () => {
    expect(welcomeShowsFolder(undefined, true)).toBe(false);
    expect(welcomeShowsFolder(undefined, false)).toBe(false);
  });
  it("signed out with no local folders lists nothing", () => {
    const only = [{ path: "/v/mine" }, { path: "/v/theirs" }];
    expect(filterRecentsForWelcome(only, classify([]), false)).toEqual([]);
  });
});

describe("visibleFolders", () => {
  const rows = [{ path: "/a" }, { path: "/b" }, { path: "/c" }, { path: "/d" }];
  const classes = new Map([
    ["/a", "local" as const],
    ["/b", "member" as const],
    ["/c", "foreign" as const],
  ]); // "/d" unresolved

  it("keeps only local folders, in order", () => {
    expect(visibleFolders(rows, classes).map((r) => r.path)).toEqual(["/a"]);
  });
  it("hides an unresolved folder until its class settles", () => {
    expect(visibleFolders(rows, classes).some((r) => r.path === "/d")).toBe(false);
  });
  it("always keeps the open vault, whatever its class", () => {
    expect(visibleFolders(rows, classes, "/c").map((r) => r.path)).toEqual(["/a", "/c"]);
    expect(visibleFolders(rows, classes, "/d").map((r) => r.path)).toEqual(["/a", "/d"]);
  });
  it("signed out, every stamped folder is foreign and hidden", () => {
    const out = new Map(
      ["/v/mine", "/v/plain"].map((p) => [
        p,
        classifyLocalFolder({ path: p }, [], (q) =>
          q === "/v/mine" ? { organizationId: "org-a" } : null,
        ),
      ]),
    );
    expect(visibleFolders([{ path: "/v/mine" }, { path: "/v/plain" }], out).map((r) => r.path))
      .toEqual(["/v/plain"]);
  });
});
