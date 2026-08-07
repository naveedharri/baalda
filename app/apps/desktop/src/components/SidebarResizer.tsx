import { useRef, useState } from "react";
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  writeSidebarWidth,
} from "../lib/prefs";

/**
 * Drag handle on the sidebar's right edge. Note titles are as long as people
 * write them, so a fixed rail either truncates them or wastes space on someone
 * whose notes are all called `2026-W30`; this lets the reader decide.
 *
 * Widen-only: the floor is the default width (see `SIDEBAR_WIDTH_MIN`). The
 * width itself comes from `useSidebarWidth`.
 */
export function SidebarResizer({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (px: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  // The pointer grabs the divider somewhere along its 7px width; tracking that
  // offset stops the sidebar from jumping by a few pixels on the first move.
  const grabOffset = useRef(0);

  const commit = (px: number) => {
    onWidth(px);
    writeSidebarWidth(clampSidebarWidth(px, window.innerWidth));
  };

  return (
    <div
      className={`sidebar-resizer${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        // Without this the press seeds a native text selection, and sweeping
        // left highlights the whole sidebar as you drag. `user-select: none`
        // alone can't help — by the time the class lands the selection has
        // already begun.
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        // Capture on the handle so the drag survives the pointer outrunning it —
        // easy to do when you hit the min/max and keep moving.
        e.currentTarget.setPointerCapture(e.pointerId);
        grabOffset.current = e.clientX - width;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onWidth(e.clientX - grabOffset.current);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        commit(e.clientX - grabOffset.current);
      }}
      onDoubleClick={() => commit(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        // Keyboard users get the same control; Home restores the default.
        const step = e.shiftKey ? 32 : 8;
        if (e.key === "ArrowLeft") commit(width - step);
        else if (e.key === "ArrowRight") commit(width + step);
        else if (e.key === "Home") commit(SIDEBAR_WIDTH_DEFAULT);
        else return;
        e.preventDefault();
      }}
    />
  );
}
