import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  HOVER_MENU_CLOSE_MS,
  nextHoverMenuMode,
  type HoverMenuEvent,
  type HoverMenuMode,
} from "../lib/hoverMenu";

/**
 * Hover-to-preview, click-to-pin menu state shared by the vault tile and the
 * identity bar. Wire `hoverEnter`/`hoverLeave` to the trigger, and
 * `cancelHoverClose`/`hoverLeave`/`pin` to the menu's enter/leave/press. Every
 * callback is stable, so they are safe in effect dependencies.
 */
export function useHoverMenu() {
  const [mode, setMode] = useState<HoverMenuMode>("closed");
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHoverClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const send = useCallback(
    (event: HoverMenuEvent) => {
      cancelHoverClose();
      setMode((current) => nextHoverMenuMode(current, event));
    },
    [cancelHoverClose],
  );
  const close = useCallback(() => send("close"), [send]);
  const toggle = useCallback(() => send("toggle"), [send]);
  const pin = useCallback(() => send("pin"), [send]);
  /** Mouse only: a touch or pen press is a click, never a hover preview. */
  const hoverEnter = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType !== "mouse") return;
      send("enter");
    },
    [send],
  );
  const hoverLeave = useCallback(() => {
    cancelHoverClose();
    // Bridge the small gap between the trigger and the menu without flicker.
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setMode((current) => nextHoverMenuMode(current, "leave-elapsed"));
    }, HOVER_MENU_CLOSE_MS);
  }, [cancelHoverClose]);
  useEffect(() => cancelHoverClose, [cancelHoverClose]);

  return { mode, open: mode !== "closed", close, toggle, pin, hoverEnter, hoverLeave, cancelHoverClose };
}
