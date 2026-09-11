// CodeMirror 6 wiki-link support:
//  1. `[[` autocomplete sourced from the note-title index.
//  2. Decoration that styles `[[target]]` occurrences as clickable links, and
//     — off the selection — shows what you MEAN rather than what you typed:
//       [[Note]]           → Note
//       [[Note|label]]     → label
//       [[Note#Heading]]   → Note › Heading
//       [[Note#H|label]]   → label
//     Put the caret on one and the raw brackets come back for editing, on the
//     same TOKEN rule as the rest of live preview (see ./reveal.ts).
//  3. Click / cmd-click on a link navigates to the target note.
//
// Kept dependency-light and origin-agnostic so Phase 1's Yjs binding can be
// layered on without touching this file.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { NoteTitle } from "../ipc";
import { focusMoved, selectionTouches } from "./reveal";

/**
 * `[[target]]`, `[[target|alias]]`, `[[target#heading]]` — a FRESH regex per
 * call. A module-level `/g` regex carries `lastIndex` between calls, so two
 * consumers (this module and livePreview.ts's "don't touch wiki-link marks"
 * scan) sharing one instance silently skip every other match. Exported so
 * livePreview.ts can ask the same question without duplicating the literal.
 */
export const wikilinkRe = (): RegExp => /\[\[([^\]\n]+)\]\]/g;

export interface WikilinkOptions {
  /** Current note titles for autocomplete (read fresh on each request). */
  getTitles: () => NoteTitle[];
  /** Navigate to a target name (resolve + open, create-on-click if dangling). */
  onNavigate: (target: string) => void;
}

// ---- Autocomplete ---------------------------------------------------------

export function wikilinkCompletions(opts: WikilinkOptions) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match an open `[[` up to the cursor, without a closing `]]` yet.
    const before = context.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    if (before.from === before.to && !context.explicit) return null;

    const typed = before.text.slice(2).toLowerCase();
    const options: Completion[] = opts
      .getTitles()
      .filter((t) => {
        const base = t.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
        return (
          t.title.toLowerCase().includes(typed) ||
          base.toLowerCase().includes(typed)
        );
      })
      .slice(0, 50)
      .map((t) => {
        const base = t.path.split("/").pop()?.replace(/\.md$/i, "") ?? t.title;
        return {
          label: base,
          detail: t.title !== base ? t.title : undefined,
          // Insert the base name + closing brackets, cursor after `]]`.
          apply: `${base}]]`,
        };
      });

    return {
      from: before.from + 2,
      options,
      filter: false,
    };
  };
}

// ---- Decoration + click navigation ---------------------------------------

const wikilinkMark = Decoration.mark({ class: "cm-wikilink" });
const hidden = Decoration.replace({});

/** The `›` between a note and the heading inside it. Not document text — the
 *  file still says `#`, so nothing round-trips differently. */
class HeadingSepWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-wikilink-sep";
    s.textContent = "›";
    return s;
  }
}

const headingSep = Decoration.replace({ widget: new HeadingSepWidget() });

function buildDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const touches = selectionTouches(view.state);
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = wikilinkRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = from + m.index;
      const end = start + m[0].length;
      decos.push(wikilinkMark.range(start, end));
      if (touches(start, end)) continue;

      // Inner span, i.e. everything between the brackets.
      const innerFrom = start + 2;
      const inner = m[1];
      const pipe = inner.indexOf("|");
      const hash = inner.indexOf("#");
      if (pipe >= 0) {
        // An alias speaks for the whole link: show only what follows the `|`.
        decos.push(hidden.range(start, innerFrom + pipe + 1));
        decos.push(hidden.range(end - 2, end));
      } else if (hash >= 0) {
        // `Note#Heading` → `Note › Heading`.
        decos.push(hidden.range(start, innerFrom));
        decos.push(headingSep.range(innerFrom + hash, innerFrom + hash + 1));
        decos.push(hidden.range(end - 2, end));
      } else {
        decos.push(hidden.range(start, innerFrom));
        decos.push(hidden.range(end - 2, end));
      }
    }
  }
  // `true` = sort: marks and replaces are interleaved here, and a RangeSetBuilder
  // would throw on the out-of-order pairs this emits.
  return Decoration.set(decos, true);
}

/** Extract the wiki-link target at a document position, if any. */
function targetAtPos(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const re = wikilinkRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      // Strip alias (`|`) and heading (`#`) → resolution target.
      return m[1].split("|")[0].split("#")[0].trim();
    }
  }
  return null;
}

export function wikilinks(opts: WikilinkOptions) {
  const decorationPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(u: ViewUpdate) {
        // Selection and focus matter now that the brackets fold away off the
        // caret (they did not when this only painted a colour).
        if (u.docChanged || u.viewportChanged || u.selectionSet || focusMoved(u)) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          // The syntax highlighter nests its own spans *inside* the
          // `cm-wikilink` mark, so a click usually lands on a child span that
          // doesn't carry the class — walk up to the link element (same
          // pattern as the cm-md-link handler in livePreview).
          const target = (event.target as HTMLElement).closest(
            ".cm-wikilink"
          ) as HTMLElement | null;
          if (!target) return false;
          const pos = view.posAtDOM(target);
          const name = targetAtPos(view, pos);
          if (name) {
            event.preventDefault();
            opts.onNavigate(name);
            return true;
          }
          return false;
        },
      },
    }
  );

  // Autocomplete is registered centrally (see editor/index.ts) so the wiki-link
  // and slash-command sources share one autocompletion config.
  return decorationPlugin;
}
