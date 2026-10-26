// A page in the Skills tab opens at the top; a grid comes back where it was.
//
// The grid views scroll inside their own `.skills-scroll` (so the "Works with"
// footer can sit outside it, flush with the panel's bottom); every other page
// scrolls the Settings panel itself (`.settings-content`). On every change of
// view this puts whichever is scrolling back at the top, or, coming back to a
// grid, where that grid was, unless a highlight is about to scroll a card into
// view itself.

import { useCallback, useLayoutEffect, useRef } from "react";

function scroller(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(".settings-page .skills-scroll") ??
    document.querySelector<HTMLElement>(".settings-page .settings-content")
  );
}

/** Returns the grid's onScroll recorder. */
export function useScrollReset(viewKey: string, highlightPending: boolean) {
  const saved = useRef(new Map<string, number>());
  const last = useRef(viewKey);
  useLayoutEffect(() => {
    if (last.current === viewKey) return;
    last.current = viewKey;
    const el = scroller();
    if (!el) return;
    const back = viewKey.startsWith("grid:") && !highlightPending ? saved.current.get(viewKey) ?? 0 : 0;
    el.scrollTop = back;
    // A page that scrolls the panel itself: the panel starts at the top too.
    const content = document.querySelector<HTMLElement>(".settings-page .settings-content");
    if (content && content !== el) content.scrollTop = 0;
  }, [viewKey, highlightPending]);
  return useCallback((key: string, top: number) => {
    if (key.startsWith("grid:")) saved.current.set(key, top);
  }, []);
}
