// Scrolling one pane into view inside whatever container actually scrolls.
//
// `Element.scrollIntoView` is the obvious call and the wrong one: it scrolls
// EVERY scrollable ancestor, so in a modal it moves the page behind the modal
// too (see the warning in `components/VersionPanel.tsx`). We find the one
// container that scrolls and set its `scrollTop` ourselves.
//
// The arithmetic is separated from the DOM so it can be tested: the component
// measures, this decides.

export interface DetailScrollInput {
  /** Pane top, as an offset inside the container's scrollable content. */
  paneTop: number;
  paneHeight: number;
  /** The container's current scroll offset. */
  scrollTop: number;
  /** The container's visible height (`clientHeight`). */
  clientHeight: number;
  /** The container's full scrollable height (`scrollHeight`). */
  scrollHeight: number;
  /** Breathing room left above the pane when it is scrolled to the top. */
  margin?: number;
  /**
   * Bottom edge of the block that must end up on screen — the per-item mode
   * control — in the same coordinate space as {@link paneTop}.
   *
   * The pane opens with a breadcrumb, a title and up to two banners above the
   * controls, so "scroll the pane to the top" can still leave the three buttons
   * the click was *about* below the fold on a short window. Given this, the plan
   * puts the control's BOTTOM edge inside the viewport — and its top too, in any
   * container taller than the control plus the margin, which every real window
   * is (the tri-state is ~110px).
   */
  anchorBottom?: number;
}

/**
 * Where the container should scroll to bring the pane — and, when given, the
 * mode control inside it — into view. `null` means do not move.
 *
 * `null` covers the two cases that make an animation feel like a glitch: what
 * matters is already visible, and the scroll it would need is under a pixel.
 */
export function planDetailScroll(input: DetailScrollInput): number | null {
  const margin = input.margin ?? 0;
  const viewTop = input.scrollTop;
  const viewBottom = input.scrollTop + input.clientHeight;
  const paneVisible =
    input.paneTop >= viewTop && input.paneTop + input.paneHeight <= viewBottom;
  const anchorVisible =
    input.anchorBottom === undefined ||
    (input.anchorBottom <= viewBottom && input.paneTop >= viewTop);
  if (paneVisible && anchorVisible) return null;

  const maxScroll = Math.max(0, input.scrollHeight - input.clientHeight);
  // Preferred: the pane's top under the margin. Required: the anchor's bottom
  // inside the viewport. When the pane is taller than the window the second
  // wins, and the view lands lower down the pane rather than on its title.
  const preferred = input.paneTop - margin;
  const required =
    input.anchorBottom === undefined
      ? preferred
      : input.anchorBottom + margin - input.clientHeight;
  const target = Math.min(Math.max(Math.max(preferred, required), 0), maxScroll);
  if (Math.abs(target - input.scrollTop) < 1) return null;
  return target;
}

/**
 * The nearest ancestor that actually scrolls — found by computed style rather
 * than by class name, so moving the Access panel out of the settings card does
 * not silently break the scroll.
 */
export function scrollableAncestor(el: Element | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Does the viewer want motion kept to a minimum? */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Scroll `pane` towards the top of its scrolling container. A no-op when
 * nothing scrolls, or when the pane is already fully in view.
 */
export function scrollPaneIntoContainer(
  pane: HTMLElement | null,
  /** The block that must end up visible — the per-item mode control. */
  anchor: HTMLElement | null = null,
  margin = 12,
): void {
  if (!pane) return;
  const container = scrollableAncestor(pane);
  if (!container) return;
  const paneRect = pane.getBoundingClientRect();
  const boxRect = container.getBoundingClientRect();
  // `clientTop` is the container's top border: `getBoundingClientRect` is a
  // border box, `scrollTop` is measured from the padding box.
  const toContent = (clientY: number) =>
    clientY - boxRect.top - container.clientTop + container.scrollTop;
  const anchorRect = anchor?.getBoundingClientRect();
  const top = planDetailScroll({
    paneTop: toContent(paneRect.top),
    paneHeight: paneRect.height,
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
    margin,
    anchorBottom: anchorRect ? toContent(anchorRect.bottom) : undefined,
  });
  if (top === null) return;
  container.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}
