import { useEffect, useRef, useState } from "react";
import { ASSIGNABLE_ROLES, type AssignableRole } from "./memberRoles";

/**
 * Role picker used by the Members tab — the invite bar ("field" variant) and
 * each member row ("pill" variant, styled like the static role badge it
 * replaces so unchangeable rows and changeable ones read as the same thing).
 *
 * Same popover anatomy as the file-tree sort menu: a trigger button with
 * aria-haspopup/aria-expanded and a button-anchored `.context-menu` of
 * menuitemradio items. Unlike FileTree (which owns a window-level dismiss),
 * this is self-contained: outside-mousedown and Escape close it.
 */
export function RoleSelect({
  value,
  onSelect,
  disabled,
  ariaLabel,
  variant,
}: {
  value: AssignableRole;
  onSelect: (role: AssignableRole) => void | Promise<void>;
  disabled?: boolean;
  ariaLabel: string;
  variant: "field" | "pill";
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

  const triggerClass =
    variant === "pill" ? `member-role ${value} role-trigger` : "role-field-trigger";

  return (
    // Swallow clicks so a dialog-level dismiss can't eat the opening click.
    <div className="role-select-wrap" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={triggerClass}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="role-trigger-label">{value}</span>
        <span className="role-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="context-menu role-menu" role="menu">
          {ASSIGNABLE_ROLES.map((r) => (
            <li
              key={r}
              role="menuitemradio"
              aria-checked={value === r}
              className={value === r ? "is-on" : undefined}
              onClick={() => {
                setOpen(false);
                if (r !== value) void onSelect(r);
              }}
            >
              <span className="menu-tick" aria-hidden="true">
                {value === r ? "✓" : ""}
              </span>
              <span className="role-option-label">{r}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
