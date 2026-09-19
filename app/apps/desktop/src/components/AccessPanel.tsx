import { useEffect, useMemo, useRef, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import type { AccessDefault, AccessTreeResponse, Share, TeamAccess, TeamAccessMode } from "../lib/api";
import type { TreeNode } from "../lib/ipc";
import {
  accessEntryKey,
  buildBulkAccessInput,
  bulkChangeNeedsConfirmation,
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
import { MODE_LABEL, buildOrgRowsByPath, effectiveTeamMode, effectiveVaultMode } from "../lib/accessMode";
import { readTeamAccessCache, writeTeamAccessCache } from "../lib/teamAccessCache";
import { itemLockRows, resourceIdsByPath } from "../lib/locks";
import { scrollPaneIntoContainer } from "../lib/scrollPlan";
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

function buildLockMap(tree: TreeNode | null, locks: Share[]): Map<string, { org: boolean; users: Set<string> }> {
  const idToPath = resourceIdsByPath(tree);
  const direct = new Map<string, { org: boolean; users: Set<string> }>();
  for (const lock of itemLockRows(locks)) {
    const path = idToPath.get(lock.resourceId ?? lock.resource_id ?? "");
    if (!path) continue;
    const row = direct.get(path) ?? { org: false, users: new Set<string>() };
    if ((lock.principalType ?? lock.principal_type ?? "user") === "org") row.org = true;
    else row.users.add(lock.principalId ?? lock.principal_id ?? "");
    direct.set(path, row);
  }
  const paths = new Set<string>(direct.keys());
  const walk = (node: TreeNode) => {
    paths.add(node.path);
    node.children?.forEach(walk);
  };
  tree?.children?.forEach(walk);
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
  const resourcesRef = useRef<HTMLDivElement | null>(null);
  const bulkRef = useRef<HTMLElement | null>(null);
  const memberPickerRef = useRef<HTMLDivElement | null>(null);
  const accessChoicesRef = useRef<HTMLDivElement | null>(null);

  const reloadVault = async () => {
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
      vaultId ? authManager.api.listAccessTree(vaultId).catch(() => null) : Promise.resolve(null),
      authManager.api.getAccessDefault(orgId).catch(() => null),
    ]);
    if (mine !== loadGen.current) return;
    setServerTree(structure);
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
    setAudienceType("org");
    setConfirm(null);
    setCachedMode(orgId ? readTeamAccessCache(authManager.getServerUrl(), orgId) : null);
    void reloadVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, orgId]);

  const entries = useMemo<AccessEntry[]>(
    () => serverTree
      ? entriesFromServer(serverTree)
      : entriesFromTree(tree, {
          folderId: (path) => syncManager.registry.getFolderId(path),
          docId: (path) => syncManager.registry.getMapping(path)?.docId ?? null,
          fileId: (path) => syncManager.registry.getFileId(path),
        }),
    [serverTree, tree],
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
  const allItemsSelected = entries.length > 0 && entries.every((entry) => selectedKeys.has(accessEntryKey(entry)));
  const vaultKey = orgId ? vaultAccessKey(orgId) : "";
  const vaultSelected = !!vaultKey && selectedKeys.has(vaultKey);

  const vaultMode = teamAccess?.mode ?? cachedMode;
  const orgRowsByPath = useMemo(
    () => buildOrgRowsByPath(entries, resourceIdsByPath(tree), teamAccess?.overrides ?? null, locks, denies),
    [entries, tree, teamAccess, locks, denies],
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
  const lockMap = useMemo(() => buildLockMap(tree, locks), [tree, locks]);
  const teamModeFor = (path: string): Mode | null => vaultMode
    ? effectiveTeamMode({ vaultMode, path, ancestors: ancestorPaths(path), orgRowsByPath }).mode
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
    try {
      const next = await authManager.api.setAccessDefault(orgId, mode);
      setAccessDefaultState(next);
      toast(`New-member access set to ${MODE_LABEL[next.mode]}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDefaultBusy(false);
    }
  };

  const applyBulk = async (mode: Mode) => {
    if (!orgId || selectedResources.length === 0) return;
    if (audienceType === "users" && selectedUserIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authManager.api.setBulkAccess(
        orgId,
        buildBulkAccessInput({ resources: selectedResources, audienceType, userIds: selectedUserIds, mode }),
      );
      await useStore.getState().refreshLocks();
      await reloadVault();
      toast(`${MODE_LABEL[result.mode]} applied to ${result.resourcesChanged} ${result.resourcesChanged === 1 ? "resource" : "resources"}${result.overridesCleared > 0 ? ` · ${result.overridesCleared} custom settings replaced` : ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
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
        Select the entire vault, one item, or several folders and files, then choose who gets
        <strong> Shared</strong>, <strong>Read-only</strong>, or <strong>Private</strong> access.
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
        <div className="access-listhead">
          <div><div className="access-listlabel">Folders &amp; files</div>{canManage && <span>{selectionLabel}</span>}</div>
          {canManage && entries.length > 0 && (
            <button
              type="button"
              className="access-select-all"
              onClick={selectEveryResource}
            >
              {allItemsSelected ? "Clear selection" : "Select all items"}
            </button>
          )}
        </div>

        {orgId && (
          <label className={`access-row access-vault-row${vaultSelected ? " sel" : ""}`}>
            <input className="access-check" type="checkbox" checked={vaultSelected} disabled={!canManage} onChange={() => toggleResource(vaultKey)} />
            <span className="access-glyph">{ICON.vault}</span>
            <span className="access-rname">Entire vault</span>
            <span className="access-rright">{shownVaultMode ? <AccessBadge mode={shownVaultMode} /> : <LoadingBadge />}</span>
          </label>
        )}

        {resources.length === 0 ? (
          <div className="muted perm-empty">Nothing synced yet.</div>
        ) : (
          <ul className="access-list">
            {resources.map((resource) => {
              const key = accessEntryKey(resource);
              const selected = selectedKeys.has(key);
              const mode = teamModeFor(resource.path);
              const itemLock = lockMap.get(resource.path);
              const restricted = !!itemLock && !itemLock.org && itemLock.users.size > 0;
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
                  <label className={`access-row${selected ? " sel" : ""}`}>
                    <input className="access-check" type="checkbox" checked={selected} disabled={!canManage} onChange={() => toggleResource(key)} />
                    <span className="access-glyph">{rowGlyph(resource)}</span>
                    <span className="access-rname">{resource.name}</span>
                    <span className="access-rright">{mode ? <AccessBadge mode={mode} restricted={restricted} /> : <LoadingBadge />}</span>
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

          <div className={`access-seg${busy ? " busy" : ""}`} ref={accessChoicesRef}>
            {(["open", "readonly", "private"] as Mode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className="access-segbtn"
                data-mode={mode}
                disabled={busy || (audienceType === "users" && selectedUsers.size === 0)}
                onClick={() => requestBulk(mode)}
              >
                <span className="access-st-top">{mode === "open" ? ICON.open : mode === "readonly" ? ICON.lock : ICON.shield}{MODE_LABEL[mode]}</span>
                <span className="access-st-sub">{mode === "open" ? "Can read and edit" : mode === "readonly" ? "Can read, cannot edit" : "Cannot see this content"}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function rowGlyph(resource: Resource): React.ReactNode {
  if (resource.kind === "folder") return ICON.folder;
  return resource.kind === "file" ? iconForPath(resource.path) : ICON.note;
}

function AccessBadge({ mode, restricted = false }: { mode: Mode; restricted?: boolean }) {
  const shown = restricted ? "readonly" : mode;
  return (
    <span className={`access-badge ${shown === "private" ? "priv" : shown === "readonly" ? "ro" : "open"}`}>
      {shown === "private" ? ICON.shield : shown === "readonly" ? ICON.lock : ICON.open}
      {restricted ? "Restricted" : MODE_LABEL[shown]}
    </span>
  );
}

function LoadingBadge() {
  return <span className="access-badge loading" aria-label="Loading access"><Spinner size="xs" /></span>;
}
