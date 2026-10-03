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
 *
 * `immediate` drops that delay. It is for a note-to-note switch, where the
 * previous CodeMirror view has just been destroyed and the pane is empty NOW:
 * holding the bars back there showed a bare surface for the whole beat, which
 * read as the app blanking rather than as a note loading.
 */
export function EditorSkeleton({ immediate = false }: { immediate?: boolean }) {
  return (
    <div
      className="editor-skeleton"
      data-immediate={immediate || undefined}
      role="status"
      aria-label="Opening note"
    >
      {/* `.skel-page` is capped at ~60% of the pane and fades out at its foot,
          so the page reads as "a note's worth of text" at any window height
          without measuring anything: there are more paragraphs here than the
          cap ever shows, and the overflow is simply clipped. */}
      <div className="skel-page">
        <span className="skel-line skel-title" />
        {SKELETON_PARAGRAPHS.map((widths, p) => (
          <div className="skel-group" key={p}>
            {widths.map((w, i) => (
              <span className="skel-line" key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Paragraph shapes for the skeleton: 3–4 lines each, near-full lines with a
   short last line, so the bars read as prose rather than as a list. Fixed (not
   random) so the placeholder does not reshuffle between renders. */
const SKELETON_PARAGRAPHS: readonly (readonly number[])[] = [
  [96, 88, 93, 61],
  [90, 84, 47],
  [94, 97, 86, 72],
  [89, 92, 38],
  [95, 81, 90, 66],
  [87, 93, 54],
  [92, 85, 96, 70],
  [90, 58],
];

/** No note open: the editor column's resting state. */
export function EditorEmpty() {
  return (
    <div className="editor-empty">
      <p>Select a note, or press ⌘N to create one.</p>
    </div>
  );
}
