import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeMenu, type Placement } from "../lib/menuPlacement";
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

/** Right-click menu state: the tab it was opened on plus the cursor anchor. */
interface TabMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * The open-files strip under the main header. Every `openNoteByPath` keeps its
 * file as a tab (store `openTabs`), so moving between notes no longer loses
 * where you were — click to switch back, × or middle-click to close, and
 * right-click for the bulk close actions (others / to the right / all).
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

  // Context menu, same placement dance as the file tree's row menu: render
  // hidden at the anchor, measure, then let `placeMenu` flip/clamp it on-screen.
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const [menuPos, setMenuPos] = useState<Placement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // Any click lands somewhere else (menu items close themselves first), and a
    // second right-click elsewhere replaces the menu via onContextMenu below.
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setMenuPos(
      placeMenu(
        { x: menu.x, y: menu.y },
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [menu]);

  if (tabs.length === 0) return null;

  const menuIdx = menu ? tabs.indexOf(menu.path) : -1;
  const menuLabel = menu ? tabLabel(menu.path, titleByPath) : "";

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
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, path });
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

      {menu && (
        <ul
          className="context-menu"
          role="menu"
          aria-label={`Tab actions for ${menuLabel}`}
          ref={menuRef}
          style={
            menuPos
              ? { left: menuPos.left, top: menuPos.top, maxHeight: menuPos.maxHeight }
              : // Rendered off the anchor for the measuring pass only, and hidden
                // so that pass can't flash on screen at the wrong place.
                { left: menu.x, top: menu.y, visibility: "hidden" }
          }
        >
          <li
            role="menuitem"
            onClick={() => {
              useStore.getState().closeTab(menu.path);
              setMenu(null);
            }}
          >
            Close
          </li>
          <li
            role="menuitem"
            className={tabs.length < 2 ? "disabled" : undefined}
            onClick={() => {
              if (tabs.length < 2) return;
              useStore.getState().closeOtherTabs(menu.path);
              setMenu(null);
            }}
          >
            Close others
          </li>
          <li
            role="menuitem"
            // Last tab (or the phantom active-only tab, which renders last) has
            // nothing to its right.
            className={menuIdx === -1 || menuIdx === tabs.length - 1 ? "disabled" : undefined}
            onClick={() => {
              if (menuIdx === -1 || menuIdx === tabs.length - 1) return;
              useStore.getState().closeTabsToRight(menu.path);
              setMenu(null);
            }}
          >
            Close tabs to the right
          </li>
          <li
            role="menuitem"
            className="menu-sep-item"
            onClick={() => {
              useStore.getState().closeAllTabs();
              setMenu(null);
            }}
          >
            Close all
          </li>
        </ul>
      )}
    </div>
  );
}
