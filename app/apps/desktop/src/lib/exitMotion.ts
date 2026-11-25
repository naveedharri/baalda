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

/**
 * Redesign: the settings cross-link ("Vault settings ↗" / "Account settings ↗")
 * swaps one dialog for the other. Unmounting one and mounting the next made the
 * dimmed backdrop blink and the new card rise in: the window looked killed and
 * re-popped. Now the new dialog appears at once under a static copy of the old
 * card, and only that copy fades, once the new one has painted: one dissolve,
 * nothing half-transparent, nothing sliding, the backdrop never moving.
 */
let settingsSwapAt = -Infinity;

export function swapSettingsWithFade(card: HTMLElement | null, open: () => void): void {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!card || !card.isConnected || reduce) {
    open();
    return;
  }
  settingsSwapAt = performance.now();
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add("settings-swap-ghost");
  ghost.removeAttribute("role");
  ghost.removeAttribute("aria-modal");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText += `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;z-index:250;pointer-events:none;animation:none;opacity:1;`;
  document.body.appendChild(ghost);
  open();
  let done = false;
  const remove = () => {
    if (done) return;
    done = true;
    ghost.remove();
  };
  // Two frames: React has committed the new dialog and the browser painted it
  // under the copy. Starting earlier let the fade run while the new dialog was
  // still being built, so it stuttered or was cut short.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      ghost.addEventListener("animationend", remove, { once: true });
      ghost.style.animation = "";
      ghost.classList.add("is-leaving");
    }),
  );
  window.setTimeout(remove, 1200);
}

/** Did a cross-link swap just start? The incoming settings dialog then shows at
 *  once (no backdrop fade, no rise, no tab glide). Read, never cleared, so a
 *  double render in development answers the same both times. */
export function settingsSwapJustStarted(): boolean {
  return performance.now() - settingsSwapAt < 1000;
}
