import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";

/** Tab label: the note's indexed title when we have one, else the filename.
 *  Notes/pages hide their extension (same rule as the rename input); other
 *  file types keep it, since the extension is how you tell two previews apart. */
function tabLabel(path: string, titleByPath: Map<string, string>): string {
  const title = titleByPath.get(path);
  if (title) return title;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|html?)$/i, "");
}

/**
 * The open-files strip under the main header. Every `openNoteByPath` keeps its
 * file as a tab (store `openTabs`), so moving between notes no longer loses
 * where you were — click to switch back, × or middle-click to close.
 *
 * The ACTIVE tab is derived from `openNote.path`, never tracked separately, so
 * the strip can't disagree with the editor about what's on screen.
 */
export function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activePath = useStore((s) => s.openNote?.path ?? null);
  const activeTitle = useStore((s) => s.openNote?.title ?? null);
  const openingPath = useStore((s) => s.openingNotePath);
  const titles = useStore((s) => s.titles);

  const titleByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of titles) m.set(t.path, t.title);
    // The open note's own title is fresher than the index while its H1 is
    // being typed — let it win for the active tab.
    if (activePath && activeTitle) m.set(activePath, activeTitle);
    return m;
  }, [titles, activePath, activeTitle]);

  // Vault machinery can reset the list while a note is still open (see
  // `vaultScopedSyncReset`) — the file on screen always earns a tab.
  const tabs =
    activePath && !openTabs.includes(activePath) ? [...openTabs, activePath] : openTabs;

  // Keep the active tab in view when it changes off-screen (many tabs open).
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {tabs.map((path) => {
        const active = path === activePath;
        // The openingNotePath acknowledgement, same as the sidebar row: a tab
        // click in a synced vault takes a round trip before the editor swaps.
        const opening = path === openingPath && !active;
        const label = tabLabel(path, titleByPath);
        return (
          <div
            key={path}
            className={`tab${active ? " active" : ""}${opening ? " opening" : ""}`}
            role="tab"
            aria-selected={active}
            title={path}
            // Middle-click closes, the platform-wide tab convention.
            onAuxClick={(e) => {
              if (e.button === 1) useStore.getState().closeTab(path);
            }}
          >
            <button
              ref={active ? activeRef : undefined}
              className="tab-label"
              tabIndex={active ? 0 : -1}
              onClick={() => {
                if (!active) void useStore.getState().openNoteByPath(path);
              }}
            >
              {label}
            </button>
            <button
              className="tab-close"
              title="Close tab"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().closeTab(path);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
