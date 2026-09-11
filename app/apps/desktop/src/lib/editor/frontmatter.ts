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
  Facet,
  type Range,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { parseFrontmatter } from "../frontmatter/parse";

export interface FrontmatterRange {
  /** Start of the opening fence line (always 0). */
  from: number;
  /** End of the closing fence line. */
  to: number;
  /** 1-based line number of the opening fence. Always 1. */
  openLine: number;
  /** 1-based line number of the closing fence. */
  closeLine: number;
  /** First char of the YAML body (after the opening fence's newline). Equals
   *  `contentTo` for an empty `---\n---` block. */
  contentFrom: number;
  /** Last char of the YAML body (before the closing fence's newline). */
  contentTo: number;
}

/**
 * How the frontmatter is drawn — the "Properties in document" setting.
 *
 * Defaults to `source` so that an editor built without the note header (the
 * version-preview view, the geometry tests) keeps Stage 1's dimmed block. The
 * real value is supplied by `noteHeader`, through a Compartment so the setting
 * reconfigures the live view instead of rebuilding it.
 */
export type PropertiesMode = "visible" | "hidden" | "source";

export const propertiesMode = Facet.define<PropertiesMode, PropertiesMode>({
  combine: (values) => values[0] ?? "source",
});

/**
 * Which of the three renderings the region gets right now. ONE authority, so
 * the panel's block replace and this module's dimmed block can never both be
 * emitted over the same lines (two block replaces on one range throw).
 *
 * `source` wins whenever the caret is inside the region — the code-fence rule,
 * reused: a peer's cursor landing in the frontmatter, or a search hit there,
 * must show real YAML rather than a panel that is silently read-only. It also
 * wins when the YAML is outside the subset we can edit, because a panel we
 * cannot round-trip would be a panel that rewrites someone's file.
 */
export type FrontmatterView = "source" | "panel" | "collapsed" | "invalid";

export function frontmatterView(state: EditorState): FrontmatterView {
  const fm = state.field(frontmatterField, false) ?? null;
  if (!fm) return "source";
  const mode = state.facet(propertiesMode);
  if (mode === "source") return "source";
  if (selectionInside(state.selection.ranges, fm)) return "source";
  if (!parseFrontmatter(state.doc, fm).ok) return "invalid";
  return mode === "hidden" ? "collapsed" : "panel";
}

/**
 * Is a cursor really INSIDE the region, rather than parked at its edge?
 *
 * Strict containment, unlike the fence-hiding rule below. A fresh view's
 * selection sits at position 0 — the start of the opening fence — so an
 * inclusive test would drop every note with frontmatter into source mode the
 * moment it opened, which is the opposite of the feature. `fm.to` is excluded
 * at the other end for the same reason: ↑ from the first body line lands there.
 * What this DOES catch is the case the rule exists for — a search hit, a
 * teammate's cursor, or a caret mapped in by a change — where a panel that is
 * silently read-only would be a lie.
 */
function selectionInside(
  ranges: readonly { from: number; to: number }[],
  fm: FrontmatterRange,
): boolean {
  return ranges.some((r) => r.from > fm.from && r.to < fm.to);
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
      return {
        from: 0,
        to: line.to,
        openLine: 1,
        closeLine: n,
        contentFrom: doc.line(2).from,
        // An empty block (`---\n---`) has no content lines at all, so the span
        // collapses onto the closing fence's start.
        contentTo: n === 2 ? line.from : doc.line(n - 1).to,
      };
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
export function selectionTouches(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number
): boolean {
  return ranges.some((r) => r.from <= to && from <= r.to);
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const fm = state.field(frontmatterField);
  if (!fm) return Decoration.none;
  // The Properties panel (and the collapsed mode) own the region instead —
  // `noteHeader.ts` puts a block replace over exactly these lines, and a second
  // block replace on the same range throws. `invalid` DOES keep this dimmed
  // block (under noteHeader's banner), minus the fence hiding below: someone
  // fixing their YAML by hand needs to see the whole block.
  const presentation = frontmatterView(state);
  if (presentation === "panel" || presentation === "collapsed") return Decoration.none;
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
  if (
    hasContent &&
    presentation !== "invalid" &&
    !selectionTouches(state.selection.ranges, fm.from, fm.to)
  ) {
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
      tr.docChanged ||
      tr.selection ||
      // The display-mode Compartment reconfiguring is neither of those.
      tr.startState.facet(propertiesMode) !== tr.state.facet(propertiesMode)
        ? buildFrontmatterDecorations(tr.state)
        : value,
    provide: (f) => EditorView.decorations.from(f),
  }),
];
