import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";

export function SearchPanel({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the box as soon as the panel opens so ⌘F is type-and-go.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        setResults(await ipc.searchNotes(query));
      } catch (e) {
        console.error("search failed", e);
      }
    }, 180);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query]);

  const open = (path: string) => {
    void useStore.getState().openNoteByPath(path);
    onClose?.();
  };

  return (
    <div className="search-panel">
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          className="search-box"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose?.();
          }}
        />
      </div>
      {query.trim() && (
        <ul className="search-results">
          {results.length === 0 && <li className="search-none">No matches</li>}
          {results.map((r) => (
            <li
              key={r.id}
              className="search-result"
              onClick={() => open(r.path)}
            >
              <div className="search-title">{r.title || r.path}</div>
              <div
                className="search-snippet"
                // The snippet is HTML-escaped in Rust (see index.rs::html_escape)
                // so the ONLY markup it can contain is our own <mark> highlight
                // tags — note bodies can't inject anything. A CSP (tauri.conf.json)
                // backstops this by blocking inline script even if that changed.
                dangerouslySetInnerHTML={{ __html: r.snippet }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
