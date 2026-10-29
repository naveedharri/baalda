/**
 * Redesign: let a dialog fade and settle out before React unmounts it.
 * Marks the topmost open backdrop with `.rd-exit` (styled in redesign.css),
 * then runs `close` once the short exit has played. Reduced motion, or no
 * dialog on screen, closes at once.
 */
const EXIT_MS = 150;

export function exitThen(close: () => void): void {
  const backdrops = document.querySelectorAll<HTMLElement>(".modal-backdrop:not(.rd-exit)");
  const top = backdrops[backdrops.length - 1];
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!top || reduce) {
    close();
    return;
  }
  top.classList.add("rd-exit");
  window.setTimeout(close, EXIT_MS);
}
