import { useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";

/**
 * HTML files are *previewed*, never *run*: the page renders inside a fully
 * locked-down sandboxed iframe (no `allow-scripts`, so no markup ever executes)
 * with a Preview/Source toggle, Preview being the default. HTML files are
 * local-only — they don't join the CRDT sync like notes do.
 */
export function HtmlView({ path }: { path: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    let cancelled = false;
    setMode("preview");
    setDirty(false);

    const load = async () => {
      try {
        const text = await ipc.readNote(path);
        if (cancelled) return;
        setContent(text);
        setDraft(text);
      } catch (e) {
        console.error("read html failed", e);
        if (!cancelled) setContent("");
      }
    };
    void load();

    // Follow external edits, but never clobber an unsaved source draft. An
    // `unchanged` event (#155) is by definition not an edit — same sha256 as the
    // index already held — so re-reading the file would only re-render what is
    // already on screen.
    let unlisten: (() => void) | undefined;
    void ipc.onFileChanged((e) => {
      if (e.path === path && e.kind === "modified" && !e.unchanged && !dirtyRef.current) {
        void load();
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [path]);

  const save = async () => {
    try {
      await ipc.writeNote(path, draft);
      setContent(draft);
      setDirty(false);
    } catch (e) {
      console.error("save html failed", e);
    }
  };

  if (content === null) {
    return <div className="editor-empty">Loading…</div>;
  }

  return (
    <div className="html-view">
      <div className="html-toolbar">
        <div className="segmented html-tabs">
          <button
            type="button"
            className={mode === "preview" ? "active" : ""}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            className={mode === "source" ? "active" : ""}
            onClick={() => setMode("source")}
          >
            Source
          </button>
        </div>
        {mode === "source" && (
          <button className="primary sm" disabled={!dirty} onClick={() => void save()}>
            {dirty ? "Save" : "Saved"}
          </button>
        )}
      </div>
      {mode === "preview" ? (
        <iframe
          className="html-frame"
          title={path}
          // No `allow-scripts`: the page is rendered for preview, never run.
          sandbox=""
          srcDoc={content}
        />
      ) : (
        <textarea
          className="html-source"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(e.target.value !== content);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
      )}
    </div>
  );
}
