import { useEffect, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";

/** Collapse the home prefix for display, dropping the leading "~":
 *  /Users/x/Documents/Notes → /Documents/Notes. */
function tidyPath(path: string): string {
  const m = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)(.*)$/);
  return m ? m[2] : path;
}

const FOLDER_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

/**
 * Sidebar header: the workspace you're in leads; the local folder backing it
 * is a quiet storage line underneath. "Switch" switches the WORKSPACE (it
 * opens a dropdown of your workspaces); changing the local folder is the
 * subtle last item in that same menu. Signed out — no workspaces to switch —
 * the folder takes the headline and Switch picks a folder, as before.
 */
export function SidebarHeader() {
  const vault = useStore((s) => s.vault);
  const session = useStore((s) => s.session);
  const organizations = useStore((s) => s.organizations);

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!vault) return null;

  const activeOrgId = session?.activeOrganizationId ?? null;
  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? null;

  const switchVault = async () => {
    setOpen(false);
    const v = await ipc.pickVault();
    if (v) {
      useStore.getState().setVault(v);
      useStore.getState().closeNote();
      await useStore.getState().refreshTree();
      await useStore.getState().refreshTitles();
      await useStore.getState().enableSyncForVault();
    }
  };

  const createOrg = async () => {
    if (!orgName.trim()) return;
    setBusy(true);
    try {
      await useStore.getState().createOrganization(orgName.trim());
      setOrgName("");
      setCreating(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  // Signed out or no workspace yet: there's no workspace to lead with, so we
  // say so plainly and show the local folder as what it actually is — the
  // folder you're editing, not a workspace. "Switch" here changes the folder.
  if (!activeOrg) {
    return (
      <div className="sidebar-header">
        <div className="sidebar-header-main">
          <span className="vault-name none">No workspace</span>
        </div>
        <div className="vault-line">
          {FOLDER_ICON}
          <span className="vault-line-name" title={vault.path}>
            {vault.name}
          </span>
          <button className="link-btn" onClick={() => void switchVault()}>
            Switch
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-header" ref={rootRef}>
      <div className="sidebar-header-main">
        <span className="vault-name" title={activeOrg.name}>
          {activeOrg.name}
        </span>
        <button
          className="link-btn"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          Switch
        </button>
      </div>
      <div className="vault-line">
        {FOLDER_ICON}
        <span className="vault-line-name" title={vault.path}>
          {tidyPath(vault.path)}
        </span>
      </div>

      {open && (
        <div className="workspace-popover" role="menu">
          <div className="menu-label">Switch workspace</div>
          {[
            ...organizations.filter((o) => o.id === activeOrgId),
            ...organizations.filter((o) => o.id !== activeOrgId),
          ].map((o) => {
            const isActive = o.id === activeOrgId;
            return (
              <button
                key={o.id}
                className={`menu-item${isActive ? " active" : ""}`}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  if (!isActive) {
                    void useStore.getState().setActiveOrganization(o.id);
                  }
                  setOpen(false);
                }}
              >
                <span className="menu-swatch" aria-hidden="true">
                  {o.name[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="menu-item-label">{o.name}</span>
                {isActive && (
                  <>
                    <span className="menu-current">Current</span>
                    <svg
                      className="menu-check"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </>
                )}
              </button>
            );
          })}

          {creating ? (
            <div className="menu-create-org">
              <input
                autoFocus
                placeholder="Workspace name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createOrg();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <button className="primary sm" disabled={busy} onClick={() => void createOrg()}>
                Create
              </button>
            </div>
          ) : (
            <button className="menu-item subtle" onClick={() => setCreating(true)}>
              <span className="menu-swatch plus" aria-hidden="true">
                +
              </span>
              <span className="menu-item-label">New workspace</span>
            </button>
          )}

          <div className="menu-sep" />
          <button className="menu-item subtle" onClick={() => void switchVault()}>
            <span className="menu-icon">{FOLDER_ICON}</span>
            <span className="menu-item-label">Change local folder…</span>
            <span className="menu-hint" title={vault.path}>
              {vault.name}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
