/* The three chained hooks that answer "which vaults does this device/account
   know about". Shared by the account menu's popovers and by the (lazy)
   vault-settings dialog, so they live outside both. */
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../lib/ipc";
import type { RecentVault } from "../lib/ipc";
import { readKnownVaults, readOrgVaults, useStore } from "../store";
import { unboundRecents } from "../lib/vaultRows";
import {
  classifyLocalFolder,
  type FolderStamp,
  type LocalFolderClass,
} from "../lib/vault/vaultList";

/** Every recently opened folder on this device, newest first. */
export function useRecentVaults(nonce = 0): RecentVault[] {
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // Re-fetch when the open folder changes (a switch/open reorders recents) and
  // when `nonce` is bumped (after a local remove/delete removes a row).
  const openPath = useStore((s) => s.vault?.path);
  const recentsVersion = useStore((s) => s.recentsVersion);
  useEffect(() => {
    let alive = true;
    ipc
      .getRecentVaults()
      .then((l) => {
        if (alive) setRecents(l);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nonce, openPath, recentsVersion]);
  return recents;
}

/**
 * Vaults this account knows about: the ones it holds now, plus the cached list
 * (which survives sign-out and a dropped connection). Used to tell a folder
 * bound to a real vault from one bound to a vault that's gone — see
 * `unboundRecents` for why that distinction is what un-hides ghost vaults.
 */
export function useKnownOrgIds(): ReadonlySet<string> {
  const organizations = useStore((s) => s.organizations);
  return useMemo(
    () =>
      new Set([
        ...organizations.map((o) => o.id),
        ...readKnownVaults().map((v) => v.id),
      ]),
    [organizations],
  );
}

/**
 * Recent on-disk folders that aren't bound to a vault in this account — i.e.
 * the user's LOCAL vaults. A vault is one concept in two states; these are
 * the ones that just aren't syncing to a vault yet.
 */
export function useLocalVaults(nonce = 0): RecentVault[] {
  const recents = useRecentVaults(nonce);
  const knownOrgIds = useKnownOrgIds();
  return useMemo(
    () => unboundRecents(recents, readOrgVaults(), knownOrgIds),
    [recents, knownOrgIds],
  );
}

/**
 * Last stamp read per folder path, kept for the app session so reopening the
 * Vaults tab or the switcher paints the filtered list at once. `"error"` = the
 * read failed: resolved, but classifies as `local` (never hide on an error).
 * Every mount re-reads in the background and refreshes the cache.
 */
const stampCache = new Map<string, FolderStamp | null | "error">();

export interface LocalFolderClasses {
  /** Class per path; only paths whose stamp read has settled are present. */
  classes: ReadonlyMap<string, LocalFolderClass>;
  /** True once EVERY given folder has a settled stamp (cached or fresh). */
  resolved: boolean;
  /** Settled folders whose stamp names a vault: path → that `organizationId`. */
  stampedOrgIds: ReadonlyMap<string, string>;
}

/**
 * Each local folder's class (`classifyLocalFolder`): `member`, `local` or
 * `foreign`, read from the folder's own `.context/config.json` stamp. All
 * stamps are read in one `Promise.all` and committed together, so a caller
 * that waits for `resolved` never paints an unfiltered row. `memberOrgIds` =
 * the vaults the signed-in account is a member of right now.
 */
export function useLocalFolderClasses(
  folders: readonly RecentVault[],
  memberOrgIds: readonly string[],
): LocalFolderClasses {
  const [version, setVersion] = useState(0);
  const key = folders.map((f) => f.path).join("\n");
  useEffect(() => {
    let alive = true;
    const paths = key ? key.split("\n") : [];
    if (paths.length === 0) return;
    Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await ipc.peekVaultStamp(path)] as const;
        } catch {
          return [path, "error"] as const;
        }
      }),
    ).then((entries) => {
      for (const [path, stamp] of entries) stampCache.set(path, stamp);
      if (alive) setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const membersKey = memberOrgIds.join(",");
  return useMemo(() => {
    const members = new Set(memberOrgIds);
    const orgVaults = readOrgVaults();
    const lookup = (p: string) => {
      const v = stampCache.get(p);
      return v === "error" ? undefined : v;
    };
    const classes = new Map<string, LocalFolderClass>();
    const stampedOrgIds = new Map<string, string>();
    let resolved = true;
    for (const f of folders) {
      if (!stampCache.has(f.path)) {
        resolved = false;
        continue;
      }
      classes.set(f.path, classifyLocalFolder(f, members, lookup, orgVaults));
      const orgId = lookup(f.path)?.organizationId;
      if (orgId) stampedOrgIds.set(f.path, orgId);
    }
    return { classes, resolved, stampedOrgIds };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, membersKey]);
}
