import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { placeMenu, type Placement } from "../lib/menuPlacement";
import { noteLabel } from "../lib/notePath";
import { useStore } from "../store";

/** Right-click menu state: the tab it was opened on plus the cursor anchor. */
interface TabMenu {
  x: number;
  y: number;
  path: string;
}

/**
 * The main header's top row: the open files. Every `openNoteByPath` keeps its
 * file as a tab (store `openTabs`), so moving between notes no longer loses
 * where you were — click to switch back, × or middle-click to close,
 * right-click for the bulk close actions (others / to the right / all), and `+`
 * for a new note.
 *
 * This is the note's ONE title. The header used to carry a `.note-title` span
 * as well, which for a legacy note whose H1 and filename disagree said
 * something different; the label here is the FILE NAME (`noteLabel`), never the
 * indexed title.
 *
 * The ACTIVE tab is derived from `openNote.path`, never tracked separately, so
 * the strip can't disagree with the editor about what's on screen. Tabs never
 * move; what travels is the soft highlight behind the active one — a single
 * `motion` element with a shared `layoutId`, so switching tabs slides it from
 * the old tab to the new one instead of re-painting two boxes.
 */
export function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activePath = useStore((s) => s.openNote?.path ?? null);
  const openingPath = useStore((s) => s.openingNotePath);
  const reduceMotion = useReducedMotion();

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

  // No early return on an empty strip: it is the header's top row now, and it
  // still holds the `+` with nothing open.
  const menuIdx = menu ? tabs.indexOf(menu.path) : -1;
  const menuLabel = menu ? noteLabel(menu.path) : "";

  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      <LayoutGroup>
        {tabs.map((path) => {
          const active = path === activePath;
          // The openingNotePath acknowledgement, same as the sidebar row: a tab
          // click in a synced vault takes a round trip before the editor swaps.
          const opening = path === openingPath && !active;
          const label = noteLabel(path);
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
              {active && (
                <motion.span
                  className="tab-active-bg"
                  layoutId="tab-active-bg"
                  aria-hidden="true"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 380, damping: 34, mass: 0.9 }
                  }
                />
              )}
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
      </LayoutGroup>

      {/* New note at the vault root, exactly like ⌘N — `createNoteIn` handles the
          root-freeze latch and arms the sidebar's rename box. */}
      <button
        className="tab-new"
        title="New note (⌘N)"
        aria-label="New note"
        onClick={() => {
          void useStore.getState().createNoteIn("");
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
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

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
