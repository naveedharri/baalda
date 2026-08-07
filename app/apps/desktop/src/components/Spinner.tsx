/**
 * The app's one spinner. Before this there were three hand-rolled rings
 * (updater button, vault picker, upgrade dialog) with different sizes and
 * durations, which is how a product ends up feeling assembled rather than
 * designed — the same wait should look the same everywhere.
 *
 * Tones exist only where `currentColor` would be wrong:
 * - `inherit` (default) takes the colour of whatever it sits in, which is right
 *   almost everywhere — including a red "Delete" link, where a fixed neutral
 *   grey would quietly contradict the button it belongs to.
 * - `on-accent` for a filled accent button, where the ring's translucent track
 *   would vanish into the fill.
 * - `accent` / `neutral` for standalone spinners with no meaningful inherited
 *   colour (a vault row, the picker's landing state).
 */
export function Spinner({
  size = "sm",
  tone = "inherit",
  className,
}: {
  size?: "xs" | "sm" | "md";
  tone?: "inherit" | "neutral" | "accent" | "on-accent";
  className?: string;
}) {
  return (
    <span
      className={`spinner spinner-${size} spinner-${tone}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    />
  );
}

/**
 * The success half of a feedback loop: a check that draws itself in ~260ms
 * rather than appearing whole. The stroke-dash animation is what makes it read
 * as "this just completed" instead of "this was always ticked".
 */
export function CheckMark({ size = "sm" }: { size?: "xs" | "sm" | "md" }) {
  return (
    <svg
      className={`checkmark checkmark-${size}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
