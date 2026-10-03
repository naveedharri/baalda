// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";
import { SPINNER_DELAY } from "../lib/useAsyncAction";
import { Spinner } from "./Spinner";

/**
 * Keep a tree row's type glyph mounted while a note opens. Fast opens stay
 * visually quiet; a slow open swaps the glyph for a spinner after the
 * app-wide spinner delay.
 *
 * The swap is visual only: the glyph stays in the DOM (hidden via
 * `data-hidden`, so its box still holds the row's layout) and the spinner is
 * centred over that same box. Unmounting the icon was visible as a blink, and
 * drawing a ring AROUND it left the two overlapping.
 */
export function OpeningGlyph({
  opening,
  children,
}: {
  opening: boolean;
  children: ReactNode;
}) {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!opening) {
      setDelayed(false);
      return;
    }
    const timer = window.setTimeout(() => setDelayed(true), SPINNER_DELAY);
    return () => window.clearTimeout(timer);
  }, [opening]);

  const spinning = opening && delayed;
  return (
    <>
      <span className="tree-glyph-icon" data-hidden={spinning || undefined}>
        {children}
      </span>
      {spinning && (
        <Spinner size="xs" tone="accent" className="tree-opening-spinner" />
      )}
    </>
  );
}
