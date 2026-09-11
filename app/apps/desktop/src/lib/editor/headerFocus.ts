/**
 * Focus handoffs across the widget boundary.
 *
 * Events inside a block widget never reach CodeMirror (`ignoreEvent()` is true,
 * so `eventBelongsToEditor` stops at the host), which is exactly what makes the
 * editor keymap inert while a title or a property field has focus. The price is
 * that every move ACROSS that boundary — ↑ from the first body line to the
 * title, ↓ from the last property row into the body — has to be an explicit
 * `element.focus()` / `view.focus()`. This is where the two sides find each
 * other.
 *
 * Its own module, with no React imports, so `noteHeader.ts` can pull in the
 * components while the components pull in these helpers, with no cycle.
 */

import type { EditorView } from "@codemirror/view";
import type { FrontmatterRange } from "./frontmatter";

export interface HeaderFocus {
  focusTitle(select?: boolean): boolean;
  focusFirstProperty(): boolean;
  focusLastProperty(): boolean;
}

const registry = new WeakMap<EditorView, Partial<HeaderFocus>>();

/** Register one widget's hooks; the title and the panel each contribute. */
export function registerHeaderFocus(view: EditorView, part: Partial<HeaderFocus>): void {
  registry.set(view, { ...registry.get(view), ...part });
}

export function getHeaderFocus(view: EditorView): Partial<HeaderFocus> {
  return registry.get(view) ?? {};
}

/** First document position of the body — after the frontmatter, or 0. */
export function bodyStart(fm: FrontmatterRange | null, docLength: number): number {
  if (!fm) return 0;
  return Math.min(docLength, fm.to + 1);
}
