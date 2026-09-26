/* Read-only compare of two texts with @codemirror/merge: side by side
   (MergeView) when there is room, unified (one editor with the left side as
   the original) when narrow. Changed lines are tinted, the exact changed
   characters highlighted, with a gutter marker per changed line. Colours come
   from the `--diff-*` variables in `components/compare.css`. */
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { MergeView, unifiedMergeView } from "@codemirror/merge";

/** Below this width the two panes stack into one unified view. */
export const UNIFIED_BELOW_PX = 720;

function readOnlyExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    lineNumbers(),
    markdown({ base: markdownLanguage }),
  ];
}

export interface CompareHandle {
  destroy(): void;
}

export function mountCompare(
  parent: HTMLElement,
  left: string,
  right: string,
  mode: "split" | "unified",
): CompareHandle {
  if (mode === "split") {
    const view = new MergeView({
      a: { doc: left, extensions: readOnlyExtensions() },
      b: { doc: right, extensions: readOnlyExtensions() },
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
        ...readOnlyExtensions(),
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
export function mountReadOnly(parent: HTMLElement, text: string): CompareHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, extensions: readOnlyExtensions() }),
  });
  return { destroy: () => view.destroy() };
}
