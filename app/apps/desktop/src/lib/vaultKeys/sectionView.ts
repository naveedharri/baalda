// What Vault Settings → General shows for vault keys (pure, for tests).
//
// - `encrypt-offer`: an EXISTING vault nobody opted in yet; owners/admins get
//   "Encrypt this vault" (one-way). New vaults are requested at creation.
// - `setting-up`: requested (or an older server converting on its own), not
//   keyed yet: "Encryption is being set up for this vault."
// - `reveal`: owner, key verified on this computer: "Show vault key".
// - `restore`: owner, vault keyed but this computer has no key.
// - `hidden`: everything else, including every plain member and any unknown state.
import type { VaultKeyState } from "./session";

export type VaultKeySectionView = "hidden" | "encrypt-offer" | "setting-up" | "reveal" | "restore";

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
  if (state?.state === "unkeyed") {
    // `conversionAllowed` alone means the server already decided to key it (an
    // older server converts every vault): never offer a button there.
    return state.encryptionRequested || state.conversionAllowed ? "setting-up" : "encrypt-offer";
  }
  // Keyed, but this computer cannot open it (`blocksStructure` in runtime.ts
  // minus the security warning, which has its own notice). Not imported from
  // there: runtime.ts pulls in the API client.
  const noKeyHere =
    state?.state === "waiting-for-teammate" || state?.state === "needs-account-key" || state?.state === "key-mismatch";
  return noKeyHere && isOwner ? "restore" : "hidden";
}
