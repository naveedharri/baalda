/* A menu that opens on hover as a preview and pins on click: the sidebar's
   vault tile and the identity bar. Pure transitions here, the timers and React
   state in `components/useHoverMenu.ts`. */

/** `hover` closes when the pointer leaves; `pinned` waits for a click, Escape or an outside press. */
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
      return mode === "hover" ? "closed" : mode;
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
