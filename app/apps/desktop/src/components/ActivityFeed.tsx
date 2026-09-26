/* The right panel's Activity tab (RightPanel.tsx): ONE chronological feed of
   what happened to this vault's notes — the reconnect report, the server's
   Trash, and local recovery copies — merged by `activityRows.ts`. It replaces
   the three headed sections that used to live in Vault Settings → Health.

   The server Trash keeps its old rules: only a connected vault is current;
   offline or signed out it shows the last listing it fetched (per vault id,
   this app session) and Restore waits for the connection. */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { ApiError, type TrashItem, type TrashListing } from "../lib/api";
import { syncManager } from "../lib/sync/docSession";
import { reconcileReport, type ReconcileItem } from "../lib/sync/reconcileReport";
import * as ipc from "../lib/ipc";
import { clockTime, formatBytes, relativeTime } from "../lib/health/format";
import { AsyncButton } from "./AsyncButton";
import { PathText } from "./HealthShared";
import { RecoveryCopyActions, TrashPreviewActions } from "./RecoveryCopyActions";
import { reconcileCopyRef } from "./recoveryCopies";
import { compareTrash, openReviewTab, openTrashPreview } from "./recoveryActions";
import { usePendingReviewCount } from "./ReviewTab";
import { ACTIVITY_HINT, buildActivity, type ActivityRow } from "./activityRows";

/** Rows shown before "Show more", like the Health lists. */
const PAGE = 20;

/** Last Trash listing per server vault id, this app session. Never authorises. */
const lastTrash = new Map<string, { listing: TrashListing; at: number }>();

export function trashErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This note is no longer in Trash.";
    if (e.status === 403) return "You don't have permission to restore this note.";
    return e.message || `The server refused (${e.status}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** The server Trash for the open synced vault, or null (local vault / never fetched). */
function useTrash(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const online = hasSession && syncStatus === "synced";
  const cached = vaultId ? lastTrash.get(vaultId) : undefined;
  const [listing, setListing] = useState<TrashListing | null>(cached?.listing ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setListing(vaultId ? (lastTrash.get(vaultId)?.listing ?? null) : null);
  }, [vaultId]);

  useEffect(() => {
    if (!syncEnabled || !vaultId || !online) return;
    let cancelled = false;
    setError(null);
    authManager.api.listTrash(vaultId).then(
      (l) => {
        if (cancelled) return;
        lastTrash.set(vaultId, { listing: l, at: Date.now() });
        setListing(l);
      },
      (e) => !cancelled && setError(trashErrorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [syncEnabled, vaultId, online, nonce]);

  return { listing: syncEnabled && vaultId ? listing : null, error, online };
}

function useCopies(nonce: number) {
  const epoch = useStore((s) => s.vault?.epoch);
  const hasVault = useStore((s) => s.vault != null);
  const [copies, setCopies] = useState<ipc.TrashCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!hasVault) return;
    let cancelled = false;
    setError(null);
    ipc.listTrashCopies(epoch).then(
      (list) => !cancelled && setCopies(list),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [hasVault, epoch, nonce]);
  return { copies, error };
}

function ReconcileRowActions({ item }: { item: ReconcileItem }) {
  const copy = reconcileCopyRef(item);
  if (copy) return <RecoveryCopyActions copy={copy} notePath={item.path} />;
  if (item.kind === "restoredFromServer") {
    return (
      <span className="health-missing-actions">
        <button
          type="button"
          className="ghost-pill sm"
          onClick={() => void useStore.getState().openNoteByPath(item.path)}
        >
          Open note
        </button>
      </span>
    );
  }
  return null;
}

function TrashRowActions({
  item,
  online,
  onRestored,
}: {
  item: TrashItem;
  online: boolean;
  onRestored: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setError(null);
    try {
      await authManager.api.restoreNote(item.docId);
    } catch (e) {
      setError(trashErrorMessage(e));
      return;
    }
    onRestored();
  };
  return (
    <>
      <span className="health-missing-actions">
        {online && (
          <TrashPreviewActions
            docId={item.docId}
            relPath={item.relPath}
            onPreview={openTrashPreview}
            onCompare={compareTrash}
          />
        )}
        <AsyncButton
          className="ghost-pill sm"
          disabled={!online}
          title={online ? "Bring it back for everyone." : "Reconnect to restore."}
          onClick={restore}
        >
          Restore
        </AsyncButton>
      </span>
      {error && (
        <p role="alert" className="auth-error health-missing-error">
          {error}
        </p>
      )}
    </>
  );
}

function rowMeta(row: ActivityRow, now: number): string {
  const when = relativeTime(row.at, now);
  if (row.type === "trash") {
    const by = row.item.deletedBy ? `by ${row.item.deletedBy.name} ` : "";
    return `${by}${when} · purges on ${formatDate(row.item.purgeAfter)}`;
  }
  if (row.type === "copy") return `${when} · ${formatBytes(row.copy.bytes)}`;
  return when;
}

function rowTitle(row: ActivityRow): string {
  if (row.type === "reconcile") return `${ACTIVITY_HINT.reconcile}\n${row.item.detail ?? row.path}`;
  if (row.type === "trash") return `${ACTIVITY_HINT.trash}\n${row.path}`;
  return `${ACTIVITY_HINT.copy}\n.context/trash/${row.copy.stamp}/${row.copy.relPath}`;
}

export function ActivityFeed() {
  const now = useNow();
  const [nonce, setNonce] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [reconcile, setReconcile] = useState<ReconcileItem[]>(() => reconcileReport.items());
  useEffect(() => reconcileReport.subscribe(setReconcile), []);
  const trash = useTrash(nonce);
  const { copies, error: copiesError } = useCopies(nonce);
  const pending = usePendingReviewCount();
  const refresh = () => setNonce((n) => n + 1);

  const rows = useMemo(
    () => buildActivity({ reconcile, trash: trash.listing?.items ?? [], copies: copies ?? [] }),
    [reconcile, trash.listing, copies],
  );

  return (
    <div className="activity-feed">
      <div className="activity-toolbar">
        {pending > 0 && (
          <button type="button" className="primary sm" onClick={openReviewTab}>
            {`Review changes (${pending.toLocaleString()})`}
          </button>
        )}
        <AsyncButton className="ghost-pill sm activity-refresh" onClick={refresh}>
          Refresh
        </AsyncButton>
      </div>
      {!trash.online && trash.listing && (
        <p className="muted">Deleted notes are the last known list. Reconnect to restore.</p>
      )}
      {(trash.error || copiesError) && (
        <p role="alert" className="auth-error health-missing-error">
          {trash.error ?? copiesError}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <div className="health-difference-group health-place-group">
          <ul>
            {rows.slice(0, limit).map((row) => (
              <li key={row.key}>
                <span className="health-place-row" title={rowTitle(row)}>
                  <span
                    className="health-pill"
                    data-tone={row.type === "trash" && row.item.hasUnsyncedContributions ? "warn" : undefined}
                  >
                    {row.label}
                  </span>
                  <PathText path={row.path} />
                  {row.type === "reconcile" && row.item.newPath && (
                    <>
                      <span className="muted" aria-label="renamed to">
                        →
                      </span>
                      <PathText path={row.item.newPath} />
                    </>
                  )}
                  {row.type === "trash" && row.item.hasUnsyncedContributions && (
                    <span
                      className="health-pill"
                      data-tone="warn"
                      title="Someone's edits arrived after it was deleted. Review before it is purged."
                    >
                      Has unseen edits
                    </span>
                  )}
                  <span className="muted" title={clockTime(row.at)}>
                    {rowMeta(row, now)}
                  </span>
                </span>
                {row.type === "reconcile" ? (
                  <ReconcileRowActions item={row.item} />
                ) : row.type === "trash" ? (
                  <TrashRowActions item={row.item} online={trash.online} onRestored={refresh} />
                ) : (
                  <RecoveryCopyActions
                    copy={{ stamp: row.copy.stamp, relPath: row.copy.relPath }}
                    modified={row.copy.modified}
                    onChanged={refresh}
                  />
                )}
              </li>
            ))}
          </ul>
          {rows.length > limit && (
            <button type="button" className="link-btn" onClick={() => setLimit(limit + PAGE)}>
              {`Show more (${(rows.length - limit).toLocaleString()} remaining)`}
            </button>
          )}
          {trash.listing?.truncated && (
            <p className="muted">Only the most recent deleted notes are listed.</p>
          )}
        </div>
      )}
    </div>
  );
}
