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
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<{ path: string; action: () => Promise<void> } | null>(null);
  const [limit, setLimit] = useState(20);
  async function download(selected: string[]) {
    setBusy(true);
    setError(null);
    try { await actions.downloadFiles(selected); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="health-difference-group">
    <h4>Files missing from this computer <span>{paths.length}</span></h4>
    <p>{blocked
      ? "This server requires Pro to download these files, including files uploaded before the restriction. Upgrade this vault or contact its owner."
      : "Download a file or all missing files. If a download fails, its reason appears here."}</p>
    {blocked && showUpgrade && <button className="primary sm" onClick={() => actions.openUpgrade()}>Upgrade to Pro</button>}
    <AsyncButton className="ghost-pill sm" disabled={busy || blocked} onClick={() => download(paths)}>Download all missing files</AsyncButton>
    {error && <p role="alert" className="auth-error" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}
    <ul>{paths.slice(0, limit).map(path => <li key={path}>
      <span className="health-difference-rowcopy">{path}</span>
      <AsyncButton className="link-btn" disabled={busy || blocked} onClick={() => download([path])}>Download</AsyncButton>
      <button className="link-btn danger" disabled={busy} onClick={() => setRemove({ path, action: () => actions.removeServerFile(path) })}>Remove from server</button>
    </li>)}</ul>
    {paths.length > limit && <button className="link-btn" onClick={() => setLimit(limit + 20)}>Show more</button>}
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
