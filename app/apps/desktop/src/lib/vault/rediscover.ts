// Which already-on-disk folder is a vault's local home?
//
// The org→folder binding lives in webview localStorage (`context.orgVaults`),
// which is per-device and easy to lose: a reinstall, cleared webview storage, a
// dev-vs-prod origin change, or `rememberOrgVault`'s one-folder-one-vault
// eviction. When `setActiveOrganization` found no binding it used to go straight
// to minting `<vaults root>/<slug>` — so a vault that already had a perfectly
// good local folder (an adopted `~/Downloads/MyNotes`, say) got a second, full
// copy materialized under the vaults root, and the binding was re-pointed at the
// duplicate. This module is the "look before you mint" step: given candidate
// folders and their raw `.context/config.json` contents, pick the one that IS
// this vault.
//
// Two ways a folder proves itself, checked in order across ALL candidates:
//   1. `organizationId` in its config equals the target vault — the stamp the
//      registry writes on every reconcile (installs from this version on).
//   2. `serverVaultId` in its config is one of the vault's collection ids —
//      the field every previously-synced folder already has, which is what
//      silently heals folders written by PRE-stamp versions in place.
// Collection ids are UUIDs owned by exactly one org, so a cross-vault false
// positive would require a forged config, not an accident.
//
// Pure: no store, no IPC — the caller peeks each folder's stamp (see
// `ipc.peekVaultStamp`, which parses the two fields in RUST so the doc-id map
// beside them — megabytes on a big vault — never crosses the IPC boundary) and
// supplies them typed.

import type { VaultStamp } from "../ipc";

/** A candidate folder and its vault stamp (null: not a vault, or unreadable). */
export interface PeekedFolder {
  path: string;
  stamp: VaultStamp | null;
}

export interface RediscoverInput {
  /** The vault (org) looking for its folder. */
  orgId: string;
  /** Candidate folders, in priority order (recents newest-first, then root dirs). */
  candidates: readonly PeekedFolder[];
  /**
   * Persisted { orgId → folder } bindings. A folder another vault currently
   * claims is off-limits — matching it here would steal it right back and
   * re-create the eviction ping-pong this fix exists to end.
   */
  orgVaults: Readonly<Record<string, string>>;
  /**
   * Collection ids (Postgres `vaults` rows) belonging to `orgId`, for configs
   * that predate the `organizationId` stamp. Empty set: skip the legacy pass.
   */
  collectionIds: ReadonlySet<string>;
}

/** The folder that is `orgId`'s existing local copy, or null to mint/ask. */
export function rediscoverVaultFolder(input: RediscoverInput): string | null {
  const claimed = new Set(
    Object.entries(input.orgVaults)
      .filter(([id]) => id !== input.orgId)
      .map(([, p]) => p),
  );
  const usable = input.candidates
    .filter((c) => !claimed.has(c.path))
    .filter((c): c is { path: string; stamp: VaultStamp } => c.stamp !== null);

  // Pass 1: the explicit stamp. Exact and current — always wins over a legacy
  // collection match (a stamped folder is one this version has reconciled).
  for (const c of usable) {
    if (c.stamp.organizationId === input.orgId) return c.path;
  }

  // Pass 2: legacy configs, matched through the vault's collections. A folder
  // stamped for a DIFFERENT org is excluded even if its collection id matches:
  // the stamp is newer information than the collection row.
  for (const c of usable) {
    if (c.stamp.organizationId !== null) continue;
    if (c.stamp.serverVaultId && input.collectionIds.has(c.stamp.serverVaultId)) {
      return c.path;
    }
  }

  return null;
}
