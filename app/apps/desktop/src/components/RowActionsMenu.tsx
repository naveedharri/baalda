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

/**
 * The menu's left edge for a trigger rect. `end` (rows) right-aligns the menu
 * under the trigger; `start` (cards, whose ⋯ sits in the top-right corner)
 * opens it from the trigger's left edge to the right, so it does not cover the
 * card. `placeMenu` flips it left only when the right side would overflow.
 */
export function rowMenuAnchorX(
  trigger: { left: number; right: number },
  menuWidth: number,
  align: "start" | "end",
): number {
  return align === "start" ? trigger.left : trigger.right - menuWidth;
}

export function RowActionsMenu({
  actions,
  ariaLabel,
  disabled,
  menuClassName,
  align = "end",
}: {
  actions: ReadonlyArray<RowAction>;
  ariaLabel: string;
  disabled?: boolean;
  /** A modifier on the portalled menu, e.g. a width override. */
  menuClassName?: string;
  /** Which trigger edge the menu grows from; see `rowMenuAnchorX`. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  // Set when the keyboard opened it, so the first item takes focus once placed.
  const focusFirst = useRef(false);

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape belongs to the menu first, not to a settings modal under it.
      e.stopPropagation();
      close(true);
    };
    const dismiss = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
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
        {
          x: rowMenuAnchorX(anchor, menu.offsetWidth, align),
          y: anchor.bottom + OFFSET,
          flipY: anchor.top - OFFSET,
        },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open, actions.length, align]);

  useEffect(() => {
    if (!pos || !focusFirst.current) return;
    focusFirst.current = false;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pos]);

  const choose = (a: RowAction) => {
    close();
    void a.onSelect();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      // The menu lives at the end of <body>; Tab goes back to the trigger.
      e.preventDefault();
      close(true);
    }
  };

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
        onClick={(e) => {
          // `detail === 0`: Enter/Space, not a pointer.
          focusFirst.current = e.detail === 0;
          setOpen((v) => !v);
        }}
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
            className={`context-menu menu-portal row-more-menu${menuClassName ? ` ${menuClassName}` : ""}`}
            role="menu"
            aria-label={ariaLabel}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
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
                tabIndex={-1}
                title={a.title}
                className={[a.danger ? "danger" : "", a.separated ? "menu-sep-item" : ""].filter(Boolean).join(" ") || undefined}
                onClick={() => choose(a)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(a);
                  }
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
