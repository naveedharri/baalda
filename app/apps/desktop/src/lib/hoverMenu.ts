/* A menu that opens on hover as a preview and pins on click: the sidebar's
   vault tile and the identity bar. Pure transitions here, the timers and React
   state in `components/useHoverMenu.ts`. */

/**
 * `hover` opened on hover, `pinned` by a click or a press inside. BOTH close
 * once the pointer has been away for the grace period: a pinned menu that
 * outlived the pointer read as stuck (2026-11-01). The one exception, judged
 * by the hook, is a text field inside the menu holding focus, so typing a
 * vault name or join code is never cut off.
 */
export type HoverMenuMode = "closed" | "hover" | "pinned";

export type HoverMenuEvent =
  /** The mouse entered the trigger. */
  | "enter"
  /** The pointer has been off trigger and menu for the whole grace period. */
  | "leave-elapsed"
  /** A click (or Enter/Space) on the trigger. */
  | "toggle"
  /** A press or focus inside the open menu. */
  | "pin"
  /** Escape, an outside press, or a row that closes the menu. */
  | "close"
  /** A click on a neighbouring control: closes a hover preview, leaves a pinned menu. */
  | "dismiss-preview";

/** Grace for gliding from the trigger into the menu without it closing. */
export const HOVER_MENU_CLOSE_MS = 220;

export function nextHoverMenuMode(mode: HoverMenuMode, event: HoverMenuEvent): HoverMenuMode {
  switch (event) {
    case "enter":
      return mode === "closed" ? "hover" : mode;
    case "leave-elapsed":
      return "closed";
    case "toggle":
      // Clicking a hover preview pins it; only a second click closes it.
      return mode === "pinned" ? "closed" : "pinned";
    case "pin":
      return mode === "closed" ? mode : "pinned";
    case "close":
      return "closed";
    case "dismiss-preview":
      return mode === "hover" ? "closed" : mode;
  }
}
