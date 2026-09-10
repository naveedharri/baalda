import { useEffect, useState } from "react";
import { authManager } from "../lib/auth/authManager";
import {
  type Permission,
  type Share,
  sharePrincipalId,
} from "../lib/api";
import { useStore } from "../store";
import { Avatar } from "./Avatar";

export interface ShareTarget {
  resourceType: "folder" | "file";
  resourceId: string;
  title: string;
}

/**
 * Folder/file share dialog (spec 04 §3/§6): grant a member view/edit, list
 * existing shares, revoke. Folder shares are inherited by descendants per the
 * server ACL; revoke force-disconnects live sockets server-side (instant kill).
 */
export function ShareDialog({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const members = useStore((s) => s.members);
  const session = useStore((s) => s.session);

  const [shares, setShares] = useState<Share[]>([]);
  const [principalId, setPrincipalId] = useState("");
  const [permission, setPermission] = useState<Permission>("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shareableMembers = members.filter((m) => m.userId !== session?.user.id);

  const load = async () => {
    try {
      const list = await authManager.api.listShares(target.resourceType, target.resourceId);
      setShares(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    if (shareableMembers.length > 0 && !principalId) {
      setPrincipalId(shareableMembers[0].userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.resourceId]);

  const addShare = async () => {
    if (!principalId) return;
    setBusy(true);
    setError(null);
    try {
      await authManager.api.createShare({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        principalId,
        permission,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    setBusy(true);
    try {
      await authManager.api.revokeShare(shareId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const memberName = (userId: string) => {
    const m = members.find((mm) => mm.userId === userId);
    return m?.user?.name || m?.user?.email || userId;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>
            Share <strong>{target.title}</strong>
            <span className="muted"> ({target.resourceType})</span>
          </span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="share-add">
          <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)}>
            {shareableMembers.length === 0 && <option value="">No other members</option>}
            {shareableMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user?.name || m.user?.email || m.userId}
              </option>
            ))}
          </select>
          <select value={permission} onChange={(e) => setPermission(e.target.value as Permission)}>
            <option value="view">view</option>
            <option value="edit">edit</option>
          </select>
          <button
            className="primary"
            disabled={busy || !principalId}
            onClick={() => void addShare()}
          >
            Share
          </button>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <div className="subhead">People with access</div>
        {shares.length === 0 ? (
          <div className="muted">Not shared with anyone yet.</div>
        ) : (
          <ul className="share-list">
            {shares.map((s) => {
              const name = memberName(sharePrincipalId(s));
              return (
                <li key={s.id}>
                  <Avatar label={name} />
                  <span className="member-name">{name}</span>
                  <span className="member-role">{s.permission}</span>
                  <button className="link-btn danger" onClick={() => void revoke(s.id)}>
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
