// A tiny registry for "the note editor that's currently on screen" so code
// outside the Editor component (e.g. the sidebar's global drag-drop handler)
// can drop an embed into the open note at the caret. The Editor sets this when
// it mounts a view and clears it on teardown.
//
// Deliberately CodeMirror-free: the sidebar is eager and imports this module,
// so a value import of `@codemirror/state` here would drag CodeMirror into the
// startup chunk. The CodeMirror half lives in `activeNoteBinding.ts`, which
// only the (lazy) Editor imports.

export interface ActiveNote {
  /** True when the note can receive an insert (not a preview, not locked). */
  editable: () => boolean;
  /** Insert markdown at the caret, on its own line. */
  insert: (md: string) => boolean;
}

let current: ActiveNote | null = null;

export function setActiveNote(note: ActiveNote | null): void {
  current = note;
}

/** True when a live, editable note editor is present to receive an embed. */
export function activeNoteEditable(): boolean {
  return current?.editable() ?? false;
}

/**
 * Insert markdown at the caret of the active editor, on its own line. Returns
 * false when there's no editable editor (a preview/HTML view, or a locked note).
 */
export function insertIntoActiveNote(md: string): boolean {
  return current?.insert(md) ?? false;
}
