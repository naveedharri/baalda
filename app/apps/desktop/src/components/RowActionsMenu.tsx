import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "../lib/menuPlacement";

/**
 * A row's overflow menu: a "⋯" trigger that opens the app's `.context-menu`
 * with the row's secondary actions. Same anatomy and placement as
 * `MenuSelect` (portalled, viewport-placed through `placeMenu`, dismissed on
 * outside mousedown / Escape / scroll / resize), but for ACTIONS rather than a
 * value, so each item is a plain `menuitem`.
 */
export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void | Promise<void>;
  /** Red, like the other destructive menu items. */
  danger?: boolean;
  /** Draw a rule above this item to start a new group. */
  separated?: boolean;
  title?: string;
}

const OFFSET = 6;

export function RowActionsMenu({
  actions,
  ariaLabel,
  disabled,
}: {
  actions: ReadonlyArray<RowAction>;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const dismiss = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
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
    const anchor = trigger.getBoundingClientRect();
    setPos(
      placeMenu(
        { x: anchor.right - menu.offsetWidth, y: anchor.bottom + OFFSET, flipY: anchor.top - OFFSET },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open, actions.length]);

  if (actions.length === 0) return null;
  return (
    <span className="row-more" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={`row-more-btn${open ? " open" : ""}`}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            className="context-menu menu-portal row-more-menu"
            role="menu"
            aria-label={ariaLabel}
            onClick={(e) => e.stopPropagation()}
            style={
              pos
                ? { position: "fixed", left: pos.left, top: pos.top, right: "auto", maxHeight: pos.maxHeight }
                : { position: "fixed", left: 0, top: 0, right: "auto", visibility: "hidden" }
            }
          >
            {actions.map((a) => (
              <li
                key={a.key}
                role="menuitem"
                title={a.title}
                className={[a.danger ? "danger" : "", a.separated ? "menu-sep-item" : ""].filter(Boolean).join(" ") || undefined}
                onClick={() => {
                  setOpen(false);
                  void a.onSelect();
                }}
              >
                {a.label}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </span>
  );
}
