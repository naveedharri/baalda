/* The 24x24 stroked icon frame every menu row and settings tab uses. Its own
   module because both halves of the account menu need it — the eager popovers
   and the lazy vault-settings dialog. */
import type { ReactNode } from "react";

export function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="menu-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
