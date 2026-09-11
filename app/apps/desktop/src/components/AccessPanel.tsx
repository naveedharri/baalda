import { useEffect, useMemo, useRef, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import {
  type ResolvedMemberAccess,
  type Share,
  sharePrincipalId,
  sharePrincipalType,
} from "../lib/api";
import type { AccessTreeResponse, TeamAccess } from "../lib/api";
import type { TreeNode } from "../lib/ipc";
import {
  ancestorPaths,
  entriesFromServer,
  entriesFromTree,
  folderChildrenLoaded,
  rowsFromEntries,
  type AccessEntry,
  type AccessRow,
} from "../lib/accessTree";
import {
  MODE_LABEL,
  buildOrgRowsByPath,
  clearedCountPhrase,
  effectiveTeamMode,
  overrideCountPhrase,
  type TeamMode,
} from "../lib/accessMode";
import { readTeamAccessCache, writeTeamAccessCache } from "../lib/teamAccessCache";
import { toast } from "../lib/toast";
import { scrollPaneIntoContainer } from "../lib/scrollPlan";
import { itemLockRows, lockScopesByPath, resourceIdsByPath } from "../lib/locks";
import { syncManager } from "../lib/sync/docSession";
import { useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { Avatar } from "./Avatar";
import { MenuSelect, type MenuSelectOption } from "./MenuSelect";
import { Spinner } from "./Spinner";

/**
 * Access — the unified locker. A whole-vault mode (Shared · Read-only ·
 * Private) plus a per-folder/note setting and a resolved "who can access" list.
 * Built on the shares model:
 *  - Vault mode               = an org grant on the vault (edit=Shared, the
 *    setting a new vault starts with; view=Read-only) or none (Private).
 *    Choosing one ENFORCES it: the server clears every per-item org row first
 *    (see `api.setTeamAccess`), so "the entire vault is Shared" is true of every
 *    folder and note, not just of the ones nobody had overridden.
 *  - "Shared" on an item      = an org edit grant on the folder/file.
 *  - "Read-only" on an item   = an org view grant (Private vault) or an
 *    org `locked` share (Open vault, where a lock caps the edit baseline).
 *  - "Private" on an item     = no team row (only creator + explicit shares).
 *  - Per-member view/edit     = a user-scope lock / edit grant.
 * Folder settings inherit to everything inside (server ACL + lock overlay).
 */

type Mode = TeamMode;
// Per-member states are the two the vault model actually supports on top of
// the Open baseline: "edit" (writable) and "view" (read-only). Because grants
// only ever RAISE permission and a member already has edit under Open, "view"
// must be a per-user LOCK (a cap), not a view grant — a view grant would leave
// the member on edit. "default" clears the override (falls back to Open / the
// folder's inherited setting). "none" is the deny — shown as **Private** — the
// only per-member row that SUBTRACTS, and the only way to keep one person out of
// a folder in a vault everyone else can read. It applies to owners and admins
// too, which is what makes a restriction testable from the seat that set it.
// One row per (resource, user): grant, lock, or deny.
type MemberChoice = "default" | "none" | "view" | "edit";

/** One row in the item list (see `lib/accessTree`). */
type Resource = AccessRow;

const ICON = {
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
  open: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  block: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.9 5.6L19.5 9l-4.4 3.2L16.7 18 12 14.7 7.3 18l1.6-5.8L4.5 9l5.6-1.4z" />
    </svg>
  ),
};

/**
 * The per-member picker's options.
 *
 * Owners are configurable like anyone else — the only row that isn't is *your
 * own*, because a Private on yourself would take the item out of your tree and
 * with it the row you'd need to undo it. Every other rule here is about not
 * promising something the model won't honour.
 */
function memberOptions(everyoneReadonly: boolean): MenuSelectOption<MemberChoice>[] {
  return [
    // Labelled "Inherited", not "Default": this page no longer has a default
    // anywhere — the vault control enforces a mode rather than seeding one —
    // and "Inherited" is already the word `sourceLabel` uses for the same idea.
    { value: "default", label: "Inherited", hint: "Whatever this item's mode gives them" },
    // An Everyone/parent lock already holds everyone at read-only, so offering
    // "can view"/"can edit" would promise something the lock overrides.
    // Private still works — a per-member block outranks a lock.
    ...(everyoneReadonly
      ? []
      : ([
          { value: "view", label: "Can view", hint: "Read-only" },
          { value: "edit", label: "Can edit", hint: "Read & write" },
        ] as MenuSelectOption<MemberChoice>[])),
    { value: "none", label: "Private", hint: "Hidden from this person" },
  ];
}

/** Which paths carry a lock, folded down through folder inheritance. */
function buildLockMap(
  tree: TreeNode | null,
  locks: Share[],
): Map<string, { org: boolean; users: Set<string> }> {
  const idToPath = resourceIdsByPath(tree);
  const direct = new Map<string, { org: boolean; users: Set<string> }>();
  // Item rows only. The whole-vault posture would miss the id lookup below and
  // drop out anyway, but on a coincidence — the org id is in no registry map —
  // and this map answers "which ITEM carries a lock", which the posture never
  // does. The vault's mode reaches the panel through `effectiveTeamMode`.
  for (const l of itemLockRows(locks)) {
    const path = idToPath.get(shareResId(l));
    if (!path) continue;
    const entry = direct.get(path) ?? { org: false, users: new Set<string>() };
    if (sharePrincipalType(l) === "org") entry.org = true;
    else entry.users.add(sharePrincipalId(l));
    direct.set(path, entry);
  }
  // Fold inheritance: a path inherits every ancestor's org flag + locked users.
  const effective = new Map<string, { org: boolean; users: Set<string> }>();
  const allPaths = new Set<string>([...direct.keys()]);
  // Ensure every tree path is considered (so descendants of a locked folder resolve).
  const walk = (n: TreeNode) => {
    allPaths.add(n.path);
    n.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
  for (const path of allPaths) {
    const acc = { org: false, users: new Set<string>() };
    const parts = path.split("/");
    for (let i = parts.length; i > 0; i--) {
      const ancestor = parts.slice(0, i).join("/");
      const d = direct.get(ancestor);
      if (d) {
        if (d.org) acc.org = true;
        d.users.forEach((u) => acc.users.add(u));
      }
    }
    if (acc.org || acc.users.size > 0) effective.set(path, acc);
  }
  return effective;
}

// Local alias — Share resource id accessor (avoids an extra import name clash).
function shareResId(s: Share): string {
  return s.resourceId ?? s.resource_id ?? "";
}

export function AccessPanel({ canManage }: { canManage: boolean }) {
  const session = useStore((s) => s.session);
  const members = useStore((s) => s.members);
  const locks = useStore((s) => s.locks);
  const denies = useStore((s) => s.denies);
  const tree = useStore((s) => s.tree);
  const syncEnabled = useStore((s) => s.syncEnabled);

  /**
   * The item whose access is being edited. Held as the row itself, not just its
   * key, so collapsing a folder doesn't blank the detail pane out from under
   * someone who is halfway through configuring a note inside it.
   */
  const [selected, setSelected] = useState<Resource | null>(null);
  // A "make private" waiting on a yes. Private is the one access change that
  // REMOVES data from teammates' devices (their local copy of the note/folder
  // goes with the access), so it is confirmed rather than applied on click.
  const [confirm, setConfirm] = useState<{
    title: string;
    body: React.ReactNode;
    label: string;
    apply: () => void;
  } | null>(null);
  const selectedKey = selected?.key ?? "";
  /** Folder paths currently open in the list. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Folder paths whose children are being fetched from Rust right now. */
  const [expanding, setExpanding] = useState<Set<string>>(() => new Set());
  /** The vault's full structure, unfiltered by the ACL (owner/admin only). */
  const [serverTree, setServerTree] = useState<AccessTreeResponse | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [access, setAccess] = useState<ResolvedMemberAccess[] | null>(null);
  /**
   * The vault's team access as the server reports it. `null` means **not known
   * yet** — never "Private".
   *
   * That distinction is the whole fix for the load flash: this used to be a
   * `Share[]` starting empty, "no vault grant" reads as Private, and so every
   * open of a Shared vault showed Private — on the cards AND on every row badge
   * — until the request came back. On a slow link that is a second of the panel
   * confidently stating the opposite of the truth.
   */
  const [teamAccess, setTeamAccess] = useState<TeamAccess | null>(null);
  /**
   * The mode this vault had last time, from localStorage. Paints the cards
   * immediately; it can never authorise a WRITE (see `vaultModeKnown`), because
   * the confirm has to count the per-item settings it is about to replace and a
   * remembered mode brings no count with it.
   */
  const [cachedMode, setCachedMode] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The detail pane — scrolled into view when a row is selected. */
  const detailRef = useRef<HTMLDivElement | null>(null);
  /**
   * The per-item mode control. Selecting a row is a move towards *these three
   * buttons*, and the pane's breadcrumb, title and banners can push them a
   * screen below its top, so the scroll is planned to guarantee them.
   */
  const modesRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which load is current. Switching vault with Access open leaves the old
   * vault's requests in flight, and a slow answer for A landing after B's would
   * repaint B's heading with A's mode, A's override count and A's structure —
   * with the control enabled, so the next confirm quotes A and PUTs to B. Same
   * fence `store.refreshLocks` uses.
   */
  const loadGen = useRef(0);

  const orgId = session?.activeOrganizationId ?? null;

  // Vault mode: an org grant on the vault is "Shared" (edit) or "Read-only"
  // (view); no grant is "Private" (members see only what they create or what's
  // explicitly shared with them / the team).
  const reloadVault = async () => {
    const mine = ++loadGen.current;
    if (!canManage || !orgId) {
      setTeamAccess(null);
      setServerTree(null);
      return;
    }
    // The structure listing is what keeps a Private item administrable, so it is
    // re-read after every write: setting something Private removes its file, and
    // the row you would undo that from has to survive it.
    //
    // Both requests go at once: settling the mode and the rows in two steps made
    // the badges change twice on every open.
    const vaultId = syncManager.registry.vaultId;
    const [ta, st] = await Promise.all([
      authManager.api.getTeamAccess(orgId).catch(async (): Promise<TeamAccess | null> => {
        // A server without /team-access still answers the vault's share rows, so
        // the panel can show the truth even though it can't enforce a new mode
        // (the PUT surfaces its own error). No overrides — the confirm falls
        // back to its plain wording rather than inventing a count.
        const rows = await authManager.api.listVaultShares(orgId).catch(() => null);
        if (!rows) return null;
        const grant = rows.find(
          (s) =>
            sharePrincipalType(s) === "org" &&
            (s.permission === "edit" || s.permission === "view"),
        );
        return {
          mode: grant ? (grant.permission === "edit" ? "open" : "readonly") : "private",
          grantId: grant?.id ?? null,
          overrides: [],
        };
      }),
      vaultId
        ? authManager.api
            .listAccessTree(vaultId)
            // Older server, or a caller who can't manage — fall back to the local tree.
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    // Anything after the await belongs to a load that may have been superseded.
    if (mine !== loadGen.current) return;
    setServerTree(st);
    if (!ta) {
      // Both the endpoint AND the legacy fallback failed — offline, a 500, an
      // expired session. Without this the three cards sit disabled and
      // aria-busy forever, looking like a load that is never coming.
      setError(
        "Couldn't load this vault's access settings. Check your connection and reopen Access.",
      );
      return;
    }
    setTeamAccess(ta);
    setCachedMode(ta.mode);
    writeTeamAccessCache(authManager.getServerUrl(), orgId, ta.mode);
  };
  useEffect(() => {
    // Abandon any load still in flight for the vault we just left, even if this
    // one starts nothing of its own.
    loadGen.current++;
    setTeamAccess(null);
    setError(null);
    // A confirm raised for the old vault captured its orgId (and its override
    // count): applying it after a switch would PUT to the new one.
    setConfirm(null);
    setCachedMode(orgId ? readTeamAccessCache(authManager.getServerUrl(), orgId) : null);
    void reloadVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, orgId]);

  /** The vault's mode, or null while it is genuinely unknown. */
  const vaultMode: Mode | null = teamAccess?.mode ?? cachedMode;
  /** Has the server answered? Only then may a mode be written. */
  const vaultModeKnown = teamAccess !== null;

  /**
   * The rows currently on screen: the vault's structure, indented, with a
   * collapsed folder's contents left out.
   *
   * Sourced from the SERVER, not from this machine's disk. An item set to
   * Private leaves the disk, and this panel is where you'd go to change your
   * mind — drawing the list from the disk meant the row you needed disappeared
   * the moment you needed it. The local tree is the fallback while that listing
   * is in flight or if it was refused.
   */
  const entries = useMemo<AccessEntry[]>(
    () =>
      serverTree
        ? entriesFromServer(serverTree)
        : entriesFromTree(tree, {
            folderId: (path) => syncManager.registry.getFolderId(path),
            docId: (path) => syncManager.registry.getMapping(path)?.docId ?? null,
          }),
    [serverTree, tree],
  );
  const resources = useMemo<Resource[]>(
    () => rowsFromEntries(entries, expanded),
    [entries, expanded],
  );

  /**
   * Open/close a folder, pulling its children off disk the first time.
   *
   * `loadChildren` is the same lazy listing the sidebar uses, so expanding here
   * populates the sidebar too — one tree, one cache, no second code path that
   * could show a different vault.
   */
  const toggleFolder = async (path: string, loaded: boolean) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    // The server listing is complete, so nothing has to be fetched to expand.
    // Only the local fallback loads lazily.
    if (serverTree || loaded) return;
    setExpanding((prev) => new Set(prev).add(path));
    try {
      await useStore.getState().loadChildren(path);
    } catch {
      /* a failed listing just leaves the folder looking empty */
    } finally {
      setExpanding((prev) => {
        const s2 = new Set(prev);
        s2.delete(path);
        return s2;
      });
    }
  };

  /**
   * Select a row and bring its controls into view.
   *
   * The master list and the detail pane are stacked, not side by side, so in a
   * vault of any size clicking a row put the thing you came to change below the
   * fold and nothing appeared to happen. The scroll runs after paint (the pane
   * has to exist to be measured), moves only the container that actually
   * scrolls, and is skipped entirely when the pane is already fully visible.
   */
  const selectRow = (r: Resource) => {
    setSelected(r);
    requestAnimationFrame(() => scrollPaneIntoContainer(detailRef.current, modesRef.current));
  };

  /** Reveal a path in the list by opening every folder above it. */
  const revealPath = (path: string) => {
    const above = ancestorPaths(path);
    if (above.length === 0) return;
    setExpanded((prev) => new Set([...prev, ...above]));
  };

  const lockMap = useMemo(() => buildLockMap(tree, locks), [tree, locks]);
  /** Every ORG row in the vault, by path — see `lib/accessMode`. */
  const orgRowsByPath = useMemo(
    () =>
      buildOrgRowsByPath(
        entries,
        resourceIdsByPath(tree),
        teamAccess?.overrides ?? null,
        locks,
        denies,
      ),
    [entries, tree, teamAccess, locks, denies],
  );

  /** This item's team mode — the ONE authority, for badges and the tri-state. */
  const teamModeFor = (path: string): Mode | null =>
    vaultMode
      ? effectiveTeamMode({
          vaultMode,
          path,
          ancestors: ancestorPaths(path),
          orgRowsByPath,
        }).mode
      : null;

  /**
   * Vault-relative paths carrying an ORG deny — an item set to Private.
   *
   * Read from the vault-wide row map rather than the selected resource's own
   * shares, because Private inherits: a note inside a Private folder is private
   * too, and the panel has to be able to say which folder is deciding that.
   */
  const privatePaths = useMemo(() => {
    const out = new Set<string>();
    for (const [path, rows] of orgRowsByPath) {
      if (rows.has("denied")) out.add(path);
    }
    return out;
  }, [orgRowsByPath]);
  /** The nearest ANCESTOR of `path` that is Private, or null. */
  const privateSourcePath = (path: string): string | null => {
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join("/");
      if (privatePaths.has(ancestor)) return ancestor;
    }
    return null;
  };
  /**
   * Locks that sit on an ITEM, by path. The whole-vault Read-only posture is
   * deliberately excluded: the server reports it as a `vault` lock row so the
   * sidebar can badge every folder and note, but here it would answer "this
   * item carries its own lock" for everything and send people to clear a row
   * that decides nothing. The vault posture reaches this panel through
   * `teamModeFor`/`effectiveTeamMode` instead, which is its one authority.
   */
  const directScopes = useMemo(
    // No `lifts` either: they only ever subtract from the vault seed, which is
    // not here to subtract from.
    () => lockScopesByPath(tree, itemLockRows(locks), session?.user.id),
    [tree, locks, session?.user.id],
  );

  const memberByUser = (userId: string) => members.find((m) => m.userId === userId);
  const displayName = (userId: string, fallback?: string | null) => {
    const m = memberByUser(userId);
    return m?.user?.name || m?.user?.email || fallback || userId;
  };

  // (Re)load direct shares + resolved access for the selected resource.
  const reload = async (res: Resource | null) => {
    if (!res || !canManage) {
      setShares([]);
      setAccess(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [sh, ac] = await Promise.all([
        authManager.api.listShares(res.kind, res.id),
        authManager.api.resolveAccess(res.kind, res.id),
      ]);
      setShares(sh);
      setAccess(ac.members);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, canManage]);

  if (!syncEnabled) {
    return (
      <div className="muted perm-empty">
        Access needs sync — sign in and connect this folder to a vault first.
      </div>
    );
  }

  // --- helpers over the selected resource -----------------------------------

  const effLock = lockMap.get(selected?.path ?? "");
  const ownScope = selected ? directScopes.get(selected.path) ?? null : null;
  // Direct org rows on THIS resource: a lock, a read-only (view) grant, or a
  // shared (edit) grant. Plus a lock inherited from a parent folder.
  const ownOrgLock = shares.find((s) => sharePrincipalType(s) === "org" && s.permission === "locked");
  const ownOrgDeny = shares.find((s) => sharePrincipalType(s) === "org" && s.permission === "denied");
  const inheritedOrgLock = !!effLock?.org && !ownOrgLock;
  // Private inherited from a parent folder: the nearest ancestor with an org
  // deny governs this item, exactly as an ancestor lock does.
  const privateSource = selected && !ownOrgDeny ? privateSourcePath(selected.path) : null;
  // The resource's team mode — from the SAME function the row badges use, so
  // the list and the detail pane can never say different things about one item.
  // (They did: the badges ignored per-item edit/view grants entirely.) Private
  // is resolved first inside it because it is the only mode that can override an
  // inherited grant — which is the whole reason it exists: with a Shared vault,
  // clearing an item's own rows left the vault-wide grant reaching it, so
  // Private silently snapped back to Shared.
  // Nullable on purpose: `null` means the vault's mode hasn't arrived, and the
  // copy below has to stay silent rather than assert Private in full sentences
  // and then rewrite itself when the GET lands.
  const generalMode: Mode | null = selected ? teamModeFor(selected.path) : null;
  // When an Everyone/org lock (direct or inherited) already makes the resource
  // read-only for all, a per-member "read-only" lock is redundant and makes
  // Unlock misleading — so the per-person controls are suppressed in favour of
  // the single vault/parent lock.
  // Only ever true on a KNOWN mode: `generalMode` is null until the vault's mode
  // arrives, so this can no longer be decided from a guess.
  const everyoneReadonly = generalMode === "readonly";

  const lockSourcePath = (): string | null => {
    if (!selected) return null;
    const parts = selected.path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join("/");
      if (directScopes.get(ancestor)) return ancestor;
    }
    return null;
  };
  const inheritSource = ownScope ? null : lockSourcePath();
  const inheritSourceRes = inheritSource
    ? resources.find((r) => r.path === inheritSource)
    : null;
  const privateSourceRes = privateSource
    ? (resources.find((r) => r.path === privateSource) ?? null)
    : null;

  // --- writes ---------------------------------------------------------------

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await useStore.getState().refreshLocks();
      await reloadVault();
      if (selected) await reload(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Clear every DIRECT org row on the selected resource — grant, lock, or the
   *  Private deny. One row per (resource, principal), so the new mode's row can
   *  only be written once the old one is gone. */
  const clearResourceOrgRows = async () => {
    if (!selected) return;
    for (const s of shares) {
      if (sharePrincipalType(s) !== "org") continue;
      if (s.permission === "locked") await useStore.getState().removeLock(s.id);
      else await authManager.api.revokeShare(s.id);
    }
  };

  // Per-resource team mode. "Open" = share with the team (edit); "Read-only" =
  // team can view; "Private" = no team access (only creator + explicit shares).
  // Read-only is a lock when the vault is Open (a lock caps the baseline
  // edit at view); a plain org view grant when the vault is Private (there
  // is no baseline edit to cap, and a grant is what GIVES the team read).
  const setGeneral = (mode: Mode) => {
    // `teamAccess` and NOT `vaultMode` (which can come from localStorage):
    // Read-only is a lock in a Shared vault and a view grant in a Private one.
    // Applied from a cache that another admin has since invalidated, this writes
    // a lock into a now-Private vault — a row the server treats as nothing,
    // since a lock caps a permission and never grants one, while the panel
    // badges the folder Read-only. Panel and enforcer disagreeing is the exact
    // failure this whole screen was rebuilt to end.
    if (!selected || !teamAccess || mode === generalMode || inheritedOrgLock || privateSource)
      return;
    if (mode === "private") {
      const what = selected.kind === "folder" ? "folder" : "note";
      setConfirm({
        title: `Make “${selected.name}” private?`,
        label: "Make private",
        apply: () => applyGeneral(mode),
        body: (
          <>
            <p>
              The team loses access to this {what}
              {selected.kind === "folder" ? " and everything inside it" : ""}. It is
              removed from their devices, <strong>including the local copy on disk</strong>.
            </p>
            <p>
              You, the vault's owners and admins, and anyone you have shared it with by
              name keep it. Setting it back to Shared restores access.
            </p>
          </>
        ),
      });
      return;
    }
    applyGeneral(mode);
  };

  const applyGeneral = (mode: Mode) => {
    if (!selected) return;
    void run(async () => {
      await clearResourceOrgRows();
      if (mode === "private") {
        // An explicit org DENY, not merely the absence of a grant. Clearing the
        // rows was the old behaviour and it could not work: in a Shared vault
        // the vault-wide grant still reached the item, so the segment snapped
        // straight back to Shared. The deny removes the team's reach and
        // nothing else — the creator, anyone shared with by name, and
        // owners/admins keep it, which is what "only you and people you share
        // it with" says on the button.
        await authManager.api.createShare({
          resourceType: selected.kind,
          resourceId: selected.id,
          principalType: "org",
          permission: "denied",
        });
      } else if (mode === "open") {
        await authManager.api.createShare({
          resourceType: selected.kind,
          resourceId: selected.id,
          principalType: "org",
          permission: "edit",
        });
      } else if (mode === "readonly") {
        if (teamAccess?.mode === "private") {
          await authManager.api.createShare({
            resourceType: selected.kind,
            resourceId: selected.id,
            principalType: "org",
            permission: "view",
          });
        } else {
          await useStore.getState().createLock(selected.kind, selected.id, null);
        }
      }
    });
  };

  // Whole-vault mode (Shared / Read-only / Private) = the org grant on the vault
  // resource. Private removes it, leaving per-item sharing.
  //
  // It ENFORCES, it does not merely default. The server clears every per-item
  // org row in the same transaction before writing the new grant, because a
  // "default" that stops at the first folder someone overrode is not an answer
  // to "who can reach this vault" — it is a question about thirty other screens.
  // Per-USER rows survive: people shared with by name keep their access.
  //
  // The Read-only grant is a CEILING for everyone, not just a floor for
  // members: the resolver stops taking the owner/admin and note-creator
  // shortcuts when it's set (`vaultBaseline`), so "Everyone can read
  // everything, not edit" includes the person who chose it. It stays a single
  // grant row rather than a grant plus a lock because both would want the same
  // (resource, principal) key.
  const setVaultMode = (mode: Mode) => {
    // `teamAccess` and not `vaultMode`: a mode remembered from localStorage can
    // paint the cards but must never authorise a write, because the confirm
    // below counts the settings it is about to destroy and a cached mode
    // carries no count.
    if (!orgId || !teamAccess) return;
    // Re-choosing the mode that is already active is NOT a no-op when per-item
    // settings exist: this control enforces, and "apply this to everything" is
    // exactly what clicking the active card means. With nothing to clear it is
    // genuinely nothing to do.
    if (mode === teamAccess.mode && teamAccess.overrides.length === 0) return;
    const folders = teamAccess.overrides.filter((o) => o.resourceType === "folder").length;
    const notes = teamAccess.overrides.length - folders;
    const replaced = overrideCountPhrase(folders, notes);
    const privateBody = (
      <>
        <p>
          Members will only see notes they created or that you share with them by
          name. Everything else is removed from their devices,{" "}
          <strong>including the local copies on disk</strong>.
        </p>
        <p>Owners and admins keep the whole vault. You can switch back to Shared at any time.</p>
      </>
    );
    if (mode === "private" || replaced) {
      setConfirm({
        title:
          mode === "private"
            ? "Make this vault private?"
            : `Set the entire vault to ${MODE_LABEL[mode]}?`,
        label: mode === "private" ? "Make vault private" : "Apply to whole vault",
        apply: () => applyVaultMode(mode),
        body: (
          <>
            {replaced && (
              <p>
                Every folder and note in this vault becomes{" "}
                <strong>{MODE_LABEL[mode]}</strong>. This replaces the {replaced} you have
                set — those individual choices are cleared and cannot be brought back except
                by setting them again. People you have shared something with{" "}
                <strong>by name</strong> keep their access.
              </p>
            )}
            {mode === "private" && privateBody}
          </>
        ),
      });
      return;
    }
    applyVaultMode(mode);
  };

  const applyVaultMode = (mode: Mode) => {
    if (!orgId) return;
    void run(async () => {
      const result = await authManager.api.setTeamAccess(orgId, mode);
      // The SERVER's count, not the one the confirm quoted: a teammate can add
      // an override in the seconds between the two, and the number that matters
      // is the number of settings that actually went.
      if (result.cleared > 0) {
        toast(
          `Entire vault set to ${MODE_LABEL[result.mode]} · ${clearedCountPhrase(result.cleared)} cleared`,
        );
      }
    });
  };

  const memberChoice = (userId: string): MemberChoice => {
    // Deny first — it's the row that outranks every other, here as on the server.
    const denied = shares.find(
      (s) =>
        sharePrincipalType(s) === "user" &&
        sharePrincipalId(s) === userId &&
        s.permission === "denied",
    );
    if (denied) return "none";
    // A per-user lock reads back as read-only ("view"); an edit grant as "edit".
    // A legacy view grant also maps to "view" (it will be rewritten as a lock
    // the next time the member is set, so it actually takes effect).
    const lock = shares.find(
      (s) => sharePrincipalType(s) === "user" && sharePrincipalId(s) === userId && s.permission === "locked",
    );
    if (lock) return "view";
    const grant = shares.find(
      (s) =>
        sharePrincipalType(s) === "user" &&
        sharePrincipalId(s) === userId &&
        s.permission !== "locked" &&
        s.permission !== "denied",
    );
    if (grant?.permission === "edit") return "edit";
    if (grant?.permission === "view") return "view";
    return "default";
  };

  const setMember = (userId: string, choice: MemberChoice, who = "this person") => {
    if (!selected) return;
    if (choice === "none") {
      const what = selected.kind === "folder" ? "folder" : "note";
      setConfirm({
        title: `Hide “${selected.name}” from ${who}?`,
        label: "Hide from them",
        apply: () => applyMember(userId, choice),
        body: (
          <>
            <p>
              {who} loses access to this {what}
              {selected.kind === "folder" ? " and everything inside it" : ""}. It is
              removed from their devices, <strong>including the local copy on disk</strong>
              {" "}— even if they created it.
            </p>
            <p>Setting them back to Inherited restores their access.</p>
          </>
        ),
      });
      return;
    }
    applyMember(userId, choice);
  };

  const applyMember = (userId: string, choice: MemberChoice) => {
    if (!selected) return;
    void run(async () => {
      // Clear any existing direct rows for this user on this resource — the
      // unique (resource, principal) key means only one can exist at a time.
      for (const s of shares) {
        if (sharePrincipalType(s) === "user" && sharePrincipalId(s) === userId) {
          // Locks go through the store so the sidebar's badge cache stays in
          // step; grants and denies are plain share rows.
          if (s.permission === "locked") await useStore.getState().removeLock(s.id);
          else await authManager.api.revokeShare(s.id);
        }
      }
      if (choice === "none") {
        // The one subtractive row. It beats the vault's Open grant, an admin's
        // blanket edit, and even "you created this note" — which is the point:
        // "not for Sam" has to mean it on the notes Sam wrote too.
        await authManager.api.createShare({
          resourceType: selected.kind,
          resourceId: selected.id,
          principalId: userId,
          permission: "denied",
        });
      } else if (choice === "edit") {
        await authManager.api.createShare({
          resourceType: selected.kind,
          resourceId: selected.id,
          principalId: userId,
          permission: "edit",
        });
      } else if (choice === "view") {
        // Read-only for this member = a per-user lock (caps at view). A view
        // grant would NOT lower an Open member, so we lock instead.
        await useStore.getState().createLock(selected.kind, selected.id, userId);
      }
    });
  };

  // Claude mirrors the viewing owner/admin's effective access via the MCP token.
  const myAccess = access?.find((m) => m.userId === session?.user.id)?.permission ?? "edit";
  // Per-person controls only apply to members other than the owner (you can't
  // lock yourself out). With just you here there's nothing to configure yet.
  const otherMembers = (access ?? []).filter((m) => m.role !== "owner").length;

  return (
    <div className="access-panel">
      <p className="access-intro">
        Choose what the team can reach. Set the <strong>entire vault</strong> at once, or pick a
        folder or note below to set just that one. Folder settings flow down to everything inside.
        Each is <strong>Shared</strong> (read &amp; write), <strong>Read-only</strong>, or{" "}
        <strong>Private</strong> (nobody until you name them — you included).
      </p>

      {canManage && orgId && (
        <div className="access-ws">
          <div className="access-seclabel">
            Entire vault
            {busy && (
              <span className="access-applying">
                <Spinner size="xs" /> Applying…
              </span>
            )}
          </div>
          <div
            className={`access-seg${busy ? " busy" : ""}`}
            // Busy while the mode is still unknown, too: no card is marked
            // active until the server has said which one is, so the control
            // reads as "loading" rather than as a confident wrong answer.
            aria-busy={busy || !vaultModeKnown}
            aria-disabled={busy || !vaultModeKnown}
          >
            {(["open", "readonly", "private"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`access-segbtn${vaultMode === m ? " active" : ""}`}
                data-mode={m}
                disabled={busy || !vaultModeKnown}
                onClick={() => setVaultMode(m)}
              >
                <span className="access-st-top">
                  {m === "open" ? ICON.open : m === "readonly" ? ICON.lock : ICON.shield}
                  {MODE_LABEL[m]}
                </span>
                <span className="access-st-sub">
                  {m === "open"
                    ? "Every folder and note: the team reads & writes."
                    : m === "readonly"
                      ? "Every folder and note: the team reads, nobody edits."
                      : "Nothing is shared. Members keep only what they create."}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="auth-error">{error}</div>}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.apply();
            setConfirm(null);
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}

      <div className="access-body">
        {/* master list */}
        <div className="access-master">
          <div className="access-listlabel">Your vault</div>
          {resources.length === 0 ? (
            <div className="muted perm-empty">Nothing synced yet.</div>
          ) : (
            <ul className="access-list">
              {resources.map((r) => {
                const lk = lockMap.get(r.path);
                const everyone = !!lk?.org;
                const affected = everyone
                  ? members.map((m) => m.userId)
                  : [...(lk?.users ?? [])];
                const isOpen = expanded.has(r.path);
                // The team mode, from the same function the detail pane's
                // tri-state uses. `null` = the vault's mode hasn't arrived, so
                // the badge stays a neutral placeholder instead of guessing.
                const mode = teamModeFor(r.path);
                // A lock that names only particular people isn't a mode — it's
                // a per-user overlay on one, and it keeps its own word.
                const restricted = !!lk && !everyone && lk.users.size > 0;
                return (
                  // The twisty is a SIBLING of the row button, not a child.
                  // Opening a folder and selecting it are different intents, and
                  // an interactive element nested inside a button is both wrong
                  // for assistive tech and unreachable by keyboard.
                  <li
                    key={r.key}
                    className="access-item"
                    style={{ paddingLeft: `${10 + r.depth * 16}px` }}
                  >
                    {r.kind === "folder" && r.expandable ? (
                      <button
                        type="button"
                        className={`access-twisty${isOpen ? " open" : ""}`}
                        aria-label={isOpen ? `Collapse ${r.name}` : `Expand ${r.name}`}
                        aria-expanded={isOpen}
                        onClick={() => void toggleFolder(r.path, folderChildrenLoaded(tree, r.path))}
                      >
                        {expanding.has(r.path) ? <Spinner size="xs" /> : ICON.chevron}
                      </button>
                    ) : (
                      <span className="access-twisty spacer" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={`access-row${r.key === selectedKey ? " sel" : ""}`}
                      // Keyboard activation (Enter/Space) fires a button's
                      // onClick too, so selecting by keyboard scrolls the pane
                      // into view exactly as a click does. The twisty is a
                      // separate button and doesn't select, so it never scrolls.
                      onClick={() => selectRow(r)}
                    >
                      <span className="access-glyph">{r.kind === "folder" ? ICON.folder : ICON.note}</span>
                      <span className="access-rname">{r.name}</span>
                      <span className="access-rright">
                        {mode !== "private" && !!lk && affected.length > 0 && (
                          <span className="access-avstack" aria-hidden="true">
                            {affected.slice(0, 3).map((uid) => (
                              <span className="access-av-wrap locked" key={uid}>
                                <Avatar label={displayName(uid)} />
                              </span>
                            ))}
                          </span>
                        )}
                        {mode === null ? (
                          <span className="access-badge loading" aria-label="Loading access">
                            <Spinner size="xs" />
                          </span>
                        ) : (
                          <span
                            className={`access-badge ${
                              mode === "private"
                                ? "priv"
                                : restricted || mode === "readonly"
                                  ? "ro"
                                  : "open"
                            }`}
                          >
                            {mode === "private"
                              ? ICON.shield
                              : restricted || mode === "readonly"
                                ? ICON.lock
                                : ICON.open}
                            {mode === "private"
                              ? "Private"
                              : restricted
                                ? "Restricted"
                                : MODE_LABEL[mode]}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* detail */}
        <div className="access-detail" ref={detailRef}>
          {!selected ? (
            <div className="access-empty">
              <span className="access-empty-glyph">{ICON.lock}</span>
              <p>Select a folder or note to see who can reach it — and change it.</p>
            </div>
          ) : (
            <>
              <div className="access-crumb">
                {selected.path.includes("/") && (
                  <span>{selected.path.split("/").slice(0, -1).join(" / ")} ›</span>
                )}
              </div>
              <div className="access-dtitle">
                <span className="access-tglyph">{selected.kind === "folder" ? ICON.folder : ICON.note}</span>
                <h3>{selected.name}</h3>
              </div>

              {inheritSource && (
                <div className="access-banner">
                  <span className="access-bico">{ICON.lock}</span>
                  <span>
                    Access is managed by <strong>{inheritSourceRes?.name ?? inheritSource}</strong> — this{" "}
                    {selected.kind === "folder" ? "folder" : "note"} is read-only.{" "}
                    {inheritSourceRes && (
                      <button
                        className="access-jump"
                        onClick={() => {
                          revealPath(inheritSourceRes.path);
                          selectRow(inheritSourceRes);
                        }}
                      >
                        Open {inheritSourceRes.name} ›
                      </button>
                    )}
                  </span>
                </div>
              )}
              {privateSourceRes && (
                <div className="access-banner">
                  <span className="access-bico">{ICON.shield}</span>
                  <span>
                    <strong>{privateSourceRes.name}</strong> is private, so this{" "}
                    {selected.kind === "folder" ? "folder" : "note"} is too — the team can't
                    reach it.{" "}
                    <button
                      className="access-jump"
                      onClick={() => {
                        revealPath(privateSourceRes.path);
                        selectRow(privateSourceRes);
                      }}
                    >
                      Open {privateSourceRes.name} ›
                    </button>
                  </span>
                </div>
              )}
              {!inheritSource && generalMode === "readonly" && (
                <div className="access-banner">
                  <span className="access-bico">{ICON.lock}</span>
                  <span>
                    <strong>Read-only caps everyone</strong> — vault admins included. Only someone who
                    manages access can lift it.
                  </span>
                </div>
              )}

              <div className="access-seclabel">
                {selected.kind === "folder" ? "Access for this folder & everything inside" : "Access mode"}
                {/* Applying a mode is several round trips (revoke the old rows,
                    write the new one, re-resolve every member) and it kicks live
                    sockets, so it is genuinely slow. Saying so is the difference
                    between "working" and "broken". */}
                {busy && (
                  <span className="access-applying">
                    <Spinner size="xs" /> Applying…
                  </span>
                )}
              </div>
              <div
                ref={modesRef}
                className={`access-seg${busy ? " busy" : ""}`}
                aria-busy={busy || !vaultModeKnown}
                aria-disabled={!canManage || inheritedOrgLock || !vaultModeKnown}
              >
                {(["open", "readonly", "private"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    // No card is active until the vault's mode is known: an
                    // item with no rows of its own resolves to the vault's, so
                    // guessing here is guessing on screen.
                    className={`access-segbtn${generalMode === m ? " active" : ""}`}
                    data-mode={m}
                    // Read-only writes a lock or a view grant depending on the
                    // vault's mode, so it cannot be applied before that is known.
                    disabled={
                      !canManage || inheritedOrgLock || !!privateSource || busy || !vaultModeKnown
                    }
                    onClick={() => setGeneral(m)}
                  >
                    <span className="access-st-top">
                      {m === "open" ? ICON.open : m === "readonly" ? ICON.lock : ICON.shield}
                      {MODE_LABEL[m]}
                    </span>
                    <span className="access-st-sub">
                      {m === "open"
                        ? "The whole team can read & write."
                        : m === "readonly"
                          ? "The team can read, not edit. Claude reads only."
                          : "Nobody reaches it — including you — until you add them below."}
                    </span>
                  </button>
                ))}
              </div>
              {generalMode === "private" && !privateSource && (
                <div className="access-hint">
                  Nobody reaches this {selected.kind === "folder" ? "folder" : "note"}
                  {vaultMode && vaultMode !== "private" && (
                    <> — the vault being <strong>{MODE_LABEL[vaultMode]}</strong> doesn't override it</>
                  )}
                  . Not the team, not vault admins, and not you: add someone below by name to give
                  them access, yourself included.{" "}
                  <strong>Your local files are untouched</strong> — this stops the{" "}
                  {selected.kind === "folder" ? "folder" : "note"} syncing and takes it out of every
                  teammate's vault, but never deletes anything off a disk.
                </div>
              )}

              <div className="access-seclabel">
                Who can access
                {loading && (
                  <span className="access-applying">
                    <Spinner size="xs" /> Resolving…
                  </span>
                )}
              </div>

              {!canManage ? (
                <div className="muted">Only owners and admins can view and manage access.</div>
              ) : (
                <div className="access-people">
                  {/* Claude — derived from the MCP token owner's access. */}
                  <div className="access-prow ai">
                    <span className="access-av-wrap ai">{ICON.spark}</span>
                    <div className="access-pmain">
                      <div className="access-pname">
                        Claude <span className="access-tag ai">AI · MCP</span>
                      </div>
                      <div className="access-prole">acts with your access · Private will blind it</div>
                    </div>
                    <div className="access-plevel">
                      <span className={`access-lv ${claudeCls(myAccess)}`}>{claudeLabel(myAccess)}</span>
                    </div>
                  </div>

                  {(access ?? []).map((m) => {
                    const choice = memberChoice(m.userId);
                    return (
                      <div className="access-prow" key={m.userId}>
                        <span className="access-av-wrap">
                          <Avatar label={m.name || m.email || m.userId} />
                        </span>
                        <div className="access-pmain">
                          <div className="access-pname">
                            {m.name || m.email || m.userId}
                            {m.userId === session?.user.id && <span className="access-you"> (you)</span>}
                          </div>
                          <div className="access-prole">
                            {sourceLabel(m, choice, m.userId === session?.user.id)}
                          </div>
                        </div>
                        {canManage && m.userId !== session?.user.id ? (
                          <MenuSelect
                            value={choice}
                            options={memberOptions(everyoneReadonly)}
                            onSelect={(next) => setMember(m.userId, next, m.name || m.email || "this person")}
                            // The option list depends on `everyoneReadonly`,
                            // which depends on the vault's mode — so no
                            // per-person write until that mode is known either.
                            disabled={busy || !vaultModeKnown}
                            ariaLabel={`Access for ${m.name || m.email || m.userId}`}
                            triggerClassName="access-choice-trigger"
                            menuClassName="access-choice-menu"
                          />
                        ) : (
                          <span className={`access-lv ${levelCls(m.permission)}`}>{levelLabel(m.permission)}</span>
                        )}
                      </div>
                    );
                  })}

                  {otherMembers === 0 && (
                    <p className="access-hint">
                      You're the only member. Invite teammates in <strong>Members</strong>, then
                      each one gets a per-person control here — <strong>Can edit</strong>,{" "}
                      <strong>Can view</strong>, or <strong>Private</strong> — so you can lock this{" "}
                      {selected.kind === "folder" ? "folder" : "note"} for some people while others
                      keep editing.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- small pure helpers ------------------------------------------------------


function levelLabel(p: "edit" | "view" | "none"): string {
  return p === "edit" ? "Full access" : p === "view" ? "Can view" : "No access";
}
function levelCls(p: "edit" | "view" | "none"): string {
  return p === "edit" ? "can" : p === "view" ? "view" : "no";
}
function claudeLabel(p: "edit" | "view" | "none"): string {
  return p === "edit" ? "Reads & edits" : p === "view" ? "Reads · can't edit" : "No access";
}
function claudeCls(p: "edit" | "view" | "none"): string {
  return p === "edit" ? "can" : p === "view" ? "view" : "no";
}

function sourceLabel(m: ResolvedMemberAccess, choice: MemberChoice, isYou = false): string {
  if (choice === "none" || m.denied) {
    return isYou ? "Private · hidden from you too" : "Private · hidden from them";
  }
  if (m.permission === "none") return "No access";
  if (m.capped) return "Read-only · locked";
  if (m.role === "owner") return "Owner · full access";
  if (m.role === "admin") return "Admin · full access";
  if (choice === "edit") return "Shared · can edit";
  if (choice === "view") return "Read-only · locked";
  // default (no direct override): reflect whatever the baseline resolved to.
  return m.permission === "view" ? "Inherited · read-only" : "Inherited · can edit";
}
