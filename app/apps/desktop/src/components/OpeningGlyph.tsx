// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from "react";
import { SPINNER_DELAY } from "../lib/useAsyncAction";
import { Spinner } from "./Spinner";

/**
 * Keep a tree row's type glyph mounted while a note opens. Fast opens stay
 * visually quiet; a slow open adds a progress ring around the existing glyph
 * after the app-wide spinner delay.
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

  return (
    <>
      {children}
      {opening && delayed && (
        <Spinner size="xs" tone="accent" className="tree-opening-spinner" />
      )}
    </>
  );
}
