/* The two states the editor column can show without CodeMirror. They live in
   their own eager module so `App.tsx` can render them as the Suspense
   fallback / empty state for the (lazy) Editor chunk without pulling
   CodeMirror into the startup bundle. Their styles are in `editor.css`, which
   `cssCodeSplit: false` keeps in the one eager stylesheet. */

/**
 * Placeholder for a note that is still opening.
 *
 * Deliberately lines of text rather than a spinner. A spinner says "wait"; a
 * skeleton says "text is arriving, and roughly this much of it" — and because it
 * occupies the same column as the real content, the note doesn't visibly jump
 * when it swaps in. The bars only appear after a beat (`skeleton-in` has a
 * delay) so a note that opens from the local index in 40ms — the common case —
 * never flashes one. That delay is also what makes it safe as the lazy chunk's
 * fallback: the Editor chunk normally lands well inside it.
 */
export function EditorSkeleton() {
  return (
    <div className="editor-skeleton" role="status" aria-label="Opening note">
      <span className="skel-line skel-title" />
      <span className="skel-line" style={{ width: "92%" }} />
      <span className="skel-line" style={{ width: "78%" }} />
      <span className="skel-line" style={{ width: "85%" }} />
      <span className="skel-line" style={{ width: "45%" }} />
    </div>
  );
}

/** No note open: the editor column's resting state. */
export function EditorEmpty() {
  return (
    <div className="editor-empty">
      <p>Select a note, or press ⌘N to create one.</p>
    </div>
  );
}
