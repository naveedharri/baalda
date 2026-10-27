// A standalone CodeMirror 6 view for one skill draft file. Not the note editor:
// that one is bound to a note's Y.Doc and the bridge, and a skill draft is plain
// text saved over HTTP. What it shares is the look: the app's highlight style
// (`markdownHighlight`, whose code tags are mapped onto our tokens), selection
// colours and accent caret.
//
// One EditorState per file path is kept while the editor is mounted, so undo
// and redo are per file and switching files keeps each one's history, cursor
// and scroll. A change from outside (the SKILL.md header, a save that reloaded
// the draft) is applied as the minimal changed range, so it lands in that
// file's history like any other edit.

import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { codeLanguages } from "../../lib/editor/codeLanguages";
import { markdownHighlight } from "../../lib/editor/theme";
import { formatFor } from "../../lib/formats";

/** A path may carry a `#view` suffix (SKILL.md's body) to get its own history. */
const filePath = (path: string) => path.replace(/#.*$/, "");

function isProse(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(filePath(path));
}

async function languageFor(path: string): Promise<Extension> {
  path = filePath(path);
  try {
    if (isProse(path)) {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown({ codeLanguages });
    }
    return (await formatFor(path)?.cmLang?.()) ?? [];
  } catch {
    // A grammar that failed to load leaves plain text, which still edits fine.
    return [];
  }
}

const shared = {
  "&": { height: "100%", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", scrollBehavior: "smooth" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection-bg-inactive)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection-bg)",
  },
  // A whisper of the caret's line while typing; nothing when the editor isn't focused.
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 22%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--text-faint)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-secondary)" },
};

/** Markdown reads as prose: the note editor's body font and line height. */
const proseTheme = EditorView.theme({
  ...shared,
  "&": { ...shared["&"], fontFamily: "var(--font-body)", fontSize: "var(--fs-md)" },
  ".cm-scroller": { ...shared[".cm-scroller"], fontFamily: "var(--font-body)", lineHeight: "var(--lh-body)" },
  ".cm-content": { padding: "var(--sp-4) 0 var(--sp-8)" },
  ".cm-line": { padding: "0 var(--sp-5)" },
});

/** Code files: monospace with line numbers. */
const codeTheme = EditorView.theme({
  ...shared,
  "&": { ...shared["&"], fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" },
  ".cm-scroller": { ...shared[".cm-scroller"], fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "var(--sp-3) 0 var(--sp-8)" },
  ".cm-line": { padding: "0 var(--sp-4) 0 var(--sp-2)" },
  ".cm-gutters": { ...shared[".cm-gutters"], paddingLeft: "var(--sp-2)" },
});

/** The smallest replace that turns `from` into `to`. */
function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endA = from.length;
  let endB = to.length;
  while (endA > start && endB > start && from.charCodeAt(endA - 1) === to.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: to.slice(start, endB) };
}

export function SkillCodeEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
}: {
  /** Identifies the file: each path keeps its own undo history. */
  path: string;
  value: string;
  onChange: (text: string) => void;
  /** ⌘S / Ctrl+S. */
  onSave: () => void;
  /** View only (a skill on this computer): selectable, never editable. */
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const pathRef = useRef(path);
  const external = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const create = (p: string, doc: string): EditorState => {
    const lang = new Compartment();
    const state = EditorState.create({
      doc,
      extensions: [
        isProse(p) ? [] : [lineNumbers(), highlightActiveLineGutter()],
        history(),
        EditorState.readOnly.of(readOnly),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (onSaveRef.current(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        lang.of([]),
        markdownHighlight,
        isProse(p) ? proseTheme : codeTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !external.current && pathRef.current === p) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    void languageFor(p).then((ext) => {
      const view = viewRef.current;
      const effect = lang.reconfigure(ext);
      if (view && pathRef.current === p) view.dispatch({ effects: effect });
      else {
        const cached = states.current.get(p);
        if (cached) states.current.set(p, cached.update({ effects: effect }).state);
      }
    });
    return state;
  };

  // Mount once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({ state: create(path, value), parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch files: park the old state, bring back (or create) the new one.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    states.current.set(pathRef.current, view.state);
    pathRef.current = path;
    let next = states.current.get(path) ?? create(path, value);
    const change = minimalChange(next.doc.toString(), value);
    if (change) next = next.update({ changes: change }).state;
    view.setState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // A change made outside the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current !== path) return;
    const change = minimalChange(view.state.doc.toString(), value);
    if (!change) return;
    external.current = true;
    try {
      view.dispatch({ changes: change });
    } finally {
      external.current = false;
    }
  }, [value, path]);

  return <div ref={hostRef} className="skills-cm" />;
}
