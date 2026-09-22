// SPDX-License-Identifier: Apache-2.0

/** Window-chrome control for showing and hiding the vault sidebar. */
export function SidebarToggle({
  hidden,
  onToggle,
  searchOpen,
  onSearch,
}: {
  hidden: boolean;
  onToggle: () => void;
  searchOpen: boolean;
  onSearch: () => void;
}) {
  return (
    <div className="titlebar-tools">
      <button
        type="button"
        className="titlebar-tool sidebar-toggle"
        aria-label={hidden ? "Show sidebar" : "Hide sidebar"}
        aria-controls="vault-sidebar"
        aria-expanded={!hidden}
        title={hidden ? "Show sidebar" : "Hide sidebar"}
        onClick={onToggle}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <path d="M9 5v14" />
        </svg>
      </button>
      <button
        type="button"
        className="titlebar-tool titlebar-search"
        title="Search notes (⌘F)"
        aria-label="Search notes"
        aria-pressed={searchOpen}
        onClick={onSearch}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>
    </div>
  );
}
