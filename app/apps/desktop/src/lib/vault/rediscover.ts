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
// Pure: no store, no IPC — the caller peeks the configs (see
// `ipc.peekVaultConfig`) and supplies them raw.

/** A candidate folder and its raw `.context/config.json` (null: not a vault). */
export interface PeekedFolder {
  path: string;
  config: string | null;
}

/** The two identity fields of `VaultSyncConfig` (registry.ts owns the schema). */
interface ConfigIdentity {
  organizationId: string | null;
  serverVaultId: string | null;
}

function identityOf(raw: string | null): ConfigIdentity | null {
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as {
      organizationId?: unknown;
      serverVaultId?: unknown;
    };
    return {
      organizationId:
        typeof cfg.organizationId === "string" ? cfg.organizationId : null,
      serverVaultId:
        typeof cfg.serverVaultId === "string" ? cfg.serverVaultId : null,
    };
  } catch {
    return null;
  }
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
    .map((c) => ({ path: c.path, id: identityOf(c.config) }))
    .filter((c): c is { path: string; id: ConfigIdentity } => c.id !== null);

  // Pass 1: the explicit stamp. Exact and current — always wins over a legacy
  // collection match (a stamped folder is one this version has reconciled).
  for (const c of usable) {
    if (c.id.organizationId === input.orgId) return c.path;
  }

  // Pass 2: legacy configs, matched through the vault's collections. A folder
  // stamped for a DIFFERENT org is excluded even if its collection id matches:
  // the stamp is newer information than the collection row.
  for (const c of usable) {
    if (c.id.organizationId !== null) continue;
    if (c.id.serverVaultId && input.collectionIds.has(c.id.serverVaultId)) {
      return c.path;
    }
  }

  return null;
}
