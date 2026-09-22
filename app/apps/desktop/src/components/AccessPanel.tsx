import { useEffect, useMemo, useRef, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import type { AccessDefault, AccessTreeResponse, BulkAccessResource, Share, TeamAccess, TeamAccessMode } from "../lib/api";
import {
  accessEntryKey,
  buildBulkAccessInput,
  bulkChangeNeedsConfirmation,
  compactAccessResources,
  selectAllAccessEntries,
  selectedBulkResources,
  toggleAccessSelection,
  vaultAccessKey,
} from "../lib/accessBulk";
import {
  ancestorPaths,
  entriesFromServer,
  entriesFromTree,
  folderChildrenLoaded,
  rowsFromEntries,
  type AccessEntry,
  type AccessRow,
} from "../lib/accessTree";
import { MODE_LABEL, buildOrgRowsByPath, effectiveTeamMode, effectiveVaultMode, type OrgRow } from "../lib/accessMode";
import { readTeamAccessCache, writeTeamAccessCache } from "../lib/teamAccessCache";
import { itemLockRows, resourceIdsByPath } from "../lib/locks";
import { scrollPaneIntoContainer } from "../lib/scrollPlan";
import { createAccessSummaryBatcher } from "../lib/accessSummaryBatch";
import { syncManager } from "../lib/sync/docSession";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { Avatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { iconForPath } from "./FileTree";
import { MenuSelect, type MenuSelectOption } from "./MenuSelect";
import { Spinner } from "./Spinner";

type Mode = TeamAccessMode;
type AudienceType = "org" | "users";
type Resource = AccessRow;
export type CurrentAccessMode = Mode | "mixed" | null;

/**
 * Collapse the effective modes for the selected scopes into the one value the
 * action cards may honestly call current. An empty list means the server state
 * is not authoritative yet; disagreement is surfaced instead of choosing one
 * scope's answer for all of them.
 */
export function currentAccessMode(modes: readonly Mode[]): CurrentAccessMode {
  if (modes.length === 0) return null;
  const first = modes[0];
  return modes.every((mode) => mode === first) ? first : "mixed";
}

/** Compact selected UI rows into the roots the server must resolve. */
export function accessSummaryResources(input: {
  resources: readonly BulkAccessResource[];
  entries: readonly AccessEntry[];
  allItemsSelected: boolean;
  orgId: string;
}): BulkAccessResource[] {
  if (input.allItemsSelected || input.resources.some((resource) => resource.resourceType === "vault")) {
    return [{ resourceType: "vault", resourceId: input.orgId }];
  }
  return compactAccessResources(input.resources, input.entries);
}

export function selectedOrgAccessMode(input: {
  teamAccess: TeamAccess | null;
  serverTreeKnown: boolean;
  vaultSelected: boolean;
  shownVaultMode: Mode | null;
  entries: readonly AccessEntry[];
  selectedKeys: ReadonlySet<string>;
  orgRowsByPath: ReadonlyMap<string, ReadonlySet<OrgRow>>;
}): CurrentAccessMode {
  if (!input.teamAccess) return null;
  if (input.vaultSelected) {
    return input.serverTreeKnown ? input.shownVaultMode : null;
  }
  return currentAccessMode(
    input.entries
      .filter((entry) => input.selectedKeys.has(accessEntryKey(entry)))
      .map((entry) => effectiveTeamMode({
        vaultMode: input.teamAccess!.mode,
        path: entry.path,
        ancestors: ancestorPaths(entry.path),
        orgRowsByPath: input.orgRowsByPath,
      }).mode),
  );
}

export interface AccessSelectionPresentation {
  checked: boolean;
  /** The compact scope that supplies this row's visual selection. */
  inheritedFrom: { key: string; label: string } | null;
}

/**
 * A folder or vault selection already includes its descendants on the server.
 * Reflect that scope in the tree without copying descendant ids into the
 * submitted selection. The nearest selected folder wins the explanation.
 */
export function accessSelectionPresentations(
  entries: readonly AccessEntry[],
  selected: ReadonlySet<string>,
  vaultKey: string,
): Map<string, AccessSelectionPresentation> {
  const selectedFoldersByPath = new Map(
    entries
      .filter((candidate) => candidate.kind === "folder" && selected.has(accessEntryKey(candidate)))
      .map((folder) => [folder.path, folder] as const),
  );
  const vaultSource = vaultKey && selected.has(vaultKey)
    ? { key: vaultKey, label: "Entire vault" }
    : null;

  const presentations = new Map<string, AccessSelectionPresentation>();
  for (const entry of entries) {
    const key = accessEntryKey(entry);
    if (selected.has(key)) {
      presentations.set(key, { checked: true, inheritedFrom: null });
      continue;
    }
    if (vaultSource) {
      presentations.set(key, { checked: true, inheritedFrom: vaultSource });
      continue;
    }

    const inheritedFolder = ancestorPaths(entry.path)
      .reverse()
      .map((path) => selectedFoldersByPath.get(path))
      .find((folder) => folder !== undefined);
    presentations.set(key, inheritedFolder
      ? {
          checked: true,
          inheritedFrom: {
            key: accessEntryKey(inheritedFolder),
            label: inheritedFolder.path.split("/").pop() ?? inheritedFolder.path,
          },
        }
      : { checked: false, inheritedFrom: null });
  }
  return presentations;
}

/** Wait for conditional controls to render, then scroll only their nearest
 * scrollable ancestor. The shared helper keeps an already-visible step still,
 * preserves keyboard focus, and respects reduced-motion preferences. */
function scrollToAccessStepAfterRender(
  target: () => HTMLElement | null,
  anchor: () => HTMLElement | null = () => null,
) {
  window.requestAnimationFrame(() =>
    scrollPaneIntoContainer(target(), anchor(), 20),
  );
}

const MODE_OPTIONS: MenuSelectOption<Mode>[] = [
  { value: "private", label: "Private", hint: "New members see nothing until access is granted" },
  { value: "readonly", label: "Read-only", hint: "New members can read existing content" },
  { value: "open", label: "Shared", hint: "New members can read and edit existing content" },
];

const ICON = {
  folder: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /></svg>
  ),
  vault: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="12" cy="12" r="3" /><path d="M12 9V7M12 17v-2M9 12H7m10 0h-2" /></svg>
  ),
  open: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7.5-4.5-7.5-9V6z" /></svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
  ),
};

function buildLockMap(entries: readonly AccessEntry[], locks: Share[]): Map<string, { org: boolean; users: Set<string> }> {
  const idToPath = new Map(entries.map((entry) => [entry.id, entry.path]));
  const direct = new Map<string, { org: boolean; users: Set<string> }>();
  for (const lock of itemLockRows(locks)) {
    const path = idToPath.get(lock.resourceId ?? lock.resource_id ?? "");
    if (!path) continue;
    const row = direct.get(path) ?? { org: false, users: new Set<string>() };
    if ((lock.principalType ?? lock.principal_type ?? "user") === "org") row.org = true;
    else row.users.add(lock.principalId ?? lock.principal_id ?? "");
    direct.set(path, row);
  }
  const paths = new Set(entries.map((entry) => entry.path));
  const effective = new Map<string, { org: boolean; users: Set<string> }>();
  for (const path of paths) {
    const combined = { org: false, users: new Set<string>() };
    const parts = path.split("/");
    for (let i = parts.length; i > 0; i--) {
      const row = direct.get(parts.slice(0, i).join("/"));
      if (!row) continue;
      combined.org ||= row.org;
      row.users.forEach((userId) => combined.users.add(userId));
    }
    if (combined.org || combined.users.size > 0) effective.set(path, combined);
  }
  return effective;
}

/** People are usually ticked in quick succession; resolve once they settle
 *  instead of once per click. */
export const PEOPLE_SETTLE_MS = 300;

function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function AccessPanel({ canManage }: { canManage: boolean }) {
  const session = useStore((state) => state.session);
  const members = useStore((state) => state.members);
  const locks = useStore((state) => state.locks);
  const denies = useStore((state) => state.denies);
  const tree = useStore((state) => state.tree);
  const syncEnabled = useStore((state) => state.syncEnabled);
  const orgId = session?.activeOrganizationId ?? null;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expanding, setExpanding] = useState<Set<string>>(() => new Set());
  const [serverTree, setServerTree] = useState<AccessTreeResponse | null>(null);
  const [teamAccess, setTeamAccess] = useState<TeamAccess | null>(null);
  const [cachedMode, setCachedMode] = useState<Mode | null>(null);
  const [accessDefault, setAccessDefaultState] = useState<AccessDefault | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [audienceType, setAudienceType] = useState<AudienceType>("org");
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(() => new Set());
  const [peopleCurrentMode, setPeopleCurrentMode] = useState<CurrentAccessMode>(null);
  const [peopleAccessState, setPeopleAccessState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  const [busy, setBusy] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    label: string;
    tone: "danger" | "accent";
    body: React.ReactNode;
    apply: () => Promise<void>;
  } | null>(null);
  const loadGen = useRef(0);
  const scopeGen = useRef(0);
  const mutationBusy = useRef(false);
  const peopleLoadGen = useRef(0);
  const resourcesRef = useRef<HTMLDivElement | null>(null);
  const bulkRef = useRef<HTMLElement | null>(null);
  const memberPickerRef = useRef<HTMLDivElement | null>(null);
  const accessChoicesRef = useRef<HTMLDivElement | null>(null);

  const reloadVault = async (includeTree = true) => {
    const mine = ++loadGen.current;
    if (!canManage || !orgId) {
      setTeamAccess(null);
      setAccessDefaultState(null);
      setServerTree(null);
      return;
    }
    const vaultId = syncManager.registry.vaultId;
    const [team, structure, joining] = await Promise.all([
      authManager.api.getTeamAccess(orgId).catch(() => null),
      includeTree && vaultId ? authManager.api.listAccessTree(vaultId).catch(() => null) : Promise.resolve(null),
      authManager.api.getAccessDefault(orgId).catch(() => null),
    ]);
    if (mine !== loadGen.current) return;
    if (includeTree) setServerTree(structure);
    setAccessDefaultState(joining);
    if (team) {
      setTeamAccess(team);
      setCachedMode(team.mode);
      writeTeamAccessCache(authManager.getServerUrl(), orgId, team.mode);
    }
    if (!team || !joining) setError("Couldn't load all access settings. Check your connection and reopen Access.");
  };

  useEffect(() => {
    loadGen.current++;
    setError(null);
    setTeamAccess(null);
    setAccessDefaultState(null);
    setServerTree(null);
    setSelectedKeys(new Set());
    setSelectedUsers(new Set());
    setPeopleCurrentMode(null);
    setPeopleAccessState("idle");
    setAudienceType("org");
    setConfirm(null);
    setBusy(false);
    setDefaultBusy(false);
    mutationBusy.current = false;
    setCachedMode(orgId ? readTeamAccessCache(authManager.getServerUrl(), orgId) : null);
    void reloadVault();
    return () => { loadGen.current++; peopleLoadGen.current++; scopeGen.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, orgId]);

  // Once the server structure is known, local download/removal batches must
  // not rebuild it or invalidate the people-summary request dependencies.
  const localTree = serverTree ? null : tree;
  const entries = useMemo<AccessEntry[]>(
    () => serverTree
      ? entriesFromServer(serverTree)
      : entriesFromTree(localTree, {
          folderId: (path) => syncManager.registry.getFolderId(path),
          docId: (path) => syncManager.registry.getMapping(path)?.docId ?? null,
          fileId: (path) => syncManager.registry.getFileId(path),
        }),
    [serverTree, localTree],
  );
  const resources = useMemo(() => rowsFromEntries(entries, expanded), [entries, expanded]);
  const selectedResources = useMemo(
    () => (orgId ? selectedBulkResources(selectedKeys, entries, orgId) : []),
    [selectedKeys, entries, orgId],
  );
  const selectedEntryNames = useMemo(
    () => entries.filter((entry) => selectedKeys.has(accessEntryKey(entry))).map((entry) => entry.path.split("/").pop() ?? entry.path),
    [entries, selectedKeys],
  );
  const selectedUserIds = [...selectedUsers];
  const viewedUsersNow = audienceType === "users" ? JSON.stringify([...selectedUsers].sort()) : "[]";
  const viewedUsers = useSettled(viewedUsersNow, PEOPLE_SETTLE_MS);
  const peopleSettled = viewedUsers === viewedUsersNow;
  const viewOptions: MenuSelectOption<string>[] = [
    { value: "everyone", label: "Everyone" },
    ...members.map((member) => ({
      value: `user:${member.userId}`,
      label: member.user?.name || member.user?.email || member.userId,
      hint: member.user?.name ? member.user?.email : undefined,
    })),
    ...(audienceType === "users" && selectedUsers.size !== 1
      ? [{ value: "selected", label: selectedUsers.size ? `${selectedUsers.size} selected people` : "Choose people" }]
      : []),
  ];
  const vaultKey = orgId ? vaultAccessKey(orgId) : "";
  const vaultSelected = !!vaultKey && selectedKeys.has(vaultKey);
  const selectionPresentations = useMemo(
    () => accessSelectionPresentations(entries, selectedKeys, vaultKey),
    [entries, selectedKeys, vaultKey],
  );
  const allItemsSelected = entries.length > 0 && entries.every(
    (entry) => selectionPresentations.get(accessEntryKey(entry))?.checked,
  );

  const vaultMode = teamAccess?.mode ?? cachedMode;
  const orgRowsByPath = useMemo(
    () => buildOrgRowsByPath(entries, resourceIdsByPath(localTree), teamAccess?.overrides ?? null, locks, denies),
    [entries, localTree, teamAccess, locks, denies],
  );
  const rootPaths = useMemo(
    () => (serverTree ? entries.map((entry) => entry.path).filter((path) => !path.includes("/")) : []),
    [serverTree, entries],
  );
  const vaultEffective = useMemo(
    () => (vaultMode ? effectiveVaultMode({ vaultMode, rootPaths, orgRowsByPath }) : null),
    [vaultMode, rootPaths, orgRowsByPath],
  );
  const shownVaultMode = vaultEffective?.mode ?? vaultMode;
  const lockMap = useMemo(() => buildLockMap(entries, locks), [entries, locks]);
  const teamModeFor = (path: string): Mode | null => vaultMode
    ? effectiveTeamMode({ vaultMode, path, ancestors: ancestorPaths(path), orgRowsByPath }).mode
    : null;
  const orgCurrentMode = useMemo<CurrentAccessMode>(() => {
    // `cachedMode` is good enough to prevent badge flicker, but it cannot prove
    // the current selection: item overrides may have changed since it was
    // written. Likewise, per-person edit/view rows are not part of TeamAccess,
    // so the Specific people view must stay unresolved rather than borrowing
    // Everyone's answer.
    return selectedOrgAccessMode({
      teamAccess,
      serverTreeKnown: serverTree !== null,
      vaultSelected,
      shownVaultMode: shownVaultMode ?? null,
      entries,
      selectedKeys,
      orgRowsByPath,
    });
  }, [teamAccess, vaultSelected, serverTree, shownVaultMode, entries, selectedKeys, orgRowsByPath]);
  const peopleTargets = useMemo<BulkAccessResource[]>(
    () => orgId ? accessSummaryResources({
      resources: selectedResources,
      entries,
      allItemsSelected,
      orgId,
    }) : [],
    [selectedResources, entries, allItemsSelected, orgId],
  );

  useEffect(() => {
    const mine = ++peopleLoadGen.current;
    const userIds = JSON.parse(viewedUsers) as string[];
    if (audienceType !== "users" || userIds.length === 0 || selectedResources.length === 0) {
      setPeopleCurrentMode(null);
      setPeopleAccessState("idle");
      return;
    }
    if (peopleTargets.length === 0) {
      setPeopleCurrentMode(null);
      setPeopleAccessState("unavailable");
      return;
    }
    setPeopleCurrentMode(null);
    setPeopleAccessState("loading");
    void authManager.api.resolveAccessSummary(orgId!, peopleTargets, userIds).then((summary) => {
      if (mine !== peopleLoadGen.current) return;
      setPeopleCurrentMode(summary.mode);
      setPeopleAccessState("ready");
    }).catch(() => {
      if (mine !== peopleLoadGen.current) return;
      setPeopleCurrentMode(null);
      setPeopleAccessState("unavailable");
    });
  }, [audienceType, viewedUsers, selectedResources.length, peopleTargets, teamAccess]);

  const selectedCurrentMode = audienceType === "org" ? orgCurrentMode : peopleSettled ? peopleCurrentMode : null;
  const currentAccessMessage = audienceType === "users"
    ? selectedUsers.size === 0
      ? "Select a person to view their access."
      : peopleAccessState === "loading" || !peopleSettled
        ? "Loading current access…"
        : peopleAccessState === "unavailable"
          ? "Current access is unavailable."
          : selectedCurrentMode === "mixed"
            ? "Selected people or items currently have mixed access."
            : null
    : selectedCurrentMode === "mixed"
      ? "Selected items currently have mixed access."
      : null;

  const toggleFolder = async (path: string, loaded: boolean) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    if (serverTree || loaded) return;
    setExpanding((current) => new Set(current).add(path));
    try {
      await useStore.getState().loadChildren(path);
    } finally {
      setExpanding((current) => {
        const settled = new Set(current);
        settled.delete(path);
        return settled;
      });
    }
  };

  const toggleResource = (key: string) => {
    if (!canManage || !vaultKey) return;
    const next = toggleAccessSelection(selectedKeys, key, vaultKey);
    setSelectedKeys(next);
    if (selectedBulkResources(next, entries, orgId ?? "").length > 0) {
      scrollToAccessStepAfterRender(() => bulkRef.current, () => accessChoicesRef.current);
    }
  };

  const selectEveryResource = () => {
    const next = allItemsSelected ? new Set<string>() : selectAllAccessEntries(entries);
    setSelectedKeys(next);
    if (next.size > 0) {
      scrollToAccessStepAfterRender(() => bulkRef.current, () => accessChoicesRef.current);
    }
  };

  const selectAudience = (audience: AudienceType) => {
    setAudienceType(audience);
    scrollToAccessStepAfterRender(() => audience === "users" ? memberPickerRef.current : accessChoicesRef.current);
  };

  const toggleMember = (userId: string) => {
    const next = new Set(selectedUsers);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setSelectedUsers(next);
    if (next.size > 0) scrollToAccessStepAfterRender(() => accessChoicesRef.current);
  };

  const setJoiningDefault = async (mode: Mode) => {
    if (!orgId || defaultBusy || accessDefault?.mode === mode) return;
    scrollToAccessStepAfterRender(() => resourcesRef.current);
    setDefaultBusy(true);
    setError(null);
    const scope = scopeGen.current;
    try {
      const next = await authManager.api.setAccessDefault(orgId, mode);
      if (scope !== scopeGen.current) return;
      setAccessDefaultState(next);
      toast(`New-member access set to ${MODE_LABEL[next.mode]}`);
    } catch (cause) {
      if (scope !== scopeGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (scope === scopeGen.current) setDefaultBusy(false);
    }
  };

  const applyBulk = async (mode: Mode) => {
    if (!orgId || selectedResources.length === 0 || mutationBusy.current) return;
    if (audienceType === "users" && selectedUserIds.length === 0) return;
    mutationBusy.current = true;
    setBusy(true);
    setError(null);
    const scope = scopeGen.current;
    try {
      const result = await authManager.api.setBulkAccess(
        orgId,
        buildBulkAccessInput({ resources: compactAccessResources(selectedResources, entries), audienceType, userIds: selectedUserIds, mode }),
      );
      if (scope !== scopeGen.current) return;
      // Permission writes do not change the structure. Refresh the two access
      // views together instead of re-downloading and re-sorting the whole vault.
      await Promise.all([useStore.getState().refreshLocks(), reloadVault(false)]);
      if (scope !== scopeGen.current) return;
      toast(`${MODE_LABEL[result.mode]} applied to ${result.resourcesChanged} ${result.resourcesChanged === 1 ? "resource" : "resources"}${result.overridesCleared > 0 ? ` · ${result.overridesCleared} custom settings replaced` : ""}`);
    } catch (cause) {
      if (scope !== scopeGen.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (scope === scopeGen.current) {
        mutationBusy.current = false;
        setBusy(false);
      }
    }
  };

  const requestBulk = (mode: Mode) => {
    if (selectedResources.length === 0) return;
    if (audienceType === "users" && selectedUserIds.length === 0) {
      setError("Choose at least one person.");
      return;
    }
    if (!bulkChangeNeedsConfirmation({ resources: selectedResources, audienceType, mode })) {
      void applyBulk(mode);
      return;
    }
    const scope = vaultSelected
      ? "the entire vault"
      : selectedResources.length === 1
        ? `“${selectedEntryNames[0] ?? "this item"}”`
        : `${selectedResources.length} selected items`;
    const people = audienceType === "org"
      ? "Everyone in the vault"
      : `${selectedUserIds.length} selected ${selectedUserIds.length === 1 ? "person" : "people"}`;
    setConfirm({
      title: `Set ${scope} to ${MODE_LABEL[mode]}?`,
      label: `Set ${MODE_LABEL[mode]}`,
      tone: mode === "private" ? "danger" : "accent",
      apply: () => applyBulk(mode),
      body: (
        <>
          <p><strong>{people}</strong> will receive {MODE_LABEL[mode]} access to {scope}. Selected folders include everything currently inside them.</p>
          {audienceType === "org" ? (
            <p>This replaces every team and per-person exception in the selected scope. Access for people who join later is still controlled by <strong>Access by default</strong>.</p>
          ) : (
            <p>Only the selected people's custom settings are replaced inside this scope. Everyone else's access stays unchanged.</p>
          )}
          {mode === "private" && <p>Content they can no longer read is removed from their devices on the next sync. The server copy is kept and can be restored by granting access again.</p>}
        </>
      ),
    });
  };

  if (!syncEnabled) return <div className="muted perm-empty">Access needs sync — connect this folder to a vault first.</div>;

  const selectionLabel = vaultSelected
    ? "Entire vault selected"
    : `${selectedResources.length} ${selectedResources.length === 1 ? "item" : "items"} selected`;

  return (
    <div className="access-panel">
      <p className="access-intro">
        Choose a person to see their access. Select files or folders to change it.
        Folder changes include everything inside them.
      </p>

      {error && <div className="auth-error">{error}</div>}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.label}
          tone={confirm.tone}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await confirm.apply();
            setConfirm(null);
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}

      {canManage && orgId ? (
        <section className="access-default-card">
          <div className="access-default-copy">
            <strong>Access by default</strong>
            <span>What new members see when they join. This applies only to future members; existing access stays unchanged, and the vault creator keeps management access.</span>
          </div>
          {accessDefault ? (
            <MenuSelect
              value={accessDefault.mode}
              options={MODE_OPTIONS}
              onSelect={setJoiningDefault}
              disabled={defaultBusy}
              ariaLabel="Access for future members"
              triggerClassName="access-default-trigger"
              menuClassName="access-choice-menu"
            />
          ) : (
            <span className="access-default-loading"><Spinner size="xs" /> Loading…</span>
          )}
        </section>
      ) : (
        <div className="muted">Only owners and admins can update access settings.</div>
      )}

      <div className="access-master" ref={resourcesRef}>
        {canManage && (
          <div className="access-view-toolbar">
            <span>View access for</span>
            <MenuSelect
              value={audienceType === "org" ? "everyone" : selectedUsers.size === 1 ? `user:${selectedUserIds[0]}` : "selected"}
              options={viewOptions}
              ariaLabel="View access for"
              triggerClassName="access-default-trigger"
              menuClassName="access-choice-menu"
              disabled={busy}
              onSelect={(value) => {
                if (value === "selected") return;
                setAudienceType(value === "everyone" ? "org" : "users");
                setSelectedUsers(value === "everyone" ? new Set() : new Set([value.slice(5)]));
              }}
            />
          </div>
        )}
        <div className="access-listhead">
          <div><div className="access-listlabel">Folders &amp; files</div>{canManage && <span>{selectionLabel}</span>}</div>
          {canManage && entries.length > 0 && (
            <button
              type="button"
              className="access-select-all"
              disabled={busy}
              onClick={selectEveryResource}
            >
              {allItemsSelected ? "Clear selection" : "Select all items"}
            </button>
          )}
        </div>

        {orgId && (
          <label className={`access-row access-vault-row${vaultSelected ? " sel" : ""}`}>
            <input className="access-check" type="checkbox" checked={vaultSelected} disabled={!canManage || busy} onChange={() => toggleResource(vaultKey)} />
            <span className="access-glyph">{ICON.vault}</span>
            <span className="access-rname">Entire vault</span>
            <span className="access-rright">{audienceType === "users"
              ? <PersonAccessBadge orgId={orgId} resourceType="vault" resourceId={orgId} users={viewedUsers} revision={teamAccess} />
              : shownVaultMode ? <AccessBadge mode={shownVaultMode} /> : <LoadingBadge />}</span>
          </label>
        )}

        {resources.length === 0 ? (
          <div className="muted perm-empty">Nothing synced yet.</div>
        ) : (
          <ul className="access-list">
            {resources.map((resource) => {
              const key = accessEntryKey(resource);
              const selection = selectionPresentations.get(key) ?? { checked: false, inheritedFrom: null };
              const selected = selection.checked;
              const inheritedSelection = selection.inheritedFrom;
              const mode = teamModeFor(resource.path);
              const itemLock = lockMap.get(resource.path);
              // Per-person read-only caps are exceptions to the team's mode, not
              // the team's mode: Everyone still sees the team badge, plus a note
              // of who is held back.
              const personalLocks = itemLock && !itemLock.org ? [...itemLock.users] : [];
              const open = expanded.has(resource.path);
              return (
                <li key={resource.key} className="access-item" style={{ paddingLeft: `${10 + resource.depth * 16}px` }}>
                  {resource.kind === "folder" && resource.expandable ? (
                    <button
                      type="button"
                      className={`access-twisty${open ? " open" : ""}`}
                      aria-label={open ? `Collapse ${resource.name}` : `Expand ${resource.name}`}
                      aria-expanded={open}
                      onClick={() => void toggleFolder(resource.path, folderChildrenLoaded(tree, resource.path))}
                    >
                      {expanding.has(resource.path) ? <Spinner size="xs" /> : ICON.chevron}
                    </button>
                  ) : <span className="access-twisty spacer" aria-hidden="true" />}
                  <label
                    className={`access-row${selected ? " sel" : ""}${inheritedSelection ? " inherited" : ""}`}
                    title={inheritedSelection
                      ? `Selected through ${inheritedSelection.label}; change the ${inheritedSelection.label} selection to adjust this item.`
                      : undefined}
                  >
                    <input
                      className="access-check"
                      type="checkbox"
                      checked={selected}
                      disabled={!canManage || busy || !!inheritedSelection}
                      aria-label={inheritedSelection
                        ? `${resource.name}, selected through ${inheritedSelection.label}. Change the ${inheritedSelection.label} selection to adjust this item.`
                        : resource.name}
                      onChange={() => toggleResource(key)}
                    />
                    <span className="access-glyph">{rowGlyph(resource)}</span>
                    <span className="access-rname">{resource.name}</span>
                    {inheritedSelection && (
                      <span className="access-selection-source" aria-hidden="true">
                        Selected through {inheritedSelection.label}
                      </span>
                    )}
                    <span className="access-rright">{audienceType === "users" && orgId
                      ? <PersonAccessBadge orgId={orgId} resourceType={resource.kind === "folder" ? "folder" : "file"} resourceId={resource.id} users={viewedUsers} revision={teamAccess} />
                      : mode ? <>
                          {personalLocks.length > 0 && <PersonalExceptions userIds={personalLocks} members={members} />}
                          <AccessBadge mode={mode} />
                        </> : <LoadingBadge />}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canManage && selectedResources.length > 0 && (
        <section className="access-bulk-card" aria-busy={busy} ref={bulkRef}>
          <div className="access-bulk-heading">
            <div><div className="access-seclabel">Set access</div><strong>{selectionLabel}</strong></div>
            {busy && <span className="access-applying"><Spinner size="xs" /> Applying…</span>}
          </div>

          <div className="access-audience-tabs" role="group" aria-label="Who this change applies to">
            <button type="button" className={audienceType === "org" ? "active" : ""} onClick={() => selectAudience("org")} disabled={busy}>Everyone</button>
            <button type="button" className={audienceType === "users" ? "active" : ""} onClick={() => selectAudience("users")} disabled={busy}>Specific people</button>
          </div>

          {audienceType === "org" ? (
            <p className="access-bulk-note">Replaces all team and individual exceptions in the selected scope. Folder changes replace custom permissions throughout the folder.</p>
          ) : (
            <>
              <p className="access-bulk-note">Changes only the people you choose. Everyone else's access stays unchanged.</p>
              <div className="access-member-grid" ref={memberPickerRef}>
                {members.map((member) => {
                  const checked = selectedUsers.has(member.userId);
                  const label = member.user?.name || member.user?.email || member.userId;
                  return (
                    <label className={`access-member-choice${checked ? " selected" : ""}`} key={member.userId}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggleMember(member.userId)}
                      />
                      <Avatar label={label} />
                      <span>{label}{member.userId === session?.user.id ? " (you)" : ""}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          <AccessModeChoices
            currentMode={selectedCurrentMode}
            busy={busy}
            disabled={audienceType === "users" && selectedUsers.size === 0}
            containerRef={accessChoicesRef}
            statusMessage={currentAccessMessage}
            onSelect={requestBulk}
          />
        </section>
      )}
    </div>
  );
}

export function AccessModeChoices({
  currentMode,
  busy,
  disabled,
  containerRef,
  statusMessage,
  onSelect,
}: {
  currentMode: CurrentAccessMode;
  busy: boolean;
  disabled: boolean;
  containerRef?: React.Ref<HTMLDivElement>;
  statusMessage?: string | null;
  onSelect: (mode: Mode) => void;
}) {
  return (
    <>
      <div className={`access-seg${busy ? " busy" : ""}`} ref={containerRef}>
        {(["open", "readonly", "private"] as Mode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`access-segbtn${currentMode === mode ? " active" : ""}`}
            data-mode={mode}
            aria-pressed={currentMode === mode}
            disabled={busy || disabled}
            onClick={() => onSelect(mode)}
          >
            <span className="access-st-top">{mode === "open" ? ICON.open : mode === "readonly" ? ICON.lock : ICON.shield}{MODE_LABEL[mode]}</span>
            <span className="access-st-sub">{mode === "open" ? "Can read and edit" : mode === "readonly" ? "Can read, cannot edit" : "Cannot see this content"}</span>
          </button>
        ))}
      </div>
      {statusMessage && (
        <p className="access-current-state" role="status">{statusMessage}</p>
      )}
    </>
  );
}

function rowGlyph(resource: Resource): React.ReactNode {
  if (resource.kind === "folder") return ICON.folder;
  return resource.kind === "file" ? iconForPath(resource.path) : ICON.note;
}

function AccessBadge({ mode }: { mode: Mode }) {
  return (
    <span className={`access-badge ${mode === "private" ? "priv" : mode === "readonly" ? "ro" : "open"}`}>
      {mode === "private" ? ICON.shield : mode === "readonly" ? ICON.lock : ICON.open}
      {MODE_LABEL[mode]}
    </span>
  );
}

function PersonalExceptions({ userIds, members }: {
  userIds: string[];
  members: ReturnType<typeof useStore.getState>["members"];
}) {
  const names = userIds.map((id) => {
    const member = members.find((candidate) => candidate.userId === id);
    return member?.user?.name || member?.user?.email || "a former member";
  });
  const label = names.length === 1 ? `Read-only for ${names[0]}` : `Read-only for ${names.length} people`;
  return <span className="access-selection-source" title={`Read-only for ${names.join(", ")}`}>{label}</span>;
}

function LoadingBadge() {
  return <span className="access-badge loading" aria-label="Loading access"><Spinner size="xs" /></span>;
}

// Resolve only rows near the viewport. Rows that mount together share one
// request; the server resolves each with its full resolver.
const accessSummaries = createAccessSummaryBatcher({
  many: (orgId, groups, userIds) => authManager.api.resolveAccessSummaries(orgId, groups, userIds),
  one: async (orgId, resources, userIds) => (await authManager.api.resolveAccessSummary(orgId, resources, userIds)).mode,
});

function PersonAccessBadge({ orgId, resourceType, resourceId, users, revision }: {
  orgId: string;
  resourceType: BulkAccessResource["resourceType"];
  resourceId: string;
  users: string;
  revision: TeamAccess | null;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const scope = JSON.stringify([orgId, resourceType, resourceId, users]);
  const [result, setResult] = useState<{
    scope: string;
    revision: TeamAccess | null;
    mode: Mode | "mixed" | "unavailable";
  } | null>(null);
  useEffect(() => {
    const userIds = JSON.parse(users) as string[];
    if (!userIds.length) return;
    let cancelled = false;
    let started = false;
    const start = () => {
      if (started || cancelled) return;
      started = true;
      accessSummaries.read(orgId, { resourceType, resourceId }, userIds, () => cancelled).then(
        (mode) => { if (!cancelled) setResult({ scope, revision, mode }); },
        () => { if (!cancelled) setResult({ scope, revision, mode: "unavailable" }); },
      );
    };
    const observer = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((observations) => {
          if (observations.some((entry) => entry.isIntersecting)) {
            start();
            observer?.disconnect();
          }
        }, { rootMargin: "200px" })
      : null;
    if (observer && anchor.current) observer.observe(anchor.current);
    else start();
    return () => { cancelled = true; observer?.disconnect(); };
  }, [orgId, resourceType, resourceId, users, revision, scope]);
  const mode = result?.scope === scope && result.revision === revision ? result.mode : null;
  return (
    <span ref={anchor} aria-live="polite">
      {users === "[]" ? <span className="access-badge">Choose a person</span>
        : mode === "mixed" ? <span className="access-badge ro" title="Access differs between people or items in this folder">Mixed</span>
          : mode === "unavailable" ? <span className="access-badge" title="Could not load this person's access">Unavailable</span>
            : mode ? <AccessBadge mode={mode} /> : <LoadingBadge />}
    </span>
  );
}
