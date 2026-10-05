import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as ipc from "../lib/ipc";
import { readOrgVaults, useStore } from "../store";
import { POPOVER_VAULT_ROWS, recentVaultRows, type VaultRow } from "../lib/vaultRows";
import { ITEM_COLORS, vaultTileColor } from "../lib/appearance";
import {
  NO_COLOR,
  onLocalVaultIconChange,
  readLocalVaultIcon,
  resolveVaultIcon,
} from "../lib/vaultIcon";
import { useLocalVaults, useRecentVaults } from "./useVaultLists";
import { MenuIcon } from "./MenuIcon";

// DiceBear is heavy; the tile paints its initial until the glyph chunk lands.
const VaultIconSvg = lazy(() => import("./VaultIconSvg"));

const MOD_IS_META = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The switcher's vaults: the four most recently opened (the open one always
 * among them), SHOWN by name. Recency picks which four; the name order is for
 * the ⌘1…⌘4 shortcuts — by recency the open vault would always be ⌘1 and every
 * number would move on each switch. By name, ⌘2 stays the same vault until a
 * fifth vault is opened and pushes one off the list.
 */
export function useSwitcherRows(): VaultRow[] {
  const signedIn = useStore((s) => s.authStatus === "signed-in" && !!s.session);
  const organizations = useStore((s) => s.organizations);
  const openPath = useStore((s) => s.vault?.path) ?? null;
  const recents = useRecentVaults();
  const locals = useLocalVaults();
  return useMemo(
    () =>
      recentVaultRows({
        // Signed out there are no vaults in an account, only local folders.
        organizations: signedIn ? organizations : [],
        locals,
        orgVaults: readOrgVaults(),
        openedAt: Object.fromEntries(recents.map((r) => [r.path, r.openedAt])),
        openPath,
        budget: POPOVER_VAULT_ROWS,
      }).sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
          a.key.localeCompare(b.key),
      ),
    [signedIn, organizations, locals, recents, openPath],
  );
}

function switchToVault(row: VaultRow) {
  if (row.current) return;
  // Fire-and-forget on purpose: the switch is long and the menu should not sit
  // open through it. The sidebar header renames itself to this vault at once
  // (`switchingVault`) and spins until the folder has swapped.
  if (row.kind === "synced") void useStore.getState().setActiveOrganization(row.orgId);
  else void useStore.getState().openLocalVault(row.path);
}

/** ⌘1…⌘4 (Ctrl elsewhere) switch to the vault at that position in the menu. */
export function useVaultShortcuts(rows: readonly VaultRow[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = MOD_IS_META ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // Alt is taken: Mod-Alt-1…6 sets a heading level in the editor.
      if (!mod || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
      const row = rows[Number(e.key) - 1];
      if (!row) return;
      e.preventDefault();
      if (useStore.getState().switchingVault) return;
      switchToVault(row);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows]);
}

/**
 * The stored icon value for a switcher identity: the organization's `logo`
 * for a synced vault (`org:<id>`), this device's local setting for a local one
 * (`local:<path>`). Re-renders when either changes.
 */
export type VaultIconSource = "resolved" | "shared" | "personal";

/**
 * The stored icon string for a vault. `resolved` (the default, what every tile
 * paints) prefers this device's personal override of a synced vault, then the
 * team's icon; `shared` / `personal` read just one of the two, for settings.
 */
export function useVaultIconRaw(identity: string, source: VaultIconSource = "resolved"): string | null {
  const isOrg = identity.startsWith("org:");
  const orgLogo = useStore((s) =>
    isOrg ? (s.organizations.find((o) => `org:${o.id}` === identity)?.logo ?? null) : null,
  );
  // A local vault's icon and a synced vault's personal override share one store.
  const localKey = identity.startsWith("local:") ? identity.slice("local:".length) : isOrg ? identity : null;
  const [localIcon, setLocalIcon] = useState(() => (localKey ? readLocalVaultIcon(localKey) : null));
  useEffect(() => {
    if (!localKey) {
      setLocalIcon(null);
      return;
    }
    const read = () => setLocalIcon(readLocalVaultIcon(localKey));
    read();
    return onLocalVaultIconChange(read);
  }, [localKey]);
  if (!isOrg) return localIcon;
  if (source === "shared") return orgLogo;
  if (source === "personal") return localIcon;
  return localIcon ?? orgLogo;
}

/**
 * A vault's icon: its uploaded image, its chosen preset, or — like a person's
 * character — a default picked from its identity. Keyed on the row's `key` so
 * the header, the menu and settings always paint the same vault the same way.
 */
export function VaultTile({
  identity,
  name,
  source = "resolved",
}: {
  identity: string;
  name: string;
  source?: VaultIconSource;
}) {
  const icon = resolveVaultIcon(identity, useVaultIconRaw(identity, source));
  if (icon.kind === "image") {
    return (
      <span className="vault-tile image" aria-hidden="true">
        <img src={icon.src} alt="" draggable={false} />
      </span>
    );
  }
  if (icon.color === NO_COLOR) {
    return (
      <span className="vault-tile none" aria-hidden="true">
        <Suspense fallback={Array.from(name.trim())[0]?.toUpperCase() ?? "?"}>
          <VaultIconSvg icon={icon.icon} color={icon.color} />
        </Suspense>
      </span>
    );
  }
  const color = ITEM_COLORS.find((c) => c.id === icon.color) ?? vaultTileColor(identity);
  return (
    <span
      className="vault-tile"
      style={{ "--tile-fill": color.fill, "--tile-ink": color.value } as CSSProperties}
      aria-hidden="true"
    >
      <Suspense fallback={Array.from(name.trim())[0]?.toUpperCase() ?? "?"}>
        <VaultIconSvg icon={icon.icon} color={icon.color} />
      </Suspense>
    </span>
  );
}

function rowSubtitle(row: VaultRow): string {
  if (row.kind === "local") return "Local";
  // A synced vault with no folder here has never been opened on this device.
  return row.openedAt ? "Synced" : "Synced · not on this device yet";
}

/**
 * The vault menu, opened from the vault name at the top of the sidebar — the
 * Slack workspace switcher: one icon card per vault with its shortcut, then
 * creating/joining, then this vault's settings. Account things (profile,
 * invitations, sign-out) stay in the account menu at the foot of the sidebar.
 */
export function VaultSwitcherPopover({
  rows,
  onClose,
}: {
  rows: readonly VaultRow[];
  onClose: () => void;
}) {
  const signedIn = useStore((s) => s.authStatus === "signed-in" && !!s.session);
  const activeOrgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const members = useStore((s) => s.members);
  const pendingInvitations = useStore((s) => s.pendingInvitations);
  const vault = useStore((s) => s.vault);

  return (
    <div className="vault-popover vault-switcher" role="menu">
      {rows.map((row, i) => (
        <button
          key={row.key}
          className={`vault-card${row.current ? " current" : ""}`}
          role="menuitemradio"
          aria-checked={row.current}
          title={row.kind === "local" ? row.path : undefined}
          onClick={() => {
            switchToVault(row);
            onClose();
          }}
        >
          <VaultTile identity={row.key} name={row.name} />
          <span className="vault-card-meta">
            <span className="vault-card-name">{row.name}</span>
            <span className="vault-card-sub">{rowSubtitle(row)}</span>
          </span>
          <kbd className="vault-card-kbd">
            {MOD_IS_META ? "⌘" : "Ctrl+"}
            {i + 1}
          </kbd>
        </button>
      ))}

      <div className="menu-sep" />
      <NewVaultItem onDone={onClose} />
      {signedIn && <JoinVaultItem onDone={onClose} />}

      {vault && (
        <>
          <div className="menu-sep" />
          <ActionRow
            icon={
              <>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </>
            }
            label="Vault settings"
            hint={
              !signedIn
                ? "Turn on sync"
                : activeOrgId
                  ? `${members.length} member${members.length === 1 ? "" : "s"}${
                      pendingInvitations.length > 0 ? ` +${pendingInvitations.length}` : ""
                    }`
                  : "Local"
            }
            onClick={() => {
              onClose();
              useStore.getState().requestSettings("general");
            }}
          />
          {/* Close the open vault and return to the welcome screen — the only
              way back to it once any vault is open. */}
          <ActionRow
            icon={
              <>
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path d="M9 22V12h6v10" />
              </>
            }
            label="Home"
            hint="Close vault"
            onClick={() => {
              useStore.getState().closeLocalVault();
              onClose();
            }}
          />
        </>
      )}
    </div>
  );
}

/** A non-vault row: the account menu's plain icon + label + hint style. */
function ActionRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button className="menu-item" onClick={onClick}>
      <MenuIcon>{icon}</MenuIcon>
      <span className="menu-item-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

/**
 * "New vault": name it, and it's created under the vaults root.
 *
 * Name-only, matching the welcome screen. Asking which folder was a question
 * with one sensible answer — every vault we create lives under the same root,
 * and a vault's folder is just `slugify(its name)`. Adopting a folder you
 * already have is "Open existing" on the welcome screen, which keeps that
 * folder exactly where it is.
 *
 * Inline rather than a dialog: it's one field, and the menu is already open.
 */
function NewVaultItem({ onDone }: { onDone: () => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const root = await ipc.getVaultsRoot();
      const v = await ipc.createVault(root, trimmed);
      // `seed`: a just-created vault gets first-run starter content (adopting
      // an existing folder never does).
      await useStore.getState().adoptOpenedVault(v, { seed: true });
      setName("");
      setNaming(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!naming) return (
      <ActionRow
        icon={<path d="M12 5v14M5 12h14" />}
        label="New vault"
        onClick={() => setNaming(true)}
      />
    );

  return (
    <>
      <div className="menu-create-org">
        <input
          autoFocus
          placeholder="Vault name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") {
              // Cancel the field, not the whole menu.
              e.stopPropagation();
              setNaming(false);
              setName("");
            }
          }}
        />
        <button className="primary sm" disabled={busy || !name.trim()} onClick={() => void create()}>
          Create
        </button>
      </div>
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}

/** Teammates join with the code shared from Vault settings. */
function JoinVaultItem({ onDone }: { onDone: () => void }) {
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const join = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().joinVault(code);
      setCode("");
      setJoining(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!joining) return (
      <ActionRow
        icon={<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />}
        label="Join with code"
        onClick={() => setJoining(true)}
      />
    );

  return (
    <>
      <div className="menu-create-org">
        <input
          autoFocus
          placeholder="Join code, e.g. K7MPX2RA"
          value={code}
          spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") void join();
            if (e.key === "Escape") {
              e.stopPropagation();
              setJoining(false);
            }
          }}
        />
        <button className="primary sm" disabled={busy} onClick={() => void join()}>
          Join
        </button>
      </div>
      {error && <div className="auth-error">{error}</div>}
    </>
  );
}
