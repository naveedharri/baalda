import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { noteLabel } from "../lib/notePath";
import { useStore } from "../store";

/**
 * Search, as a centered overlay rather than a sidebar panel.
 *
 * It used to render inside the sidebar while its button lived in the main
 * header on the opposite side of the window — click right, watch something
 * appear far left. Searching is also a whole-window act: you're looking through
 * the vault, not at the tree. So it takes the middle, like every other
 * search-everything box people already know.
 */
export function SearchPanel({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  // Bumped when the index extracts more file text, to re-run the live query.
  const [indexTick, setIndexTick] = useState(0);
  // Which result the arrow keys are on. Reset whenever the result set changes,
  // so Enter can never open whatever happened to be highlighted for an older query.
  const [active, setActive] = useState(0);
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Focus the box as soon as it opens so ⌘F is type-and-go.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setActive(0);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        setResults(await ipc.searchNotes(query));
        setActive(0);
      } catch (e) {
        console.error("search failed", e);
      }
    }, 180);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, indexTick]);

  // A search typed while a folder of documents is still being extracted answers
  // from whatever text had landed; this re-asks as the rest arrives. The event
  // is coalesced in Rust, so a 200-file drop is a handful of re-runs, not 200.
  useEffect(() => {
    const unlisten = ipc.onFilesIndexed(() => setIndexTick((n) => n + 1));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Keep the keyboard selection in view when it walks past the visible rows.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (path: string) => {
    void useStore.getState().openNoteByPath(path);
    onClose?.();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose?.();
    } else if (e.key === "ArrowDown" && results.length) {
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length) {
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && results[active]) {
      open(results[active].path);
    } else {
      return;
    }
    e.preventDefault();
  };

  const searching = query.trim().length > 0;

  return (
    <div className="modal-backdrop search-backdrop" onClick={() => onClose?.()}>
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-field">
          <span className="search-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="search-box"
            placeholder="Search notes…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-esc">esc</kbd>
        </div>

        {searching && (
          <ul className="search-results" ref={listRef}>
            {results.length === 0 && <li className="search-none">No matches</li>}
            {results.map((r, i) => (
              <li
                key={r.id}
                data-idx={i}
                className={`search-result${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => open(r.path)}
              >
                <SearchHit result={r} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * One result's contents. Pure and exported so a test can render it without the
 * store, the Tauri host or an effect (see `__tests__/searchPanel.test.ts`).
 *
 * A `file` hit is the only one that gets a badge: a note is the default thing in
 * a vault and labelling every row "note" would be noise, while a `.docx` that
 * looks like a note until you click it is exactly the surprise the badge exists
 * to remove. The row still opens through `store.openNoteByPath`, so the format
 * registry picks the viewer — search does not need to know what a `.xlsx` is.
 */
export function SearchHit({ result }: { result: SearchResult }) {
  return (
    <>
      {/* The file name, like the tab and the sidebar. `result.title` stays
          match fuel (Rust indexes it in `notes_fts`/`files_fts`) but is never
          the label: for a note with an H1 it names the same note differently
          from its own tab. */}
      <div className="search-title">
        <span className="search-label">{noteLabel(result.path)}</span>
        {result.kind === "file" && (
          <span className="ws-badge local search-ext">{result.ext ?? "file"}</span>
        )}
      </div>
      <div
        className="search-snippet"
        // The snippet is HTML-escaped in Rust (see index.rs::html_escape) so the
        // ONLY markup it can contain is our own <mark> highlight tags — note
        // bodies can't inject anything, and text extracted from a BINARY can't
        // either: `extract.rs` strips the U+0001/U+0002 sentinels that become
        // those tags. A CSP (tauri.conf.json) backstops this by blocking inline
        // script even if that changed.
        dangerouslySetInnerHTML={{ __html: result.snippet }}
      />
    </>
  );
}
