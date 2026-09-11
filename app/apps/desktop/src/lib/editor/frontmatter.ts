/**
 * YAML frontmatter as the editor sees it.
 *
 * Deliberately NOT a parser. The region is always a prefix of the document, so a
 * short scan finds it — and finding it the same way Rust does matters more than
 * finding it elegantly: `src-tauri/src/parse.rs split_frontmatter` decides what
 * the index, the search body and `notes.frontmatter` contain, and a disagreement
 * here would dim text the index treats as body (or leave real frontmatter
 * rendered as a giant Setext heading). Rules copied from there:
 *   - the opening `---` must be the very first thing in the file (`---\n` or
 *     `---\r\n`) — nothing else on that line, not even a trailing space;
 *   - the closing `---` must start a line and end one;
 *   - no closing fence ⇒ there is no frontmatter, and the whole file is body.
 *
 * Stage 1 renders the region as a compact dimmed monospace block with the fences
 * hidden while the caret is elsewhere. Stage 2 replaces the decorations below
 * with one block replace widget (the Properties table) over `[from, to]` — the
 * RANGE is the contract, so that swap touches only `frontmatterDecorations`.
 *
 * `@codemirror/lang-yaml` is deliberately not used: it is two new dependencies,
 * and `yamlFrontmatter()` replaces the whole markdown `LanguageSupport`, which
 * would re-route every decoration path in blocks.ts / livePreview.ts / tasks.ts
 * through a different top-level parse for what is a visual effect.
 */

import {
  type EditorState,
  type Extension,
  type Range,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export interface FrontmatterRange {
  /** Start of the opening fence line (always 0). */
  from: number;
  /** End of the closing fence line. */
  to: number;
  /** 1-based line number of the opening fence. Always 1. */
  openLine: number;
  /** 1-based line number of the closing fence. */
  closeLine: number;
}

/** A fence line is exactly `---`, ignoring the CR of a CRLF document. */
function isFence(text: string): boolean {
  return (text.endsWith("\r") ? text.slice(0, -1) : text) === "---";
}

/**
 * The frontmatter region, or null when the document has none. Mirrors Rust's
 * `split_frontmatter` case for case (see the module comment).
 */
export function findFrontmatter(doc: Text): FrontmatterRange | null {
  if (doc.lines < 2) return null;
  if (!isFence(doc.line(1).text)) return null;
  for (let n = 2; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (isFence(line.text)) {
      return { from: 0, to: line.to, openLine: 1, closeLine: n };
    }
  }
  return null;
}

/**
 * The range, recomputed only on document change. Read by `blocks.ts` and
 * `livePreview.ts` so nothing else decorates inside the region.
 */
export const frontmatterField = StateField.define<FrontmatterRange | null>({
  create: (state) => findFrontmatter(state.doc),
  update: (value, tr) => (tr.docChanged ? findFrontmatter(tr.newDoc) : value),
});

/** True when any selection range touches `[from, to]` — inclusive, so a caret
 *  parked at either edge counts as "being edited". */
function selectionTouches(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number
): boolean {
  return ranges.some((r) => r.from <= to && from <= r.to);
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const fm = state.field(frontmatterField);
  if (!fm) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const line = Decoration.line({ class: "cm-frontmatter" });
  const fence = Decoration.line({ class: "cm-frontmatter cm-frontmatter-fence" });
  for (let n = fm.openLine; n <= fm.closeLine; n++) {
    const l = state.doc.line(n);
    decos.push((n === fm.openLine || n === fm.closeLine ? fence : line).range(l.from));
  }
  // Hide the fences while the caret is elsewhere — a whole-line block replace
  // with no widget collapses the line out of the layout. The content-line guard
  // matters: both fences hidden on an empty `---\n---` block would leave it
  // invisible and unreachable by caret, so those stay visible.
  const hasContent = fm.closeLine - fm.openLine >= 2;
  if (hasContent && !selectionTouches(state.selection.ranges, fm.from, fm.to)) {
    const collapse = Decoration.replace({ block: true });
    for (const n of [fm.openLine, fm.closeLine]) {
      const l = state.doc.line(n);
      decos.push(collapse.range(l.from, l.to));
    }
  }
  return Decoration.set(decos, true);
}

/**
 * Line classes plus off-region fence hiding. A StateField, not a view plugin:
 * CodeMirror rejects block decorations supplied by a plugin.
 */
export const frontmatterDecorations: Extension = [
  frontmatterField,
  StateField.define<DecorationSet>({
    create: (state) => buildFrontmatterDecorations(state),
    update: (value, tr) =>
      tr.docChanged || tr.selection
        ? buildFrontmatterDecorations(tr.state)
        : value,
    provide: (f) => EditorView.decorations.from(f),
  }),
];
