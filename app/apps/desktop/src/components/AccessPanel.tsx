import { useEffect, useMemo, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import {
  type ResolvedMemberAccess,
  type Share,
  sharePrincipalId,
  sharePrincipalType,
} from "../lib/api";
import type { TreeNode } from "../lib/ipc";
import { lockScopesByPath, resourceIdsByPath } from "../lib/locks";
import { syncManager } from "../lib/sync/docSession";
import { useStore } from "../store";
import { Avatar } from "./Identity";

/**
 * Access — the unified locker. One structural view of the vault where every
 * folder/note has a mode (Open · Read-only · Private-coming-soon) plus a
 * resolved "who can access" list. Built on the existing shares model:
 *  - Read-only for everyone = an org-scope `locked` share on the resource.
 *  - Per-member Read-only    = a user-scope `locked` share.
 *  - Can view / Can edit     = a user-scope view/edit grant.
 * Folder settings inherit to everything inside (server ACL + lock overlay).
 */

type Mode = "open" | "readonly" | "private";
// Per-member states are the two the workspace model actually supports on top of
// the Open baseline: "edit" (writable) and "view" (read-only). Because grants
// only ever RAISE permission and a member already has edit under Open, "view"
// must be a per-user LOCK (a cap), not a view grant — a view grant would leave
// the member on edit. "default" clears the override (falls back to Open / the
// folder's inherited setting). One row per (resource, user): grant OR lock.
type MemberChoice = "default" | "view" | "edit";

interface Resource {
  key: string;
  kind: "folder" | "file";
  id: string;
  path: string;
  name: string;
  depth: number;
}

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

  const [selectedKey, setSelectedKey] = useState<string>("");
  const [shares, setShares] = useState<Share[]>([]);
  const [access, setAccess] = useState<ResolvedMemberAccess[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flatten every synced folder + note into an indented list.
  const resources = useMemo<Resource[]>(() => {
    const out: Resource[] = [];
    const walk = (n: TreeNode, depth: number) => {
      if (n.isDir) {
        const id = syncManager.registry.getFolderId(n.path);
        if (id) out.push({ key: `folder:${id}`, kind: "folder", id, path: n.path, name: baseName(n.path), depth });
      } else {
        const m = syncManager.registry.getMapping(n.path);
        if (m) out.push({ key: `file:${m.docId}`, kind: "file", id: m.docId, path: n.path, name: baseName(n.path, true), depth });
      }
      n.children?.forEach((c) => walk(c, depth + 1));
    };
    tree?.children?.forEach((c) => walk(c, 0));
    return out;
  }, [tree]);

  const lockMap = useMemo(() => buildLockMap(tree, locks), [tree, locks]);
  const directScopes = useMemo(
    () => lockScopesByPath(tree, locks, session?.user.id),
    [tree, locks, session?.user.id],
  );

  const selected = resources.find((r) => r.key === selectedKey) ?? null;

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
        Access needs sync — sign in and connect this folder to a workspace first.
      </div>
    );
  }

  // --- helpers over the selected resource -----------------------------------

  const effLock = lockMap.get(selected?.path ?? "");
  const ownScope = selected ? directScopes.get(selected.path) ?? null : null;
  // An org lock on THIS resource (direct) vs inherited from a parent folder.
  const ownOrgLock = shares.find((s) => sharePrincipalType(s) === "org" && s.permission === "locked");
  const inheritedOrgLock = !!effLock?.org && !ownOrgLock;
  const generalMode: Mode = ownOrgLock || inheritedOrgLock ? "readonly" : "open";
  // When an Everyone/org lock (direct or inherited) already makes the resource
  // read-only for all, a per-member "read-only" lock is redundant and makes
  // Unlock misleading — so the per-person controls are suppressed in favour of
  // the single workspace/parent lock.
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
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await useStore.getState().refreshLocks();
      await reload(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setGeneral = (mode: Mode) => {
    if (!selected || mode === "private" || mode === generalMode || inheritedOrgLock) return;
    void run(async () => {
      if (mode === "readonly") {
        await useStore.getState().createLock(selected.kind, selected.id, null);
      } else if (ownOrgLock) {
        await useStore.getState().removeLock(ownOrgLock.id);
      }
    });
  };

  const memberChoice = (userId: string): MemberChoice => {
    // A per-user lock reads back as read-only ("view"); an edit grant as "edit".
    // A legacy view grant also maps to "view" (it will be rewritten as a lock
    // the next time the member is set, so it actually takes effect).
    const lock = shares.find(
      (s) => sharePrincipalType(s) === "user" && sharePrincipalId(s) === userId && s.permission === "locked",
    );
    if (lock) return "view";
    const grant = shares.find(
      (s) => sharePrincipalType(s) === "user" && sharePrincipalId(s) === userId && s.permission !== "locked",
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
          if (s.permission === "locked") await useStore.getState().removeLock(s.id);
          else await authManager.api.revokeShare(s.id);
        }
      }
      if (choice === "edit") {
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
        Every item is <strong>Open</strong> — teammates read &amp; write and Claude can read and edit.
        Set anything to <strong>Read-only</strong> to freeze it for everyone (admins included).
        Folder settings flow down to everything inside.
      </p>

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
                return (
                  <li key={r.key}>
                    <button
                      type="button"
                      className={`access-row${r.key === selectedKey ? " sel" : ""}`}
                      style={{ paddingLeft: `${10 + r.depth * 16}px` }}
                      onClick={() => setSelectedKey(r.key)}
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
                        <span className={`access-badge ${readOnly ? "ro" : "open"}`}>
                          {readOnly ? ICON.lock : ICON.open}
                          {readOnly ? (everyone ? "Read-only" : "Restricted") : "Open"}
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
                      <button className="access-jump" onClick={() => setSelectedKey(inheritSourceRes.key)}>
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
                    <strong>Read-only caps everyone</strong> — workspace admins included. Only someone who
                    manages access can lift it.
                  </span>
                </div>
              )}

              <div className="access-seclabel">
                {selected.kind === "folder" ? "Access for this folder & everything inside" : "Access mode"}
              </div>
              <div className="access-seg" aria-disabled={!canManage || inheritedOrgLock}>
                {(["open", "readonly", "private"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`access-segbtn${generalMode === m ? " active" : ""}${m === "private" ? " soon" : ""}`}
                    data-mode={m}
                    disabled={!canManage || inheritedOrgLock || m === "private" || busy}
                    onClick={() => setGeneral(m)}
                  >
                    <span className="access-st-top">
                      {m === "open" ? ICON.open : m === "readonly" ? ICON.lock : ICON.shield}
                      {MODE_LABEL[m]}
                      {m === "private" && <span className="access-soon-tag">Soon</span>}
                    </span>
                    <span className="access-st-sub">
                      {m === "open"
                        ? "Read & write for the workspace."
                        : m === "readonly"
                          ? "Frozen for everyone. Claude can read, not edit."
                          : "Encrypted — even Claude can't read it."}
                    </span>
                  </button>
                ))}
              </div>

              <div className="access-seclabel">
                Who can access{loading ? " · resolving…" : ""}
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
                        {canManage && m.role !== "owner" && !everyoneReadonly ? (
                          <select
                            className="access-choice"
                            value={choice}
                            disabled={busy}
                            onChange={(e) => setMember(m.userId, e.target.value as MemberChoice)}
                          >
                            <option value="default">Default</option>
                            <option value="view">Can view (read-only)</option>
                            <option value="edit">Can edit</option>
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

function baseName(path: string, stripMd = false): string {
  const last = path.split("/").pop() ?? path;
  return stripMd ? last.replace(/\.md$/i, "") : last;
}

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
  if (m.permission === "none") return "No access";
  if (m.capped) return "Read-only · locked";
  if (m.role === "owner") return "Owner · full access";
  if (m.role === "admin") return "Admin · full access";
  if (choice === "edit") return "Shared · can edit";
  if (choice === "view") return "Read-only · locked";
  // default (no direct override): reflect whatever the baseline resolved to.
  return m.permission === "view" ? "Inherited · read-only" : "Open · can edit";
}
