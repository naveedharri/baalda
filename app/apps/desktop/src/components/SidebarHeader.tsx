import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHoverMenu } from "./useHoverMenu";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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

  // Hover previews the switcher, a click pins it (shared with the identity bar).
  const {
    open: menuOpen,
    close: closeMenu,
    toggle: togglePinnedMenu,
    pin: pinMenu,
    hoverEnter,
    hoverLeave: scheduleHoverClose,
    cancelHoverClose,
  } = useHoverMenu();
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = useSwitcherRows();
  useVaultShortcuts(rows);
  // Close the switcher on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);

  // The chevron shows only while the whole name fits beside it; a long name
  // drops it and takes that room instead. Judged against the width WITH the
  // chevron, so hiding it can never make the name fit and flip it back.
  const mainRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [longName, setLongName] = useState(false);

  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedPath) return;
    const timer = setTimeout(() => setCopiedPath(null), 1800);
    return () => clearTimeout(timer);
  }, [copiedPath]);

  const activeOrg =
    organizations.find((o) => o.id === session?.activeOrganizationId) ?? null;
  // While a switch is in flight, name the vault we're going TO. This is an
  // optimistic label, and deliberately so: the switch is many round trips, and
  // showing the vault being left until the very last one is what made switching
  // feel like it hadn't registered. If the switch fails the store clears the
  // flag and this snaps back to the truth.
  const name = vault
    ? (switching?.name ?? (syncEnabled && activeOrg ? activeOrg.name : vault.name))
    : "";
  const measureName = () => {
    const main = mainRef.current;
    const nameEl = nameRef.current;
    if (!main || !nameEl) return;
    // The button may use the row minus 19px (see `.vault-switch-btn` in
    // App.css); inside it: 4px padding each side, an 8px gap, a 20px chevron.
    setLongName(nameEl.scrollWidth > main.clientWidth - 19 - 8 - 8 - 20);
  };
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    measureName();
    const ro = new ResizeObserver(() => measureName());
    ro.observe(main);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, !!vault]);

  if (!vault) return null;
  const copyPath = async () => {
    if (switching) return;
    if (await copyText(vault.path)) setCopiedPath(vault.path);
    else toast("Couldn't copy the vault path", "error");
  };

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
    // controls through, so the switcher button keeps working.
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
          onPointerEnter={hoverEnter}
          onPointerLeave={scheduleHoverClose}
          onClick={togglePinnedMenu}
        >
          <VaultTile identity={tileIdentity} name={name} />
        </button>
        {/* The name, chevron and path hover-open the switcher too, so sweeping
            across the header never flickers it. Not the wrapper above: the
            popover lives inside it, and a move from the menu back up to the
            name would then never count as re-entering. */}
        <div
          className="sidebar-header-text"
          onPointerEnter={hoverEnter}
          onPointerLeave={scheduleHoverClose}
        >
          <div className="sidebar-header-main" ref={mainRef}>
            <button
              type="button"
              className={`vault-switch-btn${menuOpen ? " open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={menuOpen ? undefined : "Switch vault"}
              onClick={togglePinnedMenu}
            >
              {/* Keyed on the name so a switch cross-fades between the two vaults
                  rather than swapping the text in place. */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={name}
                  // Measured as it mounts too: on a switch the new name's span
                  // arrives after the old one's exit animation.
                  ref={(el: HTMLSpanElement | null) => {
                    nameRef.current = el;
                    if (el) measureName();
                  }}
                  className="vault-name"
                  // No tooltip while the switcher shows: it would sit on its rows.
                  title={menuOpen ? undefined : name}
                  initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: 4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0, 0, 1] }}
                >
                  {name}
                </motion.span>
              </AnimatePresence>
              {!longName && (
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
              )}
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
          </div>
        </div>
        {/* Anchored to the tile + name block, so it opens right under it. */}
        {menuOpen && <VaultSwitcherPopover
          rows={rows}
          onClose={closeMenu}
          onPointerEnter={cancelHoverClose}
          onPointerLeave={scheduleHoverClose}
          onPointerDownCapture={pinMenu}
          onFocusCapture={pinMenu}
        />}
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
