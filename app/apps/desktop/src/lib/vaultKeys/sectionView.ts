// What Vault Settings → General shows for vault keys (pure, for tests).
//
// - Unkeyed vaults show nothing: every vault is encrypted automatically (owner
//   decision 2026-11-01, no opt-in), so there is nothing to offer or explain.
// - `reveal`: owner, key verified on this computer: "Show vault key".
// - `restore`: owner, vault keyed but this computer has no key.
// - `hidden`: everything else, including every plain member and any unknown state.
import type { VaultKeyState } from "./session";

/** Shown while a keyed vault's older content is still being converted. */
export const CONVERTING_LINE = "Older content is being encrypted; new edits are already encrypted.";

/**
 * The conversion line for owners/admins of a KEYED vault: only on the server's
 * explicit `fullyEncrypted: false`. Fully encrypted, unknown (older server) or
 * any non-keyed state: no line.
 */
export function conversionLine(opts: {
  state: VaultKeyState | null;
  isOwner: boolean;
  canManage: boolean;
  fullyEncrypted: boolean | undefined;
}): string | null {
  if (!(opts.canManage || opts.isOwner)) return null;
  const s = opts.state?.state;
  if (!s || s === "disabled" || s === "unkeyed" || s === "security-warning") return null;
  return opts.fullyEncrypted === false ? CONVERTING_LINE : null;
}

export type VaultKeySectionView = "hidden" | "reveal" | "restore";

export function vaultKeySectionView(opts: {
  hasWords: boolean;
  state: VaultKeyState | null;
  isOwner: boolean;
  canManage: boolean;
}): VaultKeySectionView {
  const { hasWords, state, isOwner } = opts;
  const canManage = opts.canManage || isOwner;
  if (!canManage) return "hidden";
  if (hasWords) return isOwner ? "reveal" : "hidden";
  if (state?.state === "unkeyed") return "hidden";
  // Keyed, but this computer cannot open it (`blocksStructure` in runtime.ts
  // minus the security warning, which has its own notice). Not imported from
  // there: runtime.ts pulls in the API client.
  const noKeyHere =
    state?.state === "waiting-for-teammate" || state?.state === "needs-account-key" || state?.state === "key-mismatch";
  return noKeyHere && isOwner ? "restore" : "hidden";
}

/** Account Settings → Profile: the line under "Your security code". */
export const SECURITY_CODE_HINT = "Teammates may ask you to read this out if your security key changes, to confirm it is really you.";

/**
 * The person's OWN security code (the same `shortFingerprint` teammates see in
 * "<name>'s security key changed"), shown only while this computer holds the
 * account key the server names. Vault keys off, no key, a device still
 * waiting for approval or a mismatched key: nothing.
 */
export function ownSecurityCodeView(account: { state: string } | null, code: string | null): string | null {
  return account?.state === "ready" && code ? code : null;
}
