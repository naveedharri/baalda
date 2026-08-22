import { useEffect, useRef, useState } from "react";

/**
 * The app's one popover select.
 *
 * Extracted from `RoleSelect` (which is now a thin wrapper over it) when the
 * Access panel needed the same control: a native `<select>` there was the only
 * OS-chrome dropdown left in the product, and it read as unfinished next to the
 * Members page. Anatomy is unchanged — a trigger with aria-haspopup/expanded and
 * a button-anchored `.context-menu` of menuitemradio rows — so both places stay
 * one control rather than two that drift.
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
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // A value with no matching option still has to render something — falling
  // back to the raw value beats an empty trigger that looks broken.
  const current = options.find((o) => o.value === value);

  return (
    // Swallow clicks so a dialog-level dismiss can't eat the opening click.
    <div className="role-select-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
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
        <ul className={`context-menu role-menu${menuClassName ? ` ${menuClassName}` : ""}`} role="menu">
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
