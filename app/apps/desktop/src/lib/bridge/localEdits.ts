/**
 * Which notes the user has actually edited on this device, this app session.
 *
 * A read-only connection reports `rejected` whenever the client's sync carries
 * ops the server lacks, and that includes stale local ops replayed on a plain
 * open (an old disk ingest, history from before the note became read-only).
 * Only a change the user made, typing, undo/redo or a Properties edit, is
 * "your edit was not accepted". Disk ingests, persistence replay and remote
 * applies never mark a note. Nothing here persists.
 */
const edited = new Set<string>();

export function markLocalEdit(docId: string): void {
  edited.add(docId);
}

export function hasLocalEdit(docId: string): boolean {
  return edited.has(docId);
}

/** Test/teardown helper. */
export function resetLocalEdits(): void {
  edited.clear();
}
