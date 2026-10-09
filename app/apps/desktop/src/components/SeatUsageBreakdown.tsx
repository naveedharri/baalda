import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  invitedCountAriaLabel,
  invitedTotalLabel,
  invitedVaults,
  seatBreakdown,
  type InvitedVault,
} from "../lib/billing";
import type { MyBillingAccount } from "../lib/api";
import { placeMenu, type Placement } from "../lib/menuPlacement";

/**
 * Account Settings → Plan & Billing seat breakdown (Team accounts only):
 * Seats · Claimed · Invited · Available in the members-table styling and
 * the owner's Add or change seats. A planned decrease shows only in the
 * Manage seats dialog. The Invited number itself opens a popover listing the
 * vaults holding those invitations; a row opens that vault's member list.
 * Pure props so it renders statically in tests.
 */
export function SeatUsageBreakdown({
  seats,
  canManage,
  onManage,
  showManage = true,
  invitedByVault,
  onOpenInvitedVault,
}: {
  seats: MyBillingAccount["seats"];
  canManage: boolean;
  onManage: () => void;
  /** False when the host already offers Add or change seats elsewhere (the
   *  Plan & Billing header), so the button is not shown twice. */
  showManage?: boolean;
  /** Which vaults the Invited seats belong to; absent on older servers. */
  invitedByVault?: InvitedVault[] | null;
  onOpenInvitedVault?: (vault: InvitedVault) => void;
}) {
  const b = seatBreakdown(seats);
  const vaults = invitedVaults(invitedByVault);
  return (
    <div className="seat-breakdown">
      <table className="members-table seat-breakdown-table">
        <thead>
          <tr>
            <th>Seats</th>
            <th>Claimed</th>
            <th>Invited</th>
            <th>Available</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{b.purchased}</td>
            <td>{b.claimed}</td>
            {/* Zero invited, or an older server that does not say where: the
                number stays plain text with nothing to open. */}
            {b.reserved > 0 && vaults.length > 0 ? (
              <td>
                <InvitedCount total={b.reserved} vaults={vaults} onOpenVault={onOpenInvitedVault} />
              </td>
            ) : (
              <td>{b.reserved}</td>
            )}
            <td>{b.available}</td>
          </tr>
        </tbody>
      </table>
      {canManage && showManage && (
        <div className="vault-row-actions">
          <button className="secondary billing-action" onClick={onManage}>
            Add or change seats
          </button>
        </div>
      )}
    </div>
  );
}

/** Gap between the number and the popover. */
const OFFSET = 6;
/** Hover has to rest this long before the popover opens, so sweeping the
 *  pointer across the table does not flash it. */
const HOVER_OPEN_MS = 250;
/** Grace for gliding from the number into the popover (the roster's beat). */
const HOVER_CLOSE_MS = 140;

/**
 * The Invited count as the control. Hover (after a short rest) or focus opens
 * the popover as a preview; a click or Enter/Space pins it open. Escape, an
 * outside press, a scroll or a resize closes it. With a single vault the click
 * still opens the popover rather than jumping straight to that vault, so the
 * number behaves the same however many vaults sit behind it.
 *
 * The popover is the app's `.context-menu`, portalled to `<body>` and placed
 * with `placeMenu`, exactly like `MenuSelect`: Account Settings is a modal, and
 * a floating panel nested inside it would be clipped by its scroll container.
 */
function InvitedCount({
  total,
  vaults,
  onOpenVault,
}: {
  total: number;
  vaults: InvitedVault[];
  onOpenVault?: (vault: InvitedVault) => void;
}) {
  const [open, setOpen] = useState(false);
  // Pinned by a click / Enter / Space: hover-out and blur no longer close it.
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Set when the keyboard pinned it, so the first row takes focus once placed.
  const focusFirst = useRef(false);

  const clearTimers = () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  const close = (refocus = false) => {
    clearTimers();
    setOpen(false);
    setPinned(false);
    if (refocus) triggerRef.current?.focus();
  };
  const hoverIn = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open || openTimer.current != null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const hoverOut = () => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (pinned) return;
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Portalled, so the menu is not inside the trigger: check both.
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape belongs to the popover first, not to the settings modal under it.
      e.stopPropagation();
      close(true);
    };
    const dismiss = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
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
    // `close` only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Measure-then-place, as in MenuSelect: one hidden pass for the real size.
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
        { x: anchor.left, y: anchor.bottom + OFFSET, flipY: anchor.top - OFFSET },
        { width: menu.offsetWidth, height: menu.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open, vaults.length]);

  useEffect(() => {
    if (!pos || !focusFirst.current) return;
    focusFirst.current = false;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pos]);

  const choose = (v: InvitedVault) => {
    close();
    onOpenVault?.(v);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      // The menu lives at the end of <body>; Tab goes back to the number.
      e.preventDefault();
      close(true);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="seat-invited-trigger"
        aria-label={invitedCountAriaLabel(total, vaults)}
        title={invitedCountAriaLabel(total, vaults)}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onFocus={() => {
          clearTimers();
          setOpen(true);
        }}
        onBlur={(e) => {
          if (pinned || menuRef.current?.contains(e.relatedTarget as Node)) return;
          setOpen(false);
        }}
        onClick={(e) => {
          clearTimers();
          if (open && pinned) {
            close();
            return;
          }
          // `detail === 0` is a keyboard click (Enter/Space): move into the list.
          focusFirst.current = e.detail === 0;
          setOpen(true);
          setPinned(true);
        }}
      >
        {total}
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            className="context-menu menu-portal seat-invited-menu"
            role="menu"
            aria-label={invitedCountAriaLabel(total, vaults)}
            onMouseEnter={hoverIn}
            onMouseLeave={hoverOut}
            onKeyDown={onMenuKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={
              pos
                ? { position: "fixed", left: pos.left, top: pos.top, right: "auto", maxHeight: pos.maxHeight }
                : { position: "fixed", left: 0, top: 0, right: "auto", visibility: "hidden" }
            }
          >
            <InvitedSeatsMenuItems total={total} vaults={vaults} onChoose={choose} />
          </ul>,
          document.body,
        )}
    </>
  );
}

/**
 * The popover's rows: a heading with the total, one row per vault (a row opens
 * that vault's Members and access), and the seat-hold hint. Exported so the
 * content renders statically in tests without opening the popover.
 */
export function InvitedSeatsMenuItems({
  total,
  vaults,
  onChoose,
}: {
  total: number;
  vaults: InvitedVault[];
  onChoose: (vault: InvitedVault) => void;
}) {
  return (
    <>
      <li className="menu-heading" role="presentation">
        <span>Invited</span>
        <span className="seat-invited-total">{invitedTotalLabel(total)}</span>
      </li>
      {vaults.map((v) => (
        <li
          key={v.orgId}
          role="menuitem"
          tabIndex={-1}
          className="seat-invited-row"
          title={`Open ${v.name}'s members and invitations`}
          onClick={() => onChoose(v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onChoose(v);
            }
          }}
        >
          <span className="seat-invited-name">{v.name}</span>
          <span className="seat-invited-count">{v.count}</span>
        </li>
      ))}
      <li className="menu-note" role="presentation">
        Pending invitations hold a seat until they're accepted or expire.
      </li>
    </>
  );
}
