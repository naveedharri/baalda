/* The mounted note editor's live EditorView, by vault path. Editor.tsx
   registers on mount and clears on unmount; the recovery-copy restore uses it
   to apply "Replace current note" as ONE editor transaction, which in collab
   mode reaches the note's Y.Text through yCollab exactly like typing. */
import type { EditorView } from "@codemirror/view";

const views = new Map<string, EditorView>();
const waiters = new Set<() => void>();

const key = (path: string) => path.toLowerCase();

export function registerLiveView(path: string, view: EditorView): () => void {
  views.set(key(path), view);
  for (const w of [...waiters]) w();
  return () => {
    if (views.get(key(path)) === view) views.delete(key(path));
  };
}

export function liveView(path: string): EditorView | null {
  return views.get(key(path)) ?? null;
}

/** Resolve with the view once `path` registers, or null after `timeoutMs`. */
export function waitForLiveView(path: string, timeoutMs: number): Promise<EditorView | null> {
  const now = liveView(path);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const check = () => {
      const v = liveView(path);
      if (!v) return;
      done(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    function done(v: EditorView | null) {
      clearTimeout(timer);
      waiters.delete(check);
      resolve(v);
    }
    waiters.add(check);
  });
}

/**
 * Replace the whole document with `text` in one transaction. Refuses a
 * read-only editor, which is what a view grant or a locked note mounts.
 * Returns false when there was nothing to change.
 */
export function replaceWholeDoc(view: EditorView, text: string): boolean {
  if (view.state.readOnly) throw new Error("This note is read-only.");
  const current = view.state.doc.toString();
  if (current === text) return false;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    userEvent: "input.replace",
    scrollIntoView: false,
  });
  return true;
}
