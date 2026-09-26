/* Read-only compare of two texts with @codemirror/merge: side by side
   (MergeView) when there is room, unified (one editor with the left side as
   the original) when narrow. Changed lines are tinted, the exact changed
   characters highlighted, with a gutter marker per changed line. Colours come
   from the `--diff-*` variables in `components/compare.css`. */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { readOnlyEditorExtensions } from "./index";

/** Below this width the two panes stack into one unified view. */
export const UNIFIED_BELOW_PX = 720;

/** Look options shared by every read-only pane: the note path picks the
 *  grammar (a `.txt` gets none), `lineNumbers` mirrors the editor's pref. */
export interface ViewLook {
  path?: string;
  lineNumbers?: boolean;
}

function looks(look: ViewLook): Extension[] {
  return readOnlyEditorExtensions(look);
}

export interface CompareHandle {
  destroy(): void;
}

export function mountCompare(
  parent: HTMLElement,
  left: string,
  right: string,
  mode: "split" | "unified",
  look: ViewLook = {},
): CompareHandle {
  if (mode === "split") {
    const view = new MergeView({
      a: { doc: left, extensions: looks(look) },
      b: { doc: right, extensions: looks(look) },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return { destroy: () => view.destroy() };
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: right,
      extensions: [
        ...looks(look),
        unifiedMergeView({
          original: left,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
          syntaxHighlightDeletions: false,
          collapseUnchanged: { margin: 3, minSize: 8 },
        }),
      ],
    }),
  });
  return { destroy: () => view.destroy() };
}

/** A plain read-only viewer, for an opened copy or a Trash preview. */
export function mountReadOnly(parent: HTMLElement, text: string, look: ViewLook = {}): CompareHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, extensions: looks(look) }),
  });
  return { destroy: () => view.destroy() };
}
