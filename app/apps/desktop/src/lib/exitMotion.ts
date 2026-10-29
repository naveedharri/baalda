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

/**
 * Redesign: crossfade a screen that is about to unmount. Call from a layout
 * effect's cleanup (the node is still in the DOM): a static copy is pinned
 * over the window and fades out while whatever replaces it renders below.
 */
export function leaveWithGhost(node: HTMLElement | null): void {
  if (!node || !node.isConnected) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const rect = node.getBoundingClientRect();
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.classList.add("rd-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText += `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:9999;pointer-events:none;`;
  // Dialogs over the screen (sign in) go with it rather than lingering.
  ghost.querySelectorAll(".modal-backdrop").forEach((el) => el.remove());
  document.body.appendChild(ghost);
  window.setTimeout(() => ghost.remove(), 420);
}
