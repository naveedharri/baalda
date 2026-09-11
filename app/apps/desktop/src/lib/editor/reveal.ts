// What "being edited" means, for live preview.
//
// Until Stage 3 the rule was one LINE wide: put the caret anywhere on a line
// and every marker on it came back — `# Head **bold**` showed its `#` *and* its
// `**` even when the caret sat at the far end of the line. Obsidian's rule is
// one TOKEN wide: the markers of the emphasis/code/link span your selection
// actually touches reveal, and nothing else does.
//
// Two pieces make that work:
//
//   `focused` — a StateField, because the block-widget StateField in
//   livePreview.ts can read state but not `view.hasFocus`. When the editor is
//   blurred NOTHING is active: clicking into the sidebar leaves the note fully
//   rendered, which is the whole point of a live preview.
//
//   `tokenOwner` — the inline node a marker belongs to. A `**` is an
//   `EmphasisMark` whose parent is the `StrongEmphasis` it delimits, so the
//   marker's "am I being edited?" question is really about that parent's range.
//
// Both scopes use the SAME inclusive adjacency test (`r.from <= to && from <=
// r.to`): a caret parked immediately before or after a span counts as touching
// it, so you can walk the caret out of `**bold**` and watch the markers fold
// away one position past the closing `*`, exactly like Obsidian.

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** Focus changed. Dispatched by {@link focusTracker}; also useful in tests. */
export const setFocused = StateEffect.define<boolean>();

/**
 * Does the editor have focus? Starts `false` — a freshly mounted view has not
 * been clicked into, and a note that opens fully rendered is the correct first
 * frame.
 */
export const focused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});

/** Feeds DOM focus/blur into {@link focused}. */
export const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
  setFocused.of(focusing),
);

/** `focused` + its tracker. Registered by `livePreview()` so every consumer of
 *  the reveal rules (livePreview, tasks, wikilinks, ofm) sees the same field. */
export const revealState = [focused, focusTracker];

/** Is the editor focused? Safe on a state that never registered the field. */
export function isFocused(state: EditorState): boolean {
  return state.field(focused, false) ?? false;
}

/**
 * "Did focus move in this update?" — the rebuild trigger every reveal-aware view
 * plugin needs.
 *
 * Both halves are load-bearing. `u.focusChanged` is CodeMirror's own signal from
 * real DOM focus; the effect scan catches a `setFocused` dispatched directly,
 * which is how tests drive focus (CodeMirror notices real focus on a 10 ms
 * timeout, so a synchronous test can never see it).
 */
export function focusMoved(u: ViewUpdate): boolean {
  return (
    u.focusChanged ||
    u.transactions.some((tr) => tr.effects.some((e) => e.is(setFocused)))
  );
}

/**
 * "Does any selection range touch `[from, to]`?" — the TOKEN scope.
 *
 * Returns a constant `false` while the editor is blurred, so a stale caret
 * position cannot keep a span raw after you click away.
 */
export function selectionTouches(state: EditorState): (from: number, to: number) => boolean {
  if (!isFocused(state)) return () => false;
  const ranges = state.selection.ranges;
  return (from, to) => ranges.some((r) => r.from <= to && from <= r.to);
}

/**
 * Does `[from, to]` share a line with any selection range? The LINE scope with
 * the focus rule left off — livePreview's block memoisation has to ask this
 * about a state whose focus flag has just flipped.
 */
export function lineSpanChecker(state: EditorState): (from: number, to: number) => boolean {
  const doc = state.doc;
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number;
    const last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }
  return (from: number, to: number) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(Math.max(from, to)).number;
    for (let n = first; n <= last; n++) if (activeLines.has(n)) return true;
    return false;
  };
}

/**
 * Lines touched by any selection stay "raw" so the writer edits real markdown.
 * Shared by livePreview's inline plugin, its block-widget field, ./tasks.ts and
 * ./ofm/callout.ts, so all of them agree on what "being edited" means.
 *
 * A BLURRED editor has no active line at all: the caret it is still carrying is
 * not where anyone is looking.
 */
export function activeLineChecker(state: EditorState): (from: number, to: number) => boolean {
  if (!isFocused(state)) return () => false;
  return lineSpanChecker(state);
}

/**
 * The inline constructs a marker can belong to. `Link`/`Image` are here so the
 * `[`, `]`, `(`, `)` and the URL of one link reveal together while the link
 * next to it stays rendered.
 */
export const INLINE_TOKEN_NODES = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Highlight",
  "OfmComment",
  "Link",
  "Image",
]);

/**
 * The nearest enclosing inline construct, or `null`. Walks at most six parents:
 * markdown nests emphasis inside emphasis inside a link inside a heading, and
 * an unbounded walk would reach the document root for every plain `*` in the
 * note and then treat the whole doc as the token.
 */
export function tokenOwner(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  for (let depth = 0; current && depth <= 6; depth++) {
    if (INLINE_TOKEN_NODES.has(current.name)) return current;
    current = current.parent;
  }
  return null;
}
