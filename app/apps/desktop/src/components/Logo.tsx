// Baalda brand logo — the official neural-connection wordmark (a node
// constellation forming the second "A"). Ink on light, chrome/silver on dark.
//
// A CSS background rather than two <img> siblings with one hidden by CSS: a
// browser fetches a background image only for an element that actually
// renders, so the splash downloads exactly the one PNG the current theme shows
// (App.css) instead of both.

/** The Baalda wordmark (neural mark in the second A). Ink version shows on
 *  the light theme, silver on dark — switched in App.css. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark ${className ?? ""}`} role="img" aria-label="Baalda" />
  );
}
