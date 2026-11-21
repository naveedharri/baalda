// SPDX-License-Identifier: Apache-2.0
// May this person rename or move an item, and what to say when they can't?
//
// The server is the authority (`PATCH /folders/:id` and `/notes/:id` need
// edit on the item, and on the destination folder for a move). Before this the
// sidebar renamed the folder on disk first and only then asked: a refusal left
// the new name on disk, shown as "local, can't sync", and the next pull brought
// the old one back beside it — two copies. Asking first turns the refusal into a
// sentence at the moment of the click; a refusal that still comes back (Finder,
// a race with an access change) puts the old name back on disk.
//
// Pure: the caller hands over the padlock resolution the sidebar already draws
// from (`lockBlocksCaller`). Unknown access allows; the server still decides.

import { createBlockReason } from "./createGate";

function leaf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export const RENAME_NOT_CREATOR_MESSAGE =
  "Only the person who created this, or an owner or admin, can rename or move it.";

/** Shown when the server refused a rename/move and the old name was put back.
 *  `status` is the HTTP status when known (a 403 without a code means no edit
 *  access, on the item or on the destination). */
export function renameRefusedMessage(
  path: string,
  isDir: boolean,
  code: string | null,
  status: number | null = null,
): string {
  const name = leaf(path).replace(/\.md$/i, "");
  if (code === "rename_not_creator") {
    return `Only the person who created ${name}, or an owner or admin, can rename or move it. Its name was put back.`;
  }
  if (code === "path_folder_mismatch" || status === 400) {
    return `${name} couldn't be renamed or moved there. It's back where it was.`;
  }
  if (status === 409) {
    return `Something with that name already exists for your team, so ${name} kept its name.`;
  }
  if (code === "conflict_rename_refused") {
    return `${name} can't be given a conflict name. Its name was put back.`;
  }
  if (code === "root_frozen") {
    return `This vault's root is frozen, so ${name} can't move there. It's back where it was.`;
  }
  if (code === "account_read_only") {
    return `Sync is read-only for this vault right now, so ${name} can't be renamed. Its name was put back.`;
  }
  if (code === "rename_rate_limited") {
    return `Too many renames at once. ${name} kept its name; try again in a moment.`;
  }
  return `You can only view ${isDir ? "the folder" : ""} ${name}, so it can't be renamed or moved. Its name was put back.`.replace(/\s+/g, " ");
}

export interface RenameGateInput {
  /** The caller's vault role, when known (`owner`/`admin` rename anything). */
  role?: string | null;
  /** Did the caller create this item (a folder: everything in it)? Asked only
   *  for a plain member; see `registry.isAuthoredByMe`. */
  authoredByMe?: () => boolean;
  /** The item being renamed or moved. */
  path: string;
  isDir: boolean;
  /** Where it would land; omitted or equal to its folder for a plain rename. */
  destDir?: string;
  syncEnabled: boolean;
  rootFrozen: boolean;
  canCreateRoot: boolean | null;
  /** Is `path` padlocked for the caller (`lockBlocksCaller`)? */
  lockedForCaller: (path: string) => boolean;
}

/** The sentence to show instead of renaming/moving, or null when it may go. */
export function renameBlockReason(input: RenameGateInput): string | null {
  const { path, isDir, syncEnabled, lockedForCaller } = input;
  if (!syncEnabled) return null;
  if (lockedForCaller(path)) {
    const name = leaf(path).replace(/\.md$/i, "");
    return isDir
      ? `You can only view the folder ${name}, so you can't rename or move it. Ask an owner for edit access.`
      : `You can only view ${name}, so you can't rename or move it. Ask an owner for edit access.`;
  }
  // Creator-only, the delete rule (server `canRenameItem`): a plain member
  // renames or moves only what they made. Unknown role: the server decides.
  if (input.role && input.role !== "owner" && input.role !== "admin" && input.authoredByMe && !input.authoredByMe()) {
    return RENAME_NOT_CREATOR_MESSAGE;
  }
  const dest = input.destDir;
  if (dest !== undefined && dest !== parent(path)) {
    return createBlockReason({
      dir: dest,
      rootFrozen: input.rootFrozen,
      syncEnabled,
      canCreateRoot: input.canCreateRoot,
      lockedForCaller,
    });
  }
  return null;
}
