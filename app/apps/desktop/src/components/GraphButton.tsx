// SPDX-License-Identifier: Apache-2.0

export function GraphButton({ onClick, titlebar = false }: {
  onClick: () => void;
  titlebar?: boolean;
}) {
  const modifier = document.documentElement.dataset.platform === "windows" ? "Ctrl+" : "⌘";
  return (
    <button
      type="button"
      className={`${titlebar ? "titlebar-tool" : "icon-btn"} graph-btn`}
      title={`Graph view (${modifier}G)`}
      aria-label="Open graph view"
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="5.5" cy="6" r="2.5" />
        <circle cx="18" cy="4.5" r="2" />
        <circle cx="12.5" cy="13" r="2.5" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="19.5" cy="18.5" r="2.5" />
        <path d="M7.8 7.2 10.6 11M14.4 11.3 16.6 6M11 15 7.3 17.6M14.8 14.6l3 2.6" />
      </svg>
    </button>
  );
}
