import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as ipc from "../lib/ipc";
import { copyText } from "../lib/clipboard";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { Spinner } from "./Spinner";
import { displayVaultPath } from "../lib/vaultRows";
import { useSwitcherRows, useVaultShortcuts, VaultSwitcherPopover, VaultTile } from "./VaultSwitcher";

/**
 * Sidebar header: the name of the vault you're in, where it lives on disk,
 * and a way to open that folder. The name opens the vault switcher (Slack's
 * workspace menu); account things stay in the account menu at the foot of the
 * sidebar, and sync state is reported by the indicator in the main header.
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
  const switching = useStore((s) => s.switchingVault);
  // The folder is gone (#228): the path below names nothing, so say so.
  const rootMissing = useStore((s) => s.structureNotice.rootMissing);
  const reduceMotion = useReducedMotion();

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = useSwitcherRows();
  useVaultShortcuts(rows);
  // Close the switcher on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedPath) return;
    const timer = setTimeout(() => setCopiedPath(null), 1800);
    return () => clearTimeout(timer);
  }, [copiedPath]);

  if (!vault) return null;
  const copyPath = async () => {
    if (switching) return;
    if (await copyText(vault.path)) setCopiedPath(vault.path);
    else toast("Couldn't copy the vault path", "error");
  };

  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  // While a switch is in flight, name the vault we're going TO. This is an
  // optimistic label, and deliberately so: the switch is many round trips, and
  // showing the vault being left until the very last one is what made switching
  // feel like it hadn't registered. If the switch fails the store clears the
  // flag and this snaps back to the truth.
  const name = switching?.name ?? (syncEnabled && activeOrg ? activeOrg.name : vault.name);
  // The tile matches the vault's card in the switcher: the target while a switch
  // is in flight, else the open one.
  const tileIdentity = switching
    ? switching.orgId
      ? `org:${switching.orgId}`
      : (rows.find((r) => r.name === switching.name)?.key ?? `local:${switching.name}`)
    : (rows.find((r) => r.current)?.key ?? `local:${vault.path}`);

  return (
    // Drag region: the window has no system title bar to grab (see
    // `titleBarStyle: "Overlay"` in tauri.conf.json), and this row occupies the
    // strip the macOS traffic lights float over. "deep" makes the whole subtree
    // draggable — padding, name and path alike — while Tauri still lets real
    // controls through, so the reveal-folder button below keeps working.
    <div
      ref={rootRef}
      className={`sidebar-header${switching ? " is-switching" : ""}`}
      data-tauri-drag-region="deep"
    >
      {/* The vault's tile spans both lines (name + path), like the cards in
          the switcher it opens; it is a second handle for the same menu. */}
      <div className="sidebar-header-id">
        <button
          type="button"
          className="vault-switch-tile"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <VaultTile identity={tileIdentity} name={name} />
        </button>
        <div className="sidebar-header-text">
          <div className="sidebar-header-main">
            <button
              type="button"
              className={`vault-switch-btn${menuOpen ? " open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Switch vault"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {/* Keyed on the name so a switch cross-fades between the two vaults
                  rather than swapping the text in place. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={name}
                  className="vault-name"
                  title={name}
                  initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: 4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0, 0, 1] }}
                >
                  {name}
                </motion.span>
              </AnimatePresence>
              <svg
                className="vault-switch-chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {switching && <Spinner size="xs" tone="accent" className="vault-switch-spinner" />}
          </div>
          <div className="vault-line" title={vault.path}>
            {/* The path is the one thing that is genuinely still the OLD vault's
                while switching — the folder hasn't swapped yet. Say so rather than
                showing a path that contradicts the name above it. */}
            <span
              className="vault-path-copy"
              role="button"
              tabIndex={switching ? -1 : 0}
              aria-disabled={!!switching}
              title={`Copy ${vault.path}`}
              aria-label="Copy vault folder path"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void copyPath()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void copyPath();
                }
              }}
            >
              <span className={`vault-path${rootMissing && !switching ? " is-missing" : ""}`}>
                {sidebarPathLabel(vault.path, { switching: !!switching, rootMissing })}
              </span>
              {copiedPath === vault.path && !switching && (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                  className="vault-path-copied" role="img" aria-label="Path copied">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </span>
            {/* Reveal-in-file-manager sits on the path row — it acts on the path,
                so it belongs beside it — and stays visible: an affordance that only
                appears on hover is one nobody finds. */}
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
        </div>
        {/* Anchored to the tile + name block, so it opens right under it. */}
        {menuOpen && <VaultSwitcherPopover rows={rows} onClose={() => setMenuOpen(false)} />}
      </div>
    </div>
  );
}

/** What the path line reads: the switch, the missing folder (#228), or the path. */
export function sidebarPathLabel(
  path: string,
  state: { switching: boolean; rootMissing: boolean },
): string {
  if (state.switching) return "Switching…";
  if (state.rootMissing) return "Folder missing";
  return displayVaultPath(path);
}
