/**
 * The quiet link pinned to the bottom of a settings dialog's nav, pointing at
 * the OTHER settings dialog ("Account settings ↗" / "Vault settings ↗").
 * It sits after a hairline and is pushed down by `margin-top: auto`, so it
 * stays at the bottom however many sections the nav lists.
 */
export function SettingsCrossLink({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className="settings-nav-crosslink">
      <button type="button" className="menu-item" onClick={onOpen}>
        <span className="menu-item-label">{label}</span>
        <svg
          className="settings-nav-crosslink-arrow"
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M7 17 17 7M8 7h9v9" />
        </svg>
      </button>
    </div>
  );
}
