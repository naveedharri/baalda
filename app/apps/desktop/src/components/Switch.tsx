/**
 * The app's toggle switch.
 *
 * A real `<input type="checkbox">` underneath, visually replaced — so it keeps
 * every behaviour a checkbox already has for free (label association, Space to
 * toggle, focus ring, form semantics) and only the paint changes. Rebuilding it
 * as a `<button role="switch">` would mean re-earning all of that by hand.
 *
 * The knob is animated because a setting like "Freeze vault root" is a
 * *decision*, and a control that slides confirms the decision landed; a native
 * checkbox blinking between two states does not.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <span className={`switch${checked ? " on" : ""}${disabled ? " is-disabled" : ""}`} title={title}>
      <input
        type="checkbox"
        className="switch-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </span>
  );
}
