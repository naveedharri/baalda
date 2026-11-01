// Membership ended / vault gone: this device forgets that vault's key.
//
// Only ever called AFTER a definitive server answer (the same gates that delete
// the vault's folder or clear its stamp: a `member-removed` frame for this user
// confirmed by a re-list, a confirmed leave, `notMember` from membership-check,
// a confirmed delete or unsync, or `vault_not_found` from the org status). A
// network error never reaches here. What goes: the vault key `vk:<server>:<id>`
// and its provisional marker. What never goes: the account key, the device-link
// key and the TOFU pins (those are per teammate, shared by every vault).
//
// The key is named by the vault COLLECTION id while membership speaks org ids,
// so the session records org → collection whenever a vault opens (`rememberOrgVault`).

/** The two keychain writes this needs (`keychainVaultKeyStore` has both). */
export interface ForgetKeyStore {
  deleteVaultKey(vaultId: string): Promise<void>;
  setVaultKeyProvisional(vaultId: string, on: boolean): Promise<void>;
}

/**
 * Delete each vault's key, then its provisional marker. Per id, best-effort:
 * one keychain failure never stops the others. Returns the ids fully forgotten.
 */
export async function forgetVaultKeyMaterial(
  keys: ForgetKeyStore,
  vaultIds: Iterable<string>,
): Promise<string[]> {
  const done: string[] = [];
  for (const id of new Set(vaultIds)) {
    if (!id) continue;
    try {
      await keys.deleteVaultKey(id);
      await keys.setVaultKeyProvisional(id, false);
      done.push(id);
    } catch (e) {
      console.warn("[vault-keys] could not forget a vault key", e instanceof Error ? e.message : e);
    }
  }
  return done;
}

// ── org → collection ids, per (server, user), in localStorage (ids only) ────

const MAP_KEY = "context.vaultKeys.orgVaults";
type OrgVaultMap = Record<string, Record<string, string[]>>;

const scopeKey = (serverUrl: string, userId: string) => `${serverUrl.replace(/\/+$/, "")}|${userId}`;

function readMap(): OrgVaultMap {
  try {
    const raw = JSON.parse(localStorage.getItem(MAP_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as OrgVaultMap) : {};
  } catch {
    return {};
  }
}

function writeMap(m: OrgVaultMap): void {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  } catch {
    /* best-effort: the folder stamp is the other source */
  }
}

export function rememberOrgVault(serverUrl: string, userId: string, orgId: string, vaultId: string): void {
  if (!orgId || !vaultId) return;
  const m = readMap();
  const k = scopeKey(serverUrl, userId);
  const have = m[k]?.[orgId] ?? [];
  if (have.includes(vaultId)) return;
  m[k] = { ...(m[k] ?? {}), [orgId]: [...have, vaultId] };
  writeMap(m);
}

export function vaultIdsForOrg(serverUrl: string, userId: string, orgId: string): string[] {
  return readMap()[scopeKey(serverUrl, userId)]?.[orgId] ?? [];
}

/** The org this device last recorded a collection under, or null when unknown. */
export function orgOfVault(serverUrl: string, userId: string, vaultId: string): string | null {
  const orgs = readMap()[scopeKey(serverUrl, userId)] ?? {};
  for (const [orgId, ids] of Object.entries(orgs)) if (Array.isArray(ids) && ids.includes(vaultId)) return orgId;
  return null;
}

/** Every [orgId, vaultId] this device recorded for (server, user). */
export function knownOrgVaults(serverUrl: string, userId: string): Array<[string, string]> {
  const orgs = readMap()[scopeKey(serverUrl, userId)] ?? {};
  const out: Array<[string, string]> = [];
  for (const [orgId, ids] of Object.entries(orgs)) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === "string" && id) out.push([orgId, id]);
  }
  return out;
}

export function forgetOrgVaultIds(serverUrl: string, userId: string, orgId: string): void {
  const m = readMap();
  const k = scopeKey(serverUrl, userId);
  if (!m[k]?.[orgId]) return;
  const { [orgId]: _gone, ...rest } = m[k];
  m[k] = rest;
  writeMap(m);
}
