// A labelled button that opens a short action menu ("New skill ▾"). The menu is
// the app's `.context-menu`, placed by `placeMenu` and dismissed like
// `RowActionsMenu`, whose trigger is a bare "⋯" and so can't carry a label.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type Placement } from "../../lib/menuPlacement";

export interface MenuAction {
  key: string;
  label: string;
  hint?: string;
  onSelect: () => void | Promise<void>;
}

export function SkillsMenuButton({
  label,
  actions,
  className = "primary",
  caret = true,
  ariaLabel,
  title,
}: {
  label: ReactNode;
  actions: ReadonlyArray<MenuAction>;
  className?: string;
  /** The ▾ after the label; off for an icon-only trigger. */
  caret?: boolean;
  ariaLabel?: string;
  title?: string;
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
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
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
    const r = trigger.getBoundingClientRect();
    setPos(
      placeMenu(
        { x: r.right - menu.offsetWidth, y: r.bottom + 6, flipY: r.top - 6 },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);

  const choose = (a: MenuAction) => {
    setOpen(false);
    void a.onSelect();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${className} skills-menu-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        {caret && (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            className="context-menu menu-portal skills-menu"
            role="menu"
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
                onClick={() => choose(a)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose(a);
                  }
                }}
              >
                <span className="skills-menu-label">{a.label}</span>
                {a.hint && <span className="skills-menu-hint">{a.hint}</span>}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
