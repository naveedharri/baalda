/**
 * The app's one tick: a drawn check instead of the "✓" text glyph, whose
 * shape and weight change with the font and read as off at small sizes.
 */
export function CheckIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`check-icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-6.5" />
    </svg>
  );
}
