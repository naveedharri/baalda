import { describe, it, expect } from "vitest";
import type { VaultStamp } from "../../ipc";
import { rediscoverVaultFolder, type PeekedFolder } from "../rediscover";

/** A folder's stamp as `ipc.peekVaultStamp` reports it: both fields present,
 *  each null when the config didn't carry it. */
const cfg = (fields: Partial<VaultStamp>): VaultStamp => ({
  organizationId: fields.organizationId ?? null,
  serverVaultId: fields.serverVaultId ?? null,
});

const base = {
  orgId: "org-a",
  orgVaults: {} as Record<string, string>,
  collectionIds: new Set<string>(),
};

describe("rediscoverVaultFolder", () => {
  it("finds the folder stamped with the vault's org id", () => {
    const candidates: PeekedFolder[] = [
      { path: "/downloads/notes", stamp: cfg({ organizationId: "org-a" }) },
      { path: "/root/other", stamp: cfg({ organizationId: "org-b" }) },
    ];
    expect(rediscoverVaultFolder({ ...base, candidates })).toBe(
      "/downloads/notes",
    );
  });

  it("returns null when nothing matches — the caller may mint a folder", () => {
    const candidates: PeekedFolder[] = [
      { path: "/root/other", stamp: cfg({ organizationId: "org-b" }) },
      { path: "/plain/folder", stamp: null },
    ];
    expect(rediscoverVaultFolder({ ...base, candidates })).toBeNull();
  });

  it("heals a pre-stamp folder through its collection id", () => {
    // A folder synced by a version before `organizationId` existed carries only
    // `serverVaultId` — the silent in-place upgrade path.
    const candidates: PeekedFolder[] = [
      { path: "/downloads/notes", stamp: cfg({ serverVaultId: "col-1" }) },
    ];
    expect(
      rediscoverVaultFolder({
        ...base,
        candidates,
        collectionIds: new Set(["col-1"]),
      }),
    ).toBe("/downloads/notes");
  });

  it("prefers the explicit stamp over a legacy collection match", () => {
    const candidates: PeekedFolder[] = [
      { path: "/legacy/copy", stamp: cfg({ serverVaultId: "col-1" }) },
      {
        path: "/current/home",
        stamp: cfg({ organizationId: "org-a", serverVaultId: "col-1" }),
      },
    ];
    expect(
      rediscoverVaultFolder({
        ...base,
        candidates,
        collectionIds: new Set(["col-1"]),
      }),
    ).toBe("/current/home");
  });

  it("never matches a folder stamped for a different vault, even on collection id", () => {
    // The stamp is newer information than the collection row — a mismatch means
    // the folder was since reconciled under another vault.
    const candidates: PeekedFolder[] = [
      {
        path: "/root/other",
        stamp: cfg({ organizationId: "org-b", serverVaultId: "col-1" }),
      },
    ];
    expect(
      rediscoverVaultFolder({
        ...base,
        candidates,
        collectionIds: new Set(["col-1"]),
      }),
    ).toBeNull();
  });

  it("never steals a folder another vault currently claims", () => {
    // Its config says org-a, but localStorage binds it to org-b (e.g. the
    // one-folder-one-vault eviction re-assigned it). Matching it would just
    // restart the eviction ping-pong.
    const candidates: PeekedFolder[] = [
      { path: "/shared/folder", stamp: cfg({ organizationId: "org-a" }) },
    ];
    expect(
      rediscoverVaultFolder({
        ...base,
        candidates,
        orgVaults: { "org-b": "/shared/folder" },
      }),
    ).toBeNull();
  });

  it("a folder the vault itself already claims is still eligible", () => {
    // The bound-path branch normally handles it, but rediscovery must not
    // exclude the vault's OWN binding (e.g. reached after folderExists raced).
    const candidates: PeekedFolder[] = [
      { path: "/downloads/notes", stamp: cfg({ organizationId: "org-a" }) },
    ];
    expect(
      rediscoverVaultFolder({
        ...base,
        candidates,
        orgVaults: { "org-a": "/downloads/notes" },
      }),
    ).toBe("/downloads/notes");
  });

  it("ignores folders with no readable stamp instead of aborting the scan", () => {
    // Rust answers null for a plain folder, an unreadable config AND a
    // malformed one — indistinguishable here, and all equally skippable.
    const candidates: PeekedFolder[] = [
      { path: "/corrupt", stamp: null },
      { path: "/downloads/notes", stamp: cfg({ organizationId: "org-a" }) },
    ];
    expect(rediscoverVaultFolder({ ...base, candidates })).toBe(
      "/downloads/notes",
    );
  });

  it("respects candidate order when several folders match (recents first)", () => {
    // Pre-fix duplicates can leave TWO matching folders on disk; the caller
    // orders candidates most-recently-opened first, so the one the user
    // actually used wins.
    const candidates: PeekedFolder[] = [
      { path: "/documents/notes", stamp: cfg({ organizationId: "org-a" }) },
      { path: "/root/notes-slug", stamp: cfg({ organizationId: "org-a" }) },
    ];
    expect(rediscoverVaultFolder({ ...base, candidates })).toBe(
      "/documents/notes",
    );
  });
});
