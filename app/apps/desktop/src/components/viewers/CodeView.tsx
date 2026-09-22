// Source files, JSON and `.canvas`: a read-only CodeMirror.
//
// Read-only means BOTH halves of the pair the editor uses for a locked note
// (`Editor.tsx`): `EditorState.readOnly` refuses the transactions, and
// `EditorView.editable` takes the DOM out of `contenteditable` so there is no
// caret to invite typing in the first place. These files are attachments —
// there is no CRDT doc, no bridge, and nothing here would ever reach disk.
//
// The grammar is the registry's (`FormatDef.cmLang`), always a dynamic import,
// so a vault with no `.py` in it never fetches the Python parser. The
// highlight style is the app's own `markdownHighlight` — its code tags
// (keyword/string/number/comment) are mapped onto our tokens precisely so code
// looks the same in a fence and in a file; CodeMirror's `defaultHighlightStyle`
// is deliberately never imported anywhere (see `editor/theme.ts`).

import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { formatFor } from "../../lib/formats";
import { markdownHighlight } from "../../lib/editor/theme";
import * as ipc from "../../lib/ipc";
import { useStore } from "../../store";
import { FileCard } from "./FileCard";
import type { ViewerProps } from "./types";

/** The note ceiling (`MAX_NOTE_BYTES`), reused: past it a "text" file is a log
 *  or a dump, and CodeMirror would spend a minute laying it out. */
export const MAX_CODE_BYTES = 10 * 1024 * 1024;

/** A plain monospace sheet. Not `editorTheme`: that one is tuned for prose —
 *  body font, reading measure, the `--editor-pad-x` inset on `.cm-line` — and
 *  code wants none of it. */
const codeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-sm)",
  },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.6" },
  ".cm-content": { padding: "var(--sp-4) 0" },
  ".cm-line": { padding: "0 var(--sp-4)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-subtle)",
    color: "var(--text-faint)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
});

export function CodeView({ path, abs }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    const epoch = useStore.getState().vault?.epoch;

    void (async () => {
      try {
        const stat = await ipc.fileStat(path, epoch);
        if (cancelled) return;
        if (stat.size > MAX_CODE_BYTES) {
          setError(
            `This file is larger than ${Math.round(MAX_CODE_BYTES / (1024 * 1024))} MB, ` +
              `too big to open here.`,
          );
          return;
        }
        const bytes = await ipc.readBinaryFile(path, epoch);
        if (cancelled) return;
        setText(new TextDecoder("utf-8").decode(bytes));
      } catch (e) {
        if (!cancelled) {
          console.error("code preview failed", e);
          setError("Couldn't read this file.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (text == null || !hostRef.current) return;
    let view: EditorView | null = null;
    let cancelled = false;

    void (async () => {
      let lang: Extension = [];
      try {
        lang = (await formatFor(path)?.cmLang?.()) ?? [];
      } catch (e) {
        // A grammar that failed to load is a worse-looking view, not a broken
        // one: plain text still reads.
        console.error("grammar load failed", e);
      }
      if (cancelled || !hostRef.current) return;
      view = new EditorView({
        state: EditorState.create({
          doc: text,
          extensions: [
            lineNumbers(),
            EditorView.lineWrapping,
            lang,
            markdownHighlight,
            codeTheme,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        }),
        parent: hostRef.current,
      });
    })();

    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [text, path]);

  if (error) return <FileCard path={path} abs={abs} reason={error} />;

  return (
    <div className="file-preview file-preview-code" data-viewer="code">
      <div className="file-preview-body">
        {text == null ? (
          <div className="editor-empty">Loading…</div>
        ) : (
          <div className="file-code-host" ref={hostRef} />
        )}
      </div>
    </div>
  );
}
