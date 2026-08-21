import { useEffect, useMemo, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import {
  type ResolvedMemberAccess,
  type Share,
  sharePrincipalId,
  sharePrincipalType,
} from "../lib/api";
import type { TreeNode } from "../lib/ipc";
import {
  ancestorPaths,
  folderChildrenLoaded,
  visibleAccessRows,
  type AccessRow,
} from "../lib/accessTree";
import { lockScopesByPath, resourceIdsByPath } from "../lib/locks";
import { syncManager } from "../lib/sync/docSession";
import { useStore } from "../store";
import { Avatar } from "./Identity";
import { Spinner } from "./Spinner";

/**
 * Access — the unified locker. A vault-default posture (Shared · Read-only ·
 * Private) plus a per-folder/note override and a resolved "who can access" list.
 * Built on the shares model:
 *  - Vault posture            = an org grant on the vault (edit=Shared, the
 *    default for a new vault; view=Read-only) or none (Private).
 *  - "Shared" on an item      = an org edit grant on the folder/file.
 *  - "Read-only" on an item   = an org view grant (Private vault) or an
 *    org `locked` share (Open vault, where a lock caps the edit baseline).
 *  - "Private" on an item     = no team row (only creator + explicit shares).
 *  - Per-member view/edit     = a user-scope lock / edit grant.
 * Folder settings inherit to everything inside (server ACL + lock overlay).
 */

type Mode = "open" | "readonly" | "private";
// Per-member states are the two the vault model actually supports on top of
// the Open baseline: "edit" (writable) and "view" (read-only). Because grants
// only ever RAISE permission and a member already has edit under Open, "view"
// must be a per-user LOCK (a cap), not a view grant — a view grant would leave
// the member on edit. "default" clears the override (falls back to Open / the
// folder's inherited setting). "none" is the deny: the only per-member row that
// SUBTRACTS, and the only way to keep one person out of a folder in a vault
// everyone else can read. One row per (resource, user): grant, lock, or deny.
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

const MODE_LABEL: Record<Mode, string> = {
  open: "Open",
  readonly: "Read-only",
  private: "Private",
};

/** Which paths carry a lock, folded down through folder inheritance. */
function buildLockMap(
  tree: TreeNode | null,
  locks: Share[],
): Map<string, { org: boolean; users: Set<string> }> {
  const idToPath = resourceIdsByPath(tree);
  const direct = new Map<string, { org: boolean; users: Set<string> }>();
  for (const l of locks) {
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
  const tree = useStore((s) => s.tree);
  const syncEnabled = useStore((s) => s.syncEnabled);

  /**
   * The item whose access is being edited. Held as the row itself, not just its
   * key, so collapsing a folder doesn't blank the detail pane out from under
   * someone who is halfway through configuring a note inside it.
   */
  const [selected, setSelected] = useState<Resource | null>(null);
  const selectedKey = selected?.key ?? "";
  /** Folder paths currently open in the list. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Folder paths whose children are being fetched from Rust right now. */
  const [expanding, setExpanding] = useState<Set<string>>(() => new Set());
  const [shares, setShares] = useState<Share[]>([]);
  const [access, setAccess] = useState<ResolvedMemberAccess[] | null>(null);
  const [wsShares, setWsShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgId = session?.activeOrganizationId ?? null;

  // Vault posture: an org grant on the vault is "Open" (edit) or
  // "Read-only" (view); no grant is "Private" (members see only what they
  // create or what's explicitly shared with them / the team).
  const reloadVault = async () => {
    if (!canManage || !orgId) {
      setWsShares([]);
      return;
    }
    try {
      setWsShares(await authManager.api.listVaultShares(orgId));
    } catch {
      setWsShares([]);
    }
  };
  useEffect(() => {
    void reloadVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, orgId]);

  const wsGrant = wsShares.find(
    (s) => sharePrincipalType(s) === "org" && (s.permission === "edit" || s.permission === "view"),
  );
  const wsPosture: Mode = wsGrant ? (wsGrant.permission === "edit" ? "open" : "readonly") : "private";

  /**
   * The rows currently on screen: the vault tree, indented, with a collapsed
   * folder's contents left out. The rule that makes it work — an un-listed
   * folder is expandable, not empty — lives in `lib/accessTree` where a test
   * can hold it.
   */
  const resources = useMemo<Resource[]>(
    () =>
      visibleAccessRows(tree, expanded, {
        folderId: (path) => syncManager.registry.getFolderId(path),
        docId: (path) => syncManager.registry.getMapping(path)?.docId ?? null,
      }),
    [tree, expanded],
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
    if (loaded) return;
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

  /** Reveal a path in the list by opening every folder above it. */
  const revealPath = (path: string) => {
    const above = ancestorPaths(path);
    if (above.length === 0) return;
    setExpanded((prev) => new Set([...prev, ...above]));
  };

  const lockMap = useMemo(() => buildLockMap(tree, locks), [tree, locks]);
  const directScopes = useMemo(
    () => lockScopesByPath(tree, locks, session?.user.id),
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
  const ownOrgView = shares.find((s) => sharePrincipalType(s) === "org" && s.permission === "view");
  const ownOrgEdit = shares.find((s) => sharePrincipalType(s) === "org" && s.permission === "edit");
  const inheritedOrgLock = !!effLock?.org && !ownOrgLock;
  // Resolve the resource's team mode: a direct lock/view → read-only; a direct
  // edit grant → shared/open; nothing direct → inherit the vault posture.
  const generalMode: Mode =
    ownOrgLock || inheritedOrgLock || ownOrgView
      ? "readonly"
      : ownOrgEdit
        ? "open"
        : wsPosture;
  // When an Everyone/org lock (direct or inherited) already makes the resource
  // read-only for all, a per-member "read-only" lock is redundant and makes
  // Unlock misleading — so the per-person controls are suppressed in favour of
  // the single vault/parent lock.
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

  /** Clear every DIRECT org row (grant or lock) on the selected resource. */
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
    if (!selected || mode === generalMode || inheritedOrgLock) return;
    void run(async () => {
      await clearResourceOrgRows();
      if (mode === "open") {
        await authManager.api.createShare({
          resourceType: selected.kind,
          resourceId: selected.id,
          principalType: "org",
          permission: "edit",
        });
      } else if (mode === "readonly") {
        if (wsPosture === "private") {
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
      // "private" = just the cleared state (no team row).
    });
  };

  // Whole-vault posture (Open / Read-only / Private) = the org grant on the
  // vault resource. Private removes it, falling back to per-item sharing.
  const setVaultPosture = (mode: Mode) => {
    if (!orgId || mode === wsPosture) return;
    void run(async () => {
      if (wsGrant) await authManager.api.revokeShare(wsGrant.id);
      if (mode !== "private") {
        await authManager.api.createShare({
          resourceType: "vault",
          resourceId: orgId,
          principalType: "org",
          permission: mode === "open" ? "edit" : "view",
        });
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

  const setMember = (userId: string, choice: MemberChoice) => {
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
        Choose what the team can reach. Set the whole vault below, then override any folder or
        note — <strong>Shared</strong> (read &amp; write), <strong>Read-only</strong>, or{" "}
        <strong>Private</strong> (just you). Folder settings flow down to everything inside.
      </p>

      {canManage && orgId && (
        <div className="access-ws">
          <div className="access-seclabel">
            This vault, by default
            {busy && (
              <span className="access-applying">
                <Spinner size="xs" /> Applying…
              </span>
            )}
          </div>
          <div className={`access-seg${busy ? " busy" : ""}`} aria-busy={busy} aria-disabled={busy}>
            {(["open", "readonly", "private"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`access-segbtn${wsPosture === m ? " active" : ""}`}
                data-mode={m}
                disabled={busy}
                onClick={() => setVaultPosture(m)}
              >
                <span className="access-st-top">
                  {m === "open" ? ICON.open : m === "readonly" ? ICON.lock : ICON.shield}
                  {m === "open" ? "Shared" : MODE_LABEL[m]}
                </span>
                <span className="access-st-sub">
                  {m === "open"
                    ? "Everyone reads & writes everything."
                    : m === "readonly"
                      ? "Everyone can read everything, not edit."
                      : "Members see only what they create or you share."}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="auth-error">{error}</div>}

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
                const readOnly = !!lk;
                const everyone = !!lk?.org;
                const affected = everyone
                  ? members.map((m) => m.userId)
                  : [...(lk?.users ?? [])];
                const isOpen = expanded.has(r.path);
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
                      onClick={() => setSelected(r)}
                    >
                      <span className="access-glyph">{r.kind === "folder" ? ICON.folder : ICON.note}</span>
                      <span className="access-rname">{r.name}</span>
                      <span className="access-rright">
                        {readOnly && affected.length > 0 && (
                          <span className="access-avstack" aria-hidden="true">
                            {affected.slice(0, 3).map((uid) => (
                              <span className="access-av-wrap locked" key={uid}>
                                <Avatar label={displayName(uid)} />
                              </span>
                            ))}
                          </span>
                        )}
                        <span
                          className={`access-badge ${
                            readOnly ? "ro" : wsPosture === "private" ? "priv" : "open"
                          }`}
                        >
                          {readOnly
                            ? ICON.lock
                            : wsPosture === "private"
                              ? ICON.shield
                              : wsPosture === "readonly"
                                ? ICON.lock
                                : ICON.open}
                          {readOnly
                            ? everyone
                              ? "Read-only"
                              : "Restricted"
                            : wsPosture === "private"
                              ? "Private"
                              : wsPosture === "readonly"
                                ? "Read-only"
                                : "Shared"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* detail */}
        <div className="access-detail">
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
                          setSelected(inheritSourceRes);
                        }}
                      >
                        Open {inheritSourceRes.name} ›
                      </button>
                    )}
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
                className={`access-seg${busy ? " busy" : ""}`}
                aria-busy={busy}
                aria-disabled={!canManage || inheritedOrgLock}
              >
                {(["open", "readonly", "private"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`access-segbtn${generalMode === m ? " active" : ""}`}
                    data-mode={m}
                    disabled={!canManage || inheritedOrgLock || busy}
                    onClick={() => setGeneral(m)}
                  >
                    <span className="access-st-top">
                      {m === "open" ? ICON.open : m === "readonly" ? ICON.lock : ICON.shield}
                      {m === "open" ? "Shared" : MODE_LABEL[m]}
                    </span>
                    <span className="access-st-sub">
                      {m === "open"
                        ? "The whole team can read & write."
                        : m === "readonly"
                          ? "The team can read, not edit. Claude reads only."
                          : "Only you and people you share it with."}
                    </span>
                  </button>
                ))}
              </div>
              {generalMode === "private" && wsPosture !== "private" && (
                <div className="access-hint">
                  This vault is <strong>{MODE_LABEL[wsPosture]}</strong>, so everything is
                  visible to the team by default. To make individual items private, set the whole
                  vault to <strong>Private</strong> above, then share the folders you want.
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
                          <div className="access-prole">{sourceLabel(m, choice)}</div>
                        </div>
                        {canManage && m.role !== "owner" ? (
                          <select
                            className="access-choice"
                            value={choice}
                            disabled={busy}
                            onChange={(e) => setMember(m.userId, e.target.value as MemberChoice)}
                          >
                            <option value="default">Default</option>
                            {/* An Everyone/parent lock already holds everyone at
                                read-only, so offering "can view"/"can edit" here
                                would promise something the lock overrides. "No
                                access" still works — a deny outranks a lock. */}
                            {!everyoneReadonly && <option value="view">Can view (read-only)</option>}
                            {!everyoneReadonly && <option value="edit">Can edit</option>}
                            <option value="none">No access (blocked)</option>
                          </select>
                        ) : (
                          <span className={`access-lv ${levelCls(m.permission)}`}>{levelLabel(m.permission)}</span>
                        )}
                      </div>
                    );
                  })}

                  {otherMembers === 0 && (
                    <p className="access-hint">
                      You're the only member. Invite teammates in <strong>Members</strong>, then
                      each one gets a per-person control here — <strong>Can edit</strong> or{" "}
                      <strong>Can view (read-only)</strong> — so you can lock this{" "}
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

function sourceLabel(m: ResolvedMemberAccess, choice: MemberChoice): string {
  if (choice === "none" || m.denied) return "Blocked · no access";
  if (m.permission === "none") return "No access";
  if (m.capped) return "Read-only · locked";
  if (m.role === "owner") return "Owner · full access";
  if (m.role === "admin") return "Admin · full access";
  if (choice === "edit") return "Shared · can edit";
  if (choice === "view") return "Read-only · locked";
  // default (no direct override): reflect whatever the baseline resolved to.
  return m.permission === "view" ? "Inherited · read-only" : "Open · can edit";
}
