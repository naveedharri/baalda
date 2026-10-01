// Owner/admin view of notes whose content never reached the server (#257).
//
// A note can be registered (its row exists, teammates see it in the sidebar)
// while its text is still only on the device that registered it — a first
// upload that was quit, crashed or lost its network part-way. The server can
// now tell those apart from genuinely empty notes (the desktop confirms the
// latter, `SyncManager.reportConfirmedEmpty`) and counts them; this shows the
// count, and whose device still holds the missing text, in Health.
//
// Read-only and best-effort: a member (403), an older server (404) or an
// offline app simply shows nothing. Reuses the attachment notice's banner
// styling rather than inventing a new one.
import { useEffect, useState } from "react";
import { api } from "../lib/auth/authManager";
import { syncManager } from "../lib/sync/docSession";
import { useStore } from "../store";
import { BRAND_NAME } from "../lib/brand";
import { Banner } from "./Banner";

type UploadHealth = Awaited<ReturnType<typeof api.uploadHealth>>;

export function StalledUploadsNotice() {
  const vaultStatus = useStore((s) => s.vaultSyncStatus);
  const [health, setHealth] = useState<UploadHealth | null>(null);
  const vaultId = syncManager.registry.vaultId;

  useEffect(() => {
    setHealth(null);
    if (!vaultId || vaultStatus !== "synced") return;
    let live = true;
    api
      .uploadHealth(vaultId)
      .then((h) => {
        if (live) setHealth(h);
      })
      .catch(() => {
        /* not a manager, older server or offline: nothing to show */
      });
    return () => {
      live = false;
    };
  }, [vaultId, vaultStatus]);

  const stalled = health?.stalled ?? 0;
  const who = (health?.byCreator ?? [])
    .filter((c) => c.count > 0)
    .slice(0, 3)
    .map((c) => `${c.name || "a former member"} (${c.count.toLocaleString()})`)
    .join(", ");
  return (
    <Banner
      show={stalled > 0}
      className="attachment-sync-notice attachment-sync-notice-health"
      role="status"
    >
      <span className="attachment-sync-copy">
        <strong className="attachment-sync-title">
          {stalled.toLocaleString()} {stalled === 1 ? "note was" : "notes were"} registered but
          {stalled === 1 ? " its" : " their"} content never arrived
        </strong>
        <span className="attachment-sync-body">
          Teammates see {stalled === 1 ? "it" : "them"} as empty. The text is still on the
          device that added {stalled === 1 ? "it" : "them"}
          {who ? ` — ${who}` : ""}: opening {BRAND_NAME} there finishes the upload.
        </span>
      </span>
    </Banner>
  );
}

