// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type { HealthActions } from "../lib/health/types";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Files on this computer that the Remote Vault has no path for — the other side
 * of {@link MissingFileActions}, with the same shape plus a selection, because
 * a stuck batch is usually tens of files at once.
 *
 * Retry runs the upload pass for them now. Delete is the sidebar's delete, and
 * for these files it is final: the server never held them, so there is no copy
 * to come back from — the confirm says so.
 */
export function LocalOnlyFileActions({ paths, actions, blocked, onShow }: {
  paths: string[];
  actions: HealthActions;
  /** Syncing these file types needs Pro here, so a retry cannot succeed. */
  blocked: boolean;
  onShow: (path: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [limit, setLimit] = useState(20);

  // A path that left the list (synced, deleted) must not stay selected.
  const live = new Set(paths);
  const picked = [...selected].filter((p) => live.has(p));
  const allPicked = picked.length === paths.length;

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  async function retry(which: string[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await actions.retryLocalFiles(which);
      setNotice(`Retried ${which.length.toLocaleString()} ${which.length === 1 ? "file" : "files"}. Anything still listed did not sync yet.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const target = picked.length > 0 ? picked : paths;
  const scopeLabel = picked.length > 0 ? `selected (${picked.length.toLocaleString()})` : "all";

  return <div className="health-difference-group health-missing-files">
    <h4>Notes in other formats missing from the Remote Vault <span>{paths.length.toLocaleString()}</span></h4>
    <p>{blocked
      ? "These notes stay on this computer because syncing these file types requires Pro. They remain available to preview locally."
      : "These files are on this computer but not on the Remote Vault yet."}</p>
    <div className="health-missing-toolbar">
      <button
        type="button"
        className="ghost-pill sm"
        disabled={busy}
        onClick={() => setSelected(allPicked ? new Set() : new Set(paths))}
      >
        {allPicked ? "Clear selection" : "Select all"}
      </button>
      {!blocked && (
        <AsyncButton className="ghost-pill sm" disabled={busy} onClick={() => retry(target)}>
          {`Retry ${scopeLabel}`}
        </AsyncButton>
      )}
      <button
        type="button"
        className="link-btn danger"
        disabled={busy || picked.length === 0}
        onClick={() => { setError(null); setConfirmDelete(picked); }}
      >
        {picked.length > 0 ? `Delete selected (${picked.length.toLocaleString()})` : "Delete selected"}
      </button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && !confirmDelete && <p role="alert" className="auth-error health-missing-error">{error}</p>}
    <ul>
      {paths.slice(0, limit).map((path) => (
        <li key={path}>
          <label className="health-missing-path" title={path}>
            <input
              type="checkbox"
              checked={selected.has(path)}
              disabled={busy}
              onChange={() => toggle(path)}
            />{" "}
            {path}
          </label>
          <div className="health-missing-actions">
            <button type="button" className="link-btn" onClick={() => onShow(path)}>Show</button>
          </div>
        </li>
      ))}
    </ul>
    {paths.length > limit && (
      <button type="button" className="link-btn" onClick={() => setLimit(limit + 20)}>Show more</button>
    )}
    {confirmDelete && <ConfirmDialog
      title={`Delete ${confirmDelete.length.toLocaleString()} ${confirmDelete.length === 1 ? "file" : "files"} from this computer?`}
      confirmLabel="Delete"
      onCancel={() => { setConfirmDelete(null); setError(null); }}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          const { deleted, failed } = await actions.deleteLocalFiles(confirmDelete);
          setSelected((prev) => {
            const next = new Set(prev);
            for (const p of deleted) next.delete(p);
            return next;
          });
          if (failed.length > 0) {
            setError(failed.map((f) => `${f.path}: ${f.reason}`).join("\n"));
            return;
          }
          setConfirmDelete(null);
          setNotice(`Deleted ${deleted.length.toLocaleString()} ${deleted.length === 1 ? "file" : "files"}.`);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <p role="alert" className="auth-error">{error}</p>}
      <p>These files are not on the Remote Vault, so this computer holds the only copy. Deleting removes them permanently. Save a copy first if you need them.</p>
    </ConfirmDialog>}
  </div>;
}
