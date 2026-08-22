import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeMenu, type Placement } from "../lib/menuPlacement";

/**
 * The app's one popover select.
 *
 * Extracted from `RoleSelect` (which is now a thin wrapper over it) when the
 * Access panel needed the same control: a native `<select>` there was the only
 * OS-chrome dropdown left in the product, and it read as unfinished next to the
 * Members page. Anatomy is unchanged — a trigger with aria-haspopup/expanded and
 * a `.context-menu` of menuitemradio rows — so both places stay one control
 * rather than two that drift.
 *
 * The menu is positioned in VIEWPORT coordinates (`position: fixed`) through the
 * same `placeMenu` the file tree uses, rather than being absolutely parked under
 * the trigger. Parking it there meant the last row of a list opened a menu that
 * ran off the bottom of the window — and the last row is exactly where a member
 * list puts the person you most recently added. Fixed positioning also lifts it
 * out of any scrolling ancestor, so it can't be clipped by one.
 *
 * Self-contained dismissal (outside-mousedown + Escape), unlike FileTree's menu
 * which owns a window-level dismiss of its own.
 */

export interface MenuSelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional second line, for options whose consequence needs saying. */
  hint?: string;
}

/** Gap between the trigger and the menu, on whichever side it opens. */
const OFFSET = 6;

export function MenuSelect<T extends string>({
  value,
  options,
  onSelect,
  disabled,
  ariaLabel,
  triggerClassName,
  menuClassName,
}: {
  value: T;
  options: ReadonlyArray<MenuSelectOption<T>>;
  onSelect: (value: T) => void | Promise<void>;
  disabled?: boolean;
  ariaLabel: string;
  /** Trigger styling — the caller decides whether it's a field or a pill. */
  triggerClassName: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The menu is fixed to the viewport, so anything that moves the trigger
    // underneath it (a scroll, a resize) would leave it stranded. Closing is the
    // honest response — re-anchoring mid-scroll makes the menu chase the cursor.
    const dismiss = () => setOpen(false);
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

  // Measure-then-place, like the file tree's context menu: the menu renders
  // once (hidden) so its real size is known, and only then gets a position.
  // Guessing the height would be the bug this exists to avoid.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    setPos(
      placeMenu(
        {
          // Right-aligned with the trigger, which is where these controls sit.
          x: anchor.right - size.width,
          y: anchor.bottom + OFFSET,
          flipY: anchor.top - OFFSET,
        },
        size,
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open, options.length]);

  // A value with no matching option still has to render something — falling
  // back to the raw value beats an empty trigger that looks broken.
  const current = options.find((o) => o.value === value);

  return (
    // Swallow clicks so a dialog-level dismiss can't eat the opening click.
    <div className="role-select-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="role-trigger-label">{current?.label ?? value}</span>
        <span className="role-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul
          ref={menuRef}
          className={`context-menu role-menu${menuClassName ? ` ${menuClassName}` : ""}`}
          role="menu"
          style={
            pos
              ? { position: "fixed", left: pos.left, top: pos.top, right: "auto", maxHeight: pos.maxHeight }
              : // The measuring pass: laid out but not shown, so it can't flash
                // at the wrong place on the way to its real position.
                { position: "fixed", left: 0, top: 0, right: "auto", visibility: "hidden" }
          }
        >
          {options.map((o) => (
            <li
              key={o.value}
              role="menuitemradio"
              aria-checked={value === o.value}
              className={value === o.value ? "is-on" : undefined}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) void onSelect(o.value);
              }}
            >
              <span className="menu-tick" aria-hidden="true">
                {value === o.value ? "✓" : ""}
              </span>
              <span className="role-option-label">
                {o.label}
                {o.hint && <span className="menu-option-hint">{o.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
