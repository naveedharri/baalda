import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ITEM_COLORS, itemColorFill, itemColorValue } from "../lib/appearance";
import { placeMenu, type Placement } from "../lib/menuPlacement";
import type * as ipc from "../lib/ipc";
import { useStore } from "../store";

const GLYPH = {
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
};

/** The row's trailing state plus its swatch popover. Three states: an explicit
 *  colour (its dot), an automatic one (that dot + "Auto", only while automatic
 *  colours are on for this person), or none (an empty dot + "None"). */
function ColorPicker({
  path,
  name,
  active,
  auto,
}: {
  path: string;
  name: string;
  active: string | undefined;
  auto: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const dismiss = (e: Event) => {
      if (e.type === "scroll" && e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const a = trigger.getBoundingClientRect();
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    setPos(
      placeMenu(
        { x: a.right - size.width, y: a.bottom + 6, flipY: a.top - 6 },
        size,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);

  const pick = (id: string | null) => {
    useStore.getState().setItemColor(path, id);
    setOpen(false);
  };
  const current = ITEM_COLORS.find((c) => c.id === active);
  const automatic = current ? undefined : ITEM_COLORS.find((c) => c.id === auto);
  const stateLabel = current ? current.label : automatic ? `Auto (${automatic.label})` : "None";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="item-color-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Color for ${name}: ${stateLabel}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? (
          <span
            className="swatch"
            style={{ backgroundColor: current.fill, boxShadow: `inset 0 0 0 1.5px ${current.value}` }}
          />
        ) : automatic ? (
          <>
            <span
              className="swatch"
              style={{ backgroundColor: automatic.fill, boxShadow: `inset 0 0 0 1.5px ${automatic.value}` }}
            />
            <span className="muted">Auto</span>
          </>
        ) : (
          <>
            <span className="swatch clear" />
            <span className="muted">None</span>
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu item-color-menu"
            role="radiogroup"
            aria-label={`Color for ${name}`}
            style={{
              position: "fixed",
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
          >
            <button
              type="button"
              className={`swatch clear${!active ? " on" : ""}`}
              title="Default"
              aria-label="Default color"
              onClick={() => pick(null)}
            />
            {ITEM_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`swatch${active === c.id ? " on" : ""}`}
                style={{ backgroundColor: c.fill, boxShadow: `inset 0 0 0 1.5px ${c.value}` }}
                title={c.label}
                aria-label={c.label}
                onClick={() => pick(c.id)}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function VaultItemColorsSection() {
  const itemColors = useStore((s) => s.itemColors);
  const tree = useStore((s) => s.tree);
  const automaticOn = useStore((s) => s.automaticItemColors);
  const autoMap = useStore((s) => s.automaticItemColorMap);

  const items = useMemo(() => {
    const out: Array<{ path: string; name: string; depth: number; isDir: boolean }> = [];
    const walk = (n: ipc.TreeNode, depth: number) => {
      out.push({
        path: n.path,
        name: n.isDir ? n.name : n.name.replace(/\.(md|html?)$/i, ""),
        depth,
        isDir: n.isDir,
      });
      n.children?.forEach((c) => walk(c, depth + 1));
    };
    tree?.children?.forEach((c) => walk(c, 0));
    return out;
  }, [tree]);

  const coloredCount = items.filter((i) => itemColors[i.path]).length;

  return (
    <>
      <div className="subhead">Folder &amp; note colors</div>
      <div className="muted">
        {automaticOn
          ? "Color-code the sidebar. Colors you pick here sync to everyone in this vault and win over automatic colors."
          : "Color-code the sidebar. Colors you pick here sync to everyone in this vault."}
      </div>

      {items.length === 0 ? (
        <div className="muted perm-empty">Open a vault to color its folders and notes.</div>
      ) : (
        <>
          <ul className="appearance-list">
            {items.map((item) => {
              const active = itemColors[item.path];
              const shown = active ?? (automaticOn ? autoMap[item.path] : undefined);
              return (
                <li
                  key={item.path}
                  className="appearance-row"
                  style={{ paddingLeft: `${12 + item.depth * 16}px` }}
                >
                  <span
                    className="appearance-glyph"
                    style={
                      { color: itemColorValue(shown), "--glyph-fill": itemColorFill(shown) } as CSSProperties
                    }
                    aria-hidden="true"
                  >
                    {item.isDir ? GLYPH.folder : GLYPH.note}
                  </span>
                  <span className="appearance-name" title={item.path}>
                    {item.name}
                  </span>
                  <ColorPicker
                    path={item.path}
                    name={item.name}
                    active={active}
                    auto={automaticOn ? autoMap[item.path] : undefined}
                  />
                </li>
              );
            })}
          </ul>
          {coloredCount > 0 && (
            <button
              className="link-btn"
              onClick={() => {
                const { itemColors: colors, setItemColor } = useStore.getState();
                Object.keys(colors).forEach((p) => setItemColor(p, null));
              }}
            >
              Clear all colors ({coloredCount})
            </button>
          )}
        </>
      )}
    </>
  );
}
