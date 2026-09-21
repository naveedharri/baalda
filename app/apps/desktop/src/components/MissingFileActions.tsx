// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type { HealthActions } from "../lib/health/types";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";

export function MissingFileActions({ paths, actions, blocked, showUpgrade }: {
  paths: string[];
  actions: HealthActions;
  blocked: boolean;
  showUpgrade: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<{ path: string; action: () => Promise<void> } | null>(null);
  const [limit, setLimit] = useState(20);
  async function download(selected: string[]) {
    setNotice(null);
    if (blocked) {
      setError(showUpgrade
        ? "Downloads require Pro. Use Upgrade to Pro at the top of Health to enable them."
        : "Downloads require Pro. Contact the vault owner to enable them.");
      return;
    }
    setBusy(true);
    setError(null);
    try { await actions.downloadFiles(selected); setNotice("Download complete."); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="health-difference-group health-missing-files">
    <h4>Missing files <span>{paths.length}</span></h4>
    <p>{blocked
      ? "Downloading files requires Pro, even if they were uploaded earlier."
      : "These files are on the server but not on this computer."}</p>
    {!blocked && paths.length > 1 && (
      <div className="health-missing-toolbar">
        <AsyncButton className="ghost-pill sm" disabled={busy} onClick={() => download(paths)}>
          Download all
        </AsyncButton>
      </div>
    )}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="auth-error health-missing-error">{error}</p>}
    <ul>
      {paths.slice(0, limit).map(path => (
        <li key={path}>
          <span className="health-missing-path" title={path}>{path}</span>
          <div className="health-missing-actions">
            <AsyncButton className="ghost-pill sm" disabled={busy} onClick={() => download([path])}>
                Download
            </AsyncButton>
            <button
              type="button"
              className="link-btn danger"
              disabled={busy}
              onClick={() => { setError(null); setRemove({ path, action: () => actions.removeServerFile(path) }); }}
            >
              Remove from server
            </button>
          </div>
        </li>
      ))}
    </ul>
    {paths.length > limit && (
      <button type="button" className="link-btn" onClick={() => setLimit(limit + 20)}>Show more</button>
    )}
    {remove && <ConfirmDialog title="Remove this file from the server?" confirmLabel="Remove from server" onCancel={() => setRemove(null)} onConfirm={async () => {
      setError(null);
      setBusy(true);
      try { await remove.action(); setRemove(null); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>
      {error && <p role="alert" className="auth-error">{error}</p>}
      <p><code>{remove.path}</code> will be permanently removed from the Remote Vault. Other members lose access and synced devices may remove their copies. This cannot be undone. Save a copy first if you need it.</p>
    </ConfirmDialog>}
  </div>;
}
