import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { frontmatterField } from "../lib/editor/frontmatter";
import { bodyStart, getHeaderFocus, registerHeaderFocus } from "../lib/editor/headerFocus";
import { addPropertyToNote, viewOnlyNotice } from "./properties/PropertiesPanel";
import { planInlineTitleRename, TITLE_REFUSAL_MESSAGE } from "../lib/editor/titlePlan";
import {
  clearTitlePresence,
  noteAwareness,
  publishTitlePresence,
  readTitlePeers,
  titleCaretX,
  type TitlePeer,
} from "../lib/editor/titlePresence";
import { stemOf } from "../lib/notePath";
import { useStore } from "../store";

/** A teammate's title caret, resolved to offsets within `.inline-title-wrap`. */
interface TitleCaret extends TitlePeer {
  left: number;
  top: number;
  height: number;
  flip: boolean;
}

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
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // The note's awareness (null for views without sync, e.g. version preview).
  const awareness = view.state.facet(noteAwareness);

  // Access revoked while a rename was being typed: the draft is void. Renaming
  // needs edit permission on the server (PATCH /api/notes/:id), so a commit
  // after the flip would only be refused there.
  useEffect(() => {
    if (!readOnly) return;
    setDraft(null);
    setWarning(null);
    if (awareness) clearTitlePresence(awareness);
  }, [readOnly, awareness]);

  const value = draft ?? stem;

  // ---- Title presence: publish ours, draw teammates' (see titlePresence.ts).
  // Subscribed here rather than through the widget's `eq()`, so a teammate
  // moving in the title never re-mounts the widget or steals our focus.
  const [peers, setPeers] = useState<TitlePeer[]>([]);
  const [carets, setCarets] = useState<TitleCaret[]>([]);
  const [measureTick, remeasure] = useReducer((n: number) => n + 1, 0);

  const publish = useCallback(() => {
    const el = inputRef.current;
    if (!awareness || !el || readOnlyRef.current) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    publishTitlePresence(awareness, start, end, el.selectionDirection === "backward");
  }, [awareness]);

  useEffect(() => {
    if (!awareness) return;
    let last = "";
    const onChange = () => {
      const next = readTitlePeers(awareness);
      const key = JSON.stringify(next);
      if (key === last) return; // our own publishes, body-only moves
      last = key;
      setPeers(next);
    };
    onChange();
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
      clearTitlePresence(awareness);
    };
  }, [awareness]);

  // Measured after commit, so the input already holds `value` and its scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || peers.length === 0) {
      setCarets((prev) => (prev.length ? [] : prev));
      return;
    }
    const style = getComputedStyle(el);
    const padTop = parseFloat(style.paddingTop) || 0;
    const height = el.clientHeight - padTop - (parseFloat(style.paddingBottom) || 0);
    const top = el.offsetTop + (parseFloat(style.borderTopWidth) || 0) + padTop;
    // Hang the flag below when there is no room above (same rule as the body).
    const flip =
      el.getBoundingClientRect().top - view.scrollDOM.getBoundingClientRect().top < 20;
    setCarets(
      peers.map((p) => ({
        ...p,
        left: el.offsetLeft + titleCaretX(el, p.caret),
        top,
        height,
        flip,
      })),
    );
  }, [peers, value, measureTick, view]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const commit = useCallback(async () => {
    const typed = draftRef.current;
    if (typed === null) return;
    // Same flag as the body editor and the view-only banner (Editor.tsx feeds
    // it into `EditorState.readOnly`); checked live, so a stale closure cannot
    // rename a note that became view-only after the widget rendered.
    if (readOnlyRef.current || view.state.readOnly) {
      setDraft(null);
      setWarning(null);
      return;
    }
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
  }, [noteExists, renameTo, view]);

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
          publish();
        }}
        onFocus={publish}
        onSelect={publish}
        onScroll={remeasure}
        onKeyDown={(e) => {
          if (
            readOnly &&
            (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") &&
            !e.metaKey &&
            !e.ctrlKey
          ) {
            viewOnlyNotice();
          }
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
        onBlur={() => {
          if (awareness) clearTitlePresence(awareness);
          void commit();
        }}
      />
      {carets.length > 0 && (
        <div className="cm-remoteCaretLayer inline-title-carets" aria-hidden="true">
          {carets.map((c) => (
            <div
              key={c.clientId}
              className={c.flip ? "cm-remoteCaret flip" : "cm-remoteCaret"}
              style={{
                ["--rc" as string]: c.color,
                height: `${c.height}px`,
                transform: `translate(${c.left}px, ${c.top}px)`,
              }}
            >
              <div className="cm-remoteCaret-bar" />
              <div className="cm-remoteCaret-label">{c.name}</div>
            </div>
          ))}
        </div>
      )}
      {warning && (
        <p className="inline-title-warning" role="alert">
          {warning}
        </p>
      )}
      {/* A note with no properties offers the three common starts, always
          visible (quietly), instead of one button that only showed on hover. */}
      {!hasFrontmatter && !readOnly && (
        <div className="inline-title-adds">
          <button
            type="button"
            className="inline-title-add"
            onClick={() => addPropertyToNote(view, { key: "tags", value: { kind: "list", value: [] } })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 12l-8 8-9-9V3h8z" />
              <circle cx="7.5" cy="7.5" r="1.5" />
            </svg>
            Add tags
          </button>
          <button type="button" className="inline-title-add" onClick={() => addPropertyToNote(view)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add property
          </button>
          <button
            type="button"
            className="inline-title-add"
            onClick={() =>
              addPropertyToNote(view, {
                key: "date",
                value: { kind: "date", value: new Date().toLocaleDateString("en-CA") },
              })
            }
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M3 10h18M8 3v4M16 3v4" />
            </svg>
            Add date
          </button>
        </div>
      )}
    </div>
  );
}
