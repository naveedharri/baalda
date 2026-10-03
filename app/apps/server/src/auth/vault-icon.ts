// A vault's icon rides on the Better Auth organization's `logo` column. The
// desktop writes either a preset reference or a small uploaded image (see
// desktop `lib/vaultIcon.ts`, which mirrors this contract); anything else is
// refused so the column can't become a dumping ground for arbitrary strings
// that every member's vault list then downloads.

/** Ceiling on a stored value: a 128px icon fits with room to spare. */
export const VAULT_ICON_MAX_CHARS = 96 * 1024;

const PRESET_RE = /^preset:[A-Za-z0-9]{1,40}:[a-z]{1,20}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/** null/undefined clear the icon back to the default. */
export function isValidVaultIcon(logo: unknown): boolean {
  if (logo === null || logo === undefined) return true;
  if (typeof logo !== "string" || logo.length > VAULT_ICON_MAX_CHARS) return false;
  return PRESET_RE.test(logo) || IMAGE_RE.test(logo);
}
