import { useStore } from "../store";

/**
 * Sidebar header: the name of the vault you're in. That's all.
 *
 * It used to carry a "Switch" dropdown, which duplicated the vault switcher
 * already in the account menu at the foot of this same sidebar — two controls
 * for one job, at opposite ends of one column. The account menu's version is
 * the better one (it also joins by code, badges remote vaults, and links to
 * Vault settings for the full list), so this one went rather than being kept in
 * sync forever. Its one unique action, "Change local folder…", moved there too.
 *
 * The header is now a label, not a control: no popover, no outside-click
 * handling, no state. The full path is the tooltip.
 */
export function SidebarHeader() {
  const vault = useStore((s) => s.vault);
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);

  if (!vault) return null;

  const activeOrgId = session?.activeOrganizationId ?? null;
  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? null;

  return (
    <div className="sidebar-header">
      <div className="sidebar-header-main">
        {/* One name, one place. The local folder used to get its own line here,
            but a vault's folder is created as `slugify(vault name)`, so that
            line said the same thing twice on every vault anyone actually has —
            "BenAI OS" over "benai-os". */}
        <span className="vault-name" title={vault.path}>
          {activeOrg ? activeOrg.name : vault.name}
        </span>
      </div>
      {/* A local folder is still a vault — it just isn't syncing yet, and that
          IS worth a second line because nothing else on screen says so. */}
      {!activeOrg && (
        <div className="vault-line">
          <span className="ws-badge local">Local</span>
          <span className="vault-line-name">Not synced</span>
        </div>
      )}
    </div>
  );
}
