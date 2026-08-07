import * as ipc from "../lib/ipc";
import { useStore } from "../store";

/**
 * Sidebar header: the name of the vault you're in, where it lives on disk,
 * and a way to open that folder. A label, not a control — the vault switcher
 * lives in the account menu at the foot of this same sidebar, and sync state
 * is already reported by the indicator in the main header.
 *
 * The name always names the vault whose folder is actually OPEN — a local
 * vault wins over a still-set activeOrg once sync is off, because opening a
 * local folder disables sync but leaves the account's active org untouched.
 * Reading `activeOrganizationId` alone is what used to freeze a stale org
 * name up here after switching to a local vault.
 */
export function SidebarHeader() {
  const vault = useStore((s) => s.vault);
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);
  const syncEnabled = useStore((s) => s.syncEnabled);

  if (!vault) return null;

  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  const name = syncEnabled && activeOrg ? activeOrg.name : vault.name;

  return (
    <div className="sidebar-header">
      <div className="sidebar-header-main">
        <span className="vault-name" title={name}>
          {name}
        </span>
        <button
          className="icon-btn vault-reveal"
          title={`Open ${vault.path} in your file manager`}
          aria-label="Open vault folder"
          onClick={() =>
            void ipc.openInFileManager(vault.path).catch((e) => {
              console.error("open vault folder failed", e);
            })
          }
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" />
            <path d="M2 18l2.5-6h17L19 18a2 2 0 0 1-1.9 1.4H4" />
          </svg>
        </button>
      </div>
      <div className="vault-line" title={vault.path}>
        <span className="vault-path">{displayPath(vault.path)}</span>
      </div>
    </div>
  );
}

/**
 * Shorten an absolute vault path for display by dropping the home directory —
 * `/Documents/Baalda Vaults/notes` rather than the full `/Users/…` prefix,
 * which is the same on every line and tells you nothing. The full path stays
 * in the tooltip.
 *
 * The home prefix is inferred from the path itself rather than asked of the
 * OS — this is a synchronous label, and `/Users/<me>/…` (macOS), `/home/<me>/…`
 * (Linux) and `C:\Users\<me>\…` (Windows) are all recognizable on sight.
 */
function displayPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(path);
  return home ? path.slice(home[0].length) : path;
}
