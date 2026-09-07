import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Shared shell for the two settings surfaces — Account settings
 * ({@link ./AccountSettings}) and Vault settings (in `AccountMenu.tsx`).
 *
 * Both used to be full-window takeovers (`position: fixed; inset: 0`) with no
 * backdrop and no click-away, so opening them read as "the app went away"
 * rather than "a panel opened", and the only way out was Esc or the ✕ (#92).
 * They now render as one centered card over a dimmed backdrop. Keeping the
 * shell here is the point: two surfaces that look identical must not drift.
 *
 * Portalled to `<body>` for the same reason `UpgradeDialog` is: settings is
 * mounted from `AccountMenu`, a leaf of `.sidebar-footer`, and a fixed backdrop
 * rendered there is one `transform`/`filter` on an ancestor away from being
 * clipped to a sidebar-sized box.
 *
 * The card keeps the `.settings-page` class — input/select styling is
 * descendant-scoped on it in `App.css` — and adds `.settings-modal` for the
 * card geometry. It animates **opacity only**, deliberately: a transform (even
 * a settled `translateY(0)` left behind by `rise-in`'s `both` fill) makes the
 * card a containing block and would trap the `position: fixed` dialogs the tab
 * bodies render, e.g. the revert-checkpoint confirm in Versioning. `App.css`
 * drops the transform from `.settings-content` for the same reason.
 *
 * The backdrop *is* a containing block for those dialogs — `.modal-backdrop`
 * carries `backdrop-filter`, which creates one — but it is `position: fixed;
 * inset: 0` with no clipping, so a fixed child sized to it is still sized to
 * the viewport. Keep it that way: give this backdrop an inset or an
 * `overflow: hidden` and every nested dialog shrinks to it.
 */
export function SettingsModal({
  label,
  onClose,
  children,
}: {
  /** Accessible name for the dialog, e.g. "Account settings". */
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  /**
   * Did the press that produced this click start on the backdrop? Selecting
   * text in a field and releasing outside the card fires `click` on the
   * backdrop (it is the common ancestor), and losing your settings to a
   * text-selection drag would be maddening. Only a press *and* release on the
   * backdrop counts as clicking away.
   */
  const pressedBackdrop = useRef(false);

  // Focus the way out on open, and hand focus back to whatever opened us on
  // close (the account/vault popover button, usually — which is gone from the
  // DOM by then, hence the `isConnected` check).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const target =
      card?.querySelector<HTMLElement>(".settings-page-header .icon-btn") ??
      card?.querySelector<HTMLElement>(".settings-nav .menu-item") ??
      card;
    target?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Anything opened from *inside* settings owns Esc first: a dialog stacked
      // above us (Upgrade, Sign in, a confirm — each renders a
      // `.modal-backdrop`) or an open popover (`MenuSelect`'s role menus render
      // a portalled `.context-menu`). One of those on screen means we are not
      // the topmost surface, and closing the whole modal out from under it is
      // never what the key was for.
      if (
        document.querySelector(".modal-backdrop:not(.settings-backdrop), .context-menu")
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop settings-backdrop"
      // Not stopped by the card, so a press anywhere inside it reaches here
      // with `target !== currentTarget` and correctly clears the flag.
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const away = e.target === e.currentTarget && pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (away) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="settings-page settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
