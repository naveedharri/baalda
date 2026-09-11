import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/locks` reaches the registry for id↔path, and the registry lives on the
// sync manager — a module that drags in Tauri IPC. Only the two lookups matter
// here, so the whole module is a stub.
const folderIds = new Map<string, string>();
const noteIds = new Map<string, string>();
vi.mock("../sync/docSession", () => ({
  syncManager: {
    registry: {
      getFolderId: (path: string) => folderIds.get(path) ?? null,
      getMapping: (path: string) => {
        const docId = noteIds.get(path);
        return docId ? { docId } : null;
      },
    },
  },
}));

import type { Share } from "../api";
import type { TreeNode } from "../ipc";
import {
  effectiveLockForPath,
  hasVaultLock,
  itemLockRows,
  LOCK_TITLES,
  lockScopesByPath,
} from "../locks";

const dir = (path: string, children: TreeNode[] = []): TreeNode =>
  ({ path, name: path.split("/").pop()!, isDir: true, children }) as TreeNode;
const file = (path: string): TreeNode =>
  ({ path, name: path.split("/").pop()!, isDir: false }) as TreeNode;

/**
 * Projects/          folder "f-projects"
 *   Deep/            folder "f-deep"
 *     buried.md      note   "n-buried"
 *   alpha.md         note   "n-alpha"
 * loose.md           note   "n-loose"
 */
const tree: TreeNode = dir("", [
  dir("Projects", [dir("Projects/Deep", [file("Projects/Deep/buried.md")]), file("Projects/alpha.md")]),
  file("loose.md"),
]);

const ALL_PATHS = [
  "Projects",
  "Projects/Deep",
  "Projects/Deep/buried.md",
  "Projects/alpha.md",
  "loose.md",
];

const share = (s: Partial<Share>): Share =>
  ({ id: "s1", principalType: "org", permission: "locked", ...s }) as Share;

/** The whole-vault Read-only posture as `GET /vaults/:id/locks` reports it. */
const vaultLock = (): Share =>
  share({
    id: "posture",
    resourceType: "vault",
    resourceId: "org-1",
    principalType: "org",
    principalId: "org-1",
    permission: "locked",
  });

/** An `edit` row that lifts the Read-only posture — org-wide or for one user. */
const lift = (
  resourceType: "folder" | "file",
  resourceId: string,
  principal: { type: "org" | "user"; id: string },
): Share =>
  share({
    id: `lift-${resourceId}`,
    resourceType,
    resourceId,
    principalType: principal.type,
    principalId: principal.id,
    permission: "edit",
  });

beforeEach(() => {
  folderIds.clear();
  noteIds.clear();
  folderIds.set("Projects", "f-projects");
  folderIds.set("Projects/Deep", "f-deep");
  noteIds.set("Projects/Deep/buried.md", "n-buried");
  noteIds.set("Projects/alpha.md", "n-alpha");
  noteIds.set("loose.md", "n-loose");
});

describe("itemLockRows", () => {
  it("drops the vault posture and keeps every item row", () => {
    const folderLock = share({ resourceType: "folder", resourceId: "f-projects" });
    expect(itemLockRows([vaultLock(), folderLock])).toEqual([folderLock]);
    expect(itemLockRows([vaultLock()])).toEqual([]);
    expect(itemLockRows([folderLock])).toEqual([folderLock]);
  });
});

describe("hasVaultLock", () => {
  it("is false for item rows and true once the posture row appears", () => {
    expect(hasVaultLock([share({ resourceType: "folder", resourceId: "f-projects" })])).toBe(false);
    expect(hasVaultLock([vaultLock()])).toBe(true);
  });
});

describe("lockScopesByPath", () => {
  it("maps an item lock to exactly its own path", () => {
    const map = lockScopesByPath(tree, [share({ resourceType: "folder", resourceId: "f-projects" })], "u1");
    expect(map.get("Projects")).toBe("all");
    // Folder inheritance is folded by `effectiveLockForPath`, not here.
    expect(map.get("Projects/alpha.md")).toBeUndefined();
  });

  it("locks EVERY path when the vault posture row is present, at the `vault` scope", () => {
    const map = lockScopesByPath(tree, [vaultLock()], "u1");
    for (const path of ALL_PATHS) expect(map.get(path)).toBe("vault");
    expect(map.size).toBe(ALL_PATHS.length);
  });

  it("gives the vault scope its own tooltip, naming the vault rather than the item", () => {
    expect(LOCK_TITLES.vault).toBe("This vault is read-only — changes won't sync");
    expect(LOCK_TITLES.vault).not.toBe(LOCK_TITLES.all);
  });

  it("lets an item's OWN Everyone lock keep the per-item wording", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock(), share({ id: "s2", resourceType: "folder", resourceId: "f-deep" })],
      "u1",
    );
    // The folder carries a row of its own, so it is not the vault speaking.
    expect(map.get("Projects/Deep")).toBe("all");
    // Everything else still reports the vault.
    expect(map.get("Projects")).toBe("vault");
    expect(map.get("loose.md")).toBe("vault");
  });

  it("does not crash on a vault row whose resource id matches no path", () => {
    // The posture row names the ORG, which is in no id→path map at all.
    expect(() => lockScopesByPath(tree, [vaultLock()], "u1")).not.toThrow();
    expect(lockScopesByPath(tree, [vaultLock()], "u1").has("org-1")).toBe(false);
  });

  it("outranks the per-person scopes — the vault covers strictly more people", () => {
    const map = lockScopesByPath(
      tree,
      [
        vaultLock(),
        // A per-member lock would normally read as "member" on this path.
        share({ id: "s2", resourceType: "file", resourceId: "n-alpha", principalType: "user", principalId: "someone-else" }),
        // And a lock naming me would read as "you".
        share({ id: "s3", resourceType: "file", resourceId: "n-loose", principalType: "user", principalId: "u1" }),
      ],
      "u1",
    );
    expect(map.get("Projects/alpha.md")).toBe("vault");
    expect(map.get("loose.md")).toBe("vault");
  });

  it("leaves item-only behaviour untouched when no vault row is present", () => {
    const map = lockScopesByPath(
      tree,
      [
        share({ resourceType: "file", resourceId: "n-alpha", principalType: "user", principalId: "u1" }),
        share({ id: "s2", resourceType: "file", resourceId: "n-loose", principalType: "user", principalId: "u2" }),
      ],
      "u1",
    );
    expect(map.get("Projects/alpha.md")).toBe("you");
    expect(map.get("loose.md")).toBe("member");
    expect(map.get("Projects")).toBeUndefined();
  });

  it("returns an empty map with no locks at all", () => {
    expect(lockScopesByPath(tree, [], "u1").size).toBe(0);
  });

  // A Read-only vault is a BASELINE the server lets `edit` rows lift, so the
  // seed must not padlock a subtree the reader can actually write to.
  it("an org edit row on a folder lifts the whole subtree, leaving siblings locked", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock()],
      "u1",
      [lift("folder", "f-projects", { type: "org", id: "org-1" })],
    );
    expect(map.has("Projects")).toBe(false);
    expect(map.has("Projects/Deep")).toBe(false);
    expect(map.has("Projects/Deep/buried.md")).toBe(false);
    expect(map.has("Projects/alpha.md")).toBe(false);
    // Outside the lifted folder the vault still decides.
    expect(map.get("loose.md")).toBe("vault");
  });

  it("a per-user edit row for the current user lifts just that note", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock()],
      "u1",
      [lift("file", "n-alpha", { type: "user", id: "u1" })],
    );
    expect(map.has("Projects/alpha.md")).toBe(false);
    expect(map.get("Projects")).toBe("vault");
    expect(map.get("Projects/Deep/buried.md")).toBe("vault");
    expect(map.get("loose.md")).toBe("vault");
  });

  it("an item's own lock inside a lifted folder still wins — a lock caps a grant", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock(), share({ id: "s2", resourceType: "file", resourceId: "n-alpha" })],
      "u1",
      [lift("folder", "f-projects", { type: "org", id: "org-1" })],
    );
    expect(map.get("Projects/alpha.md")).toBe("all");
    // The rest of the lifted folder is still lifted.
    expect(map.has("Projects/Deep/buried.md")).toBe(false);
  });

  it("a lift naming a resource outside the tree changes nothing", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock()],
      "u1",
      [lift("folder", "f-unknown", { type: "org", id: "org-1" })],
    );
    for (const path of ALL_PATHS) expect(map.get(path)).toBe("vault");
  });

  it("ignores lifts entirely when the vault is not read-only", () => {
    const map = lockScopesByPath(
      tree,
      [share({ resourceType: "folder", resourceId: "f-projects" })],
      "u1",
      [lift("folder", "f-projects", { type: "org", id: "org-1" })],
    );
    expect(map.get("Projects")).toBe("all");
  });
});

describe("effectiveLockForPath", () => {
  it("still inherits a folder lock down to a descendant", () => {
    const map = lockScopesByPath(tree, [share({ resourceType: "folder", resourceId: "f-projects" })], "u1");
    expect(effectiveLockForPath(map, "Projects/Deep/buried.md")).toBe("all");
    expect(effectiveLockForPath(map, "loose.md")).toBeNull();
  });

  it("reports every path locked under the vault posture", () => {
    const map = lockScopesByPath(tree, [vaultLock()], "u1");
    for (const path of ALL_PATHS) expect(effectiveLockForPath(map, path)).toBe("vault");
  });

  it("reports no lock at all on a lifted subtree — the Editor must stay editable", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock()],
      "u1",
      [lift("folder", "f-projects", { type: "org", id: "org-1" })],
    );
    expect(effectiveLockForPath(map, "Projects/Deep/buried.md")).toBeNull();
    expect(effectiveLockForPath(map, "loose.md")).toBe("vault");
  });

  // The seed puts `vault` on every path, so a path WITHOUT it was lifted. If an
  // ancestor's `vault` were allowed to fall down, the padlock would land right
  // back on the one note a personal grant made editable — and the Editor would
  // open it read-only on its first frame.
  it("never inherits the vault scope onto a note a per-user grant lifted", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock()],
      "u1",
      [lift("file", "n-alpha", { type: "user", id: "u1" })],
    );
    // The containing folder is still locked by the vault…
    expect(effectiveLockForPath(map, "Projects")).toBe("vault");
    // …but the lifted note inside it is not.
    expect(effectiveLockForPath(map, "Projects/alpha.md")).toBeNull();
    // Its unlifted sibling still is.
    expect(effectiveLockForPath(map, "Projects/Deep/buried.md")).toBe("vault");
  });

  it("lets an ancestor's own Everyone lock outrank the vault posture on a descendant", () => {
    const map = lockScopesByPath(
      tree,
      [vaultLock(), share({ resourceType: "folder", resourceId: "f-projects" })],
      "u1",
    );
    expect(effectiveLockForPath(map, "Projects/Deep/buried.md")).toBe("all");
    // Outside that folder the vault is still the only thing deciding.
    expect(effectiveLockForPath(map, "loose.md")).toBe("vault");
  });
});
