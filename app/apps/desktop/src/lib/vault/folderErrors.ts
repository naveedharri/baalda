/**
 * Recognising the vaults-root errors Rust sends (`src-tauri/src/folder_safety.rs`).
 *
 * When macOS privacy refuses Baalda the Documents folder, the default vaults
 * root (Documents/Baalda Vaults) cannot be created. Rust then prefixes the
 * error with `documents_denied: ` so the UI can explain the block and offer
 * System Settings, instead of asking for "any folder" — which is how one user
 * ended up with their home folder bound as a vault.
 */

/** Must equal `folder_safety::DOCUMENTS_DENIED` in Rust. */
export const DOCUMENTS_DENIED_PREFIX = "documents_denied: ";

/** macOS System Settings → Privacy & Security → Files and Folders. */
export const FILES_AND_FOLDERS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/** What the Set-up prompt says when Documents is blocked. */
export const DOCUMENTS_BLOCKED_TEXT =
  "macOS blocked Baalda from using your Documents folder. Allow Baalda under Files and Folders in System Settings, then try again.";

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** True when the error is macOS refusing Baalda the Documents folder. */
export function isDocumentsDenied(e: unknown): boolean {
  return rawMessage(e).startsWith(DOCUMENTS_DENIED_PREFIX);
}

/** The sentence to show a person: the error text without its code prefix. */
export function folderErrorText(e: unknown): string {
  const msg = rawMessage(e);
  return msg.startsWith(DOCUMENTS_DENIED_PREFIX) ? msg.slice(DOCUMENTS_DENIED_PREFIX.length) : msg;
}
