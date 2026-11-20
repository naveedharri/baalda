// May this person add a note, folder or import to a folder?
//
// The server is the authority (`canCreateIn`: `canEditFolder` in a folder,
// `vaultRootWritable` at the top), and it refuses a create in a folder this
// person can only view. Before this check the app made the file anyway, the
// server refused to register it, and the person was left with a note that
// existed only on their computer while the sidebar called it synced (#414).
// Asking first means the refusal is a sentence at the moment of the click,
// not a stranded file.
//
// Pure: the caller hands over what it already holds (the padlock resolution
// the sidebar draws from, and the registry pull's `canCreateRoot`). Unknown
// always allows: no locks fetched yet, offline, or a local-only vault. The
// server still decides.

export const ROOT_FROZEN_MESSAGE =
  "This vault's root is frozen. Create this inside a folder instead.";

export const VIEW_ONLY_FOLDER_MESSAGE =
  "You can view this folder but can't add to it. Ask an owner for edit access.";

export const VIEW_ONLY_ROOT_MESSAGE =
  "You can't add to the top of this vault. Ask an owner for edit access.";

export interface CreateGateInput {
  /** Vault-relative folder the new item would go in; "" is the top level. */
  dir: string;
  /** The root freeze latch (`store.rootFrozen`). */
  rootFrozen: boolean;
  /** Sync is on for this vault. Off: a local folder, nothing to refuse. */
  syncEnabled: boolean;
  /** The registry pull's answer for the top level, or null when unknown. */
  canCreateRoot: boolean | null;
  /** Is `path` padlocked for the caller (`lockBlocksCaller`)? */
  lockedForCaller: (path: string) => boolean;
}

/** The sentence to show instead of creating, or null when the create may go. */
export function createBlockReason(input: CreateGateInput): string | null {
  const { dir, rootFrozen, syncEnabled, canCreateRoot, lockedForCaller } = input;
  if (dir === "" && rootFrozen) return ROOT_FROZEN_MESSAGE;
  if (!syncEnabled) return null;
  if (dir === "") return canCreateRoot === false ? VIEW_ONLY_ROOT_MESSAGE : null;
  return lockedForCaller(dir) ? VIEW_ONLY_FOLDER_MESSAGE : null;
}
