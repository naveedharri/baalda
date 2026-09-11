import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { frontmatterField } from "../lib/editor/frontmatter";
import { bodyStart, getHeaderFocus, registerHeaderFocus } from "../lib/editor/headerFocus";
import { addPropertyToNote } from "./properties/PropertiesPanel";
import { planInlineTitleRename, TITLE_REFUSAL_MESSAGE } from "../lib/editor/titlePlan";
import { stemOf } from "../lib/notePath";
import { useStore } from "../store";

/**
 * The note's name, at the top of the note, as a real `<input>`.
 *
 * The title IS the filename, so committing it is a RENAME — never a document
 * edit, never a CRDT write. That is why this is an input over a decoration
 * rather than the first line of the buffer: a title that lived in the text would
 * be a second source of truth for a note's identity, and the whole product rests
 * on there being exactly one.
 *
 * Refusals are inline and specific (see `titlePlan.ts`), and a collision keeps
 * focus rather than silently landing the user on `Name 1`.
 */
export function InlineTitle({
  view,
  path,
  readOnly,
  hasFrontmatter,
  renameTo,
  noteExists,
}: {
  view: EditorView;
  path: string;
  readOnly: boolean;
  hasFrontmatter: boolean;
  renameTo: (nextPath: string) => Promise<string | null>;
  noteExists: (path: string) => Promise<boolean>;
}) {
  const stem = stemOf(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Read by the commit path so a stale closure can't rename to an old draft.
  const draftRef = useRef<string | null>(null);
  draftRef.current = draft;
  const pathRef = useRef(path);
  pathRef.current = path;

  const value = draft ?? stem;

  const commit = useCallback(async () => {
    const typed = draftRef.current;
    if (typed === null) return;
    const plan = planInlineTitleRename(pathRef.current, typed);
    if (!plan.ok) {
      if (plan.reason === "unchanged") {
        setDraft(null);
        setWarning(null);
        return;
      }
      setWarning(TITLE_REFUSAL_MESSAGE[plan.reason]);
      inputRef.current?.focus();
      return;
    }
    // Case-insensitive by way of the filesystem: `resolve_in_vault` goes
    // through the real path, and macOS treats `Foo.md` and `foo.md` as one.
    if (await noteExists(plan.nextPath)) {
      setWarning(`A note called "${plan.stem}" already exists here.`);
      inputRef.current?.focus();
      return;
    }
    const failure = await renameTo(plan.nextPath);
    if (failure) {
      setWarning(failure);
      inputRef.current?.focus();
      return;
    }
    setDraft(null);
    setWarning(null);
  }, [noteExists, renameTo]);

  // A pending rename must survive the widget going away — a note switch, ⌘N, or
  // the window closing all unmount us with the draft uncommitted. The widget's
  // `destroy` runs this before React unmounts the root.
  useEffect(() => {
    const flush = () => {
      if (draftRef.current !== null) void commit();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [commit]);

  const toBody = useCallback(() => {
    const fm = view.state.field(frontmatterField, false) ?? null;
    view.dispatch({ selection: { anchor: bodyStart(fm, view.state.doc.length) } });
    view.focus();
  }, [view]);

  // A note that was just created lands here with its name selected: ⌘N (or the
  // sidebar's +) creates an EMPTY note called `Untitled`, and typing over that
  // is the whole naming flow. Consumed once, by the widget itself, because the
  // widget mounts several awaits after the create.
  useEffect(() => {
    const store = useStore.getState();
    if (store.pendingTitleFocus !== path) return;
    store.setPendingTitleFocus(null);
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [path]);

  useEffect(() => {
    registerHeaderFocus(view, {
      focusTitle: (select?: boolean) => {
        const el = inputRef.current;
        if (!el) return false;
        el.focus();
        if (select) el.select();
        return true;
      },
    });
  }, [view]);

  return (
    <div className="inline-title-wrap">
      <input
        ref={inputRef}
        className="inline-title-input"
        type="text"
        value={value}
        readOnly={readOnly}
        aria-readonly={readOnly}
        aria-label="Note name"
        placeholder="Untitled"
        spellCheck
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="done"
        onChange={(e) => {
          if (readOnly) return;
          setWarning(null);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit().then(() => {
              if (draftRef.current === null) toBody();
            });
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            setWarning(null);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!getHeaderFocus(view).focusFirstProperty?.()) toBody();
            return;
          }
          if (e.key === ";" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            addPropertyToNote(view);
          }
        }}
        onBlur={() => void commit()}
      />
      {warning && (
        <p className="inline-title-warning" role="alert">
          {warning}
        </p>
      )}
      {!hasFrontmatter && !readOnly && (
        <button
          type="button"
          className="inline-title-add"
          onClick={() => addPropertyToNote(view)}
        >
          Add property
        </button>
      )}
    </div>
  );
}
