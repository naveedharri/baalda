// A small full-window image viewer: wheel / pinch to zoom about the cursor,
// drag to pan, Esc or a click on the backdrop to close. Plain DOM rather than
// React so the CodeMirror image widget (which lives outside the React tree) and
// the file preview can both open it with one call.

import { clampZoom, zoomAt, zoomFromWheel, zoomIn, zoomKeyAction, zoomOut, type View } from "./imageZoom";

let closeCurrent: (() => void) | null = null;

export function openImageLightbox(src: string, alt = ""): void {
  closeCurrent?.();

  const backdrop = document.createElement("div");
  backdrop.className = "image-lightbox";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", alt || "Image");
  backdrop.tabIndex = -1;

  const img = document.createElement("img");
  img.className = "image-lightbox-img";
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  backdrop.appendChild(img);

  let view: View = { zoom: 1, x: 0, y: 0 };
  const render = () => {
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  };

  // Cursor offset from the image's untransformed centre (= the viewport centre).
  const fromCentre = (e: { clientX: number; clientY: number }) => {
    const r = backdrop.getBoundingClientRect();
    return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)] as const;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [px, py] = fromCentre(e);
    view = zoomAt(view, zoomFromWheel(view.zoom, e.deltaY), px, py);
    render();
  };

  let drag: { sx: number; sy: number; x: number; y: number; moved: boolean } | null = null;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
    backdrop.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view = { ...view, x: drag.x + dx, y: drag.y + dy };
    backdrop.classList.toggle("dragging", drag.moved);
    render();
  };
  const onUp = (e: PointerEvent) => {
    const wasDrag = drag?.moved ?? false;
    drag = null;
    backdrop.classList.remove("dragging");
    // A click (no drag) on the backdrop — not on the image — closes.
    if (!wasDrag && e.target === backdrop) close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const action = zoomKeyAction(e);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "reset") view = { zoom: 1, x: 0, y: 0 };
    else view = { ...view, zoom: clampZoom(action === "in" ? zoomIn(view.zoom) : zoomOut(view.zoom)) };
    render();
  };

  function close() {
    window.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    if (closeCurrent === close) closeCurrent = null;
  }

  backdrop.addEventListener("wheel", onWheel, { passive: false });
  backdrop.addEventListener("pointerdown", onDown);
  backdrop.addEventListener("pointermove", onMove);
  backdrop.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey, true);

  document.body.appendChild(backdrop);
  backdrop.focus();
  render();
  closeCurrent = close;
}
