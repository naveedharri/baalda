// SPDX-License-Identifier: Apache-2.0

import type { SyncStatus } from "../sync/syncManager";

/**
 * Decide whether a constructed editor already has something honest to show.
 *
 * A synced note can mount CodeMirror before its first server update arrives.
 * In that window the filename-backed title exists, but the Y.Text is still
 * empty. Treating "view mounted" as "note ready" exposes that half-hydrated
 * frame. Local notes and cached synced notes are ready immediately; an empty
 * networked note waits only while its initial connection is still pending.
 */
export function noteContentReady(input: {
  textLength: number;
  hasSync: boolean;
  syncStatus: SyncStatus;
}): boolean {
  return input.textLength > 0 || !input.hasSync || input.syncStatus !== "connecting";
}

/** The skeleton belongs to the note being requested, not to any mounted view. */
export function shouldShowNoteSkeleton(input: {
  requestedPath: string;
  mountedPath: string | null;
  readyPath: string | null;
  openingAnother: boolean;
}): boolean {
  return (
    input.openingAnother ||
    input.mountedPath !== input.requestedPath ||
    input.readyPath !== input.requestedPath
  );
}
