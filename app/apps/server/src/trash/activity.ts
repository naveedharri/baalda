// SPDX-License-Identifier: Apache-2.0
//
// "The vault's Trash moved" — a soft delete, a restore or a purge (#260).
//
// Open desktop apps used to poll `GET /vaults/:id/trash` (and shrink-events)
// once a minute, which was most of the requests the server saw. They now
// refetch when the vault channel sends an `activity` frame, and this is how the
// trash code asks for one without depending on the channel (index.ts wires the
// publisher, exactly like `setMemberJoinedPublisher` and `setShrinkHook`).
//
// Teammates also refetch on every structural `registry` frame, which every soft
// delete already sends; this announcement is what reaches the DELETER's own
// app (the registry frame skips its origin) and covers restore and purge.

type Publisher = (vaultId: string) => void;

let publisher: Publisher | null = null;

/** Wired once from index.ts. Null in tests and scripts: announcing is a no-op. */
export function setTrashActivityPublisher(fn: Publisher | null): void {
  publisher = fn;
}

/** Announce that `vaultId`'s Trash may have changed. Never throws. */
export function trashChanged(vaultId: string | null | undefined): void {
  if (!vaultId || !publisher) return;
  try {
    publisher(vaultId);
  } catch (err) {
    console.error("[trash] activity publish failed:", err);
  }
}
