/**
 * Which docs this device knows are READ-ONLY for the signed-in user, this app
 * session: the last sync token said so (`DocSync.mintToken`) or the server
 * answered a push with a `rejected` frame.
 *
 * The bridge never diff-merges a file into such a doc. An op it created could
 * never be sent: every connect would re-send it, the server would answer
 * `rejected`, and the op would stay local forever. Instead a differing file is
 * kept as a quiet recovery copy and the doc's text is written back over it.
 * Nothing here persists; an editable token clears the mark.
 */
const readOnly = new Set<string>();

/** Saves `text` (the file's bytes) aside quietly; resolves true when it landed. */
export type ReadOnlyCopyKeeper = (docId: string, path: string, text: string) => Promise<boolean>;
let keeper: ReadOnlyCopyKeeper | null = null;

export function markReadOnlyDoc(docId: string, value: boolean): void {
  if (value) readOnly.add(docId);
  else readOnly.delete(docId);
}

export function isReadOnlyDoc(docId: string): boolean {
  return readOnly.has(docId);
}

/** The sync layer's quiet copy writer (epoch-pinned). Null unregisters it. */
export function setReadOnlyCopyKeeper(fn: ReadOnlyCopyKeeper | null): void {
  keeper = fn;
}

export function readOnlyCopyKeeper(): ReadOnlyCopyKeeper | null {
  return keeper;
}

/** Test/teardown helper. */
export function resetReadOnlyDocs(): void {
  readOnly.clear();
  keeper = null;
}
