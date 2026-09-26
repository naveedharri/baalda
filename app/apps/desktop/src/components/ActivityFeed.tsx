/* The right panel's Activity tab (RightPanel.tsx): ONE chronological feed of
   what happened to this vault's notes — the reconnect report, the server's
   Trash, and local recovery copies — merged by `activityRows.ts`. It replaces
   the three headed sections that used to live in Vault Settings → Health.

   The server Trash keeps its old rules: only a connected vault is current;
   offline or signed out it shows the last listing it fetched (per vault id,
   this app session) and Restore waits for the connection. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** Quiet-period before a refresh runs, so a burst of triggers is one fetch. */
const REFRESH_DEBOUNCE_MS = 250;
/** Background refresh while the tab is visible. */
const REFRESH_INTERVAL_MS = 60_000;
/** "Updating…" appears only for a fetch slower than this. */
const SLOW_FETCH_MS = 400;

/** One debounced refresh counter: every trigger calls `schedule`, and a burst
 *  of them bumps `nonce` once. */
function useAutoRefresh() {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setNonce((n) => n + 1);
    }, REFRESH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return { nonce, schedule };
}

/** True once `busy` has held for SLOW_FETCH_MS; false as soon as it clears. */
function useSlow(busy: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const id = window.setTimeout(() => setSlow(true), SLOW_FETCH_MS);
    return () => window.clearTimeout(id);
  }, [busy]);
  return slow;
}

/** The server Trash for the open synced vault, or null (local vault / never fetched).
 *  Fetches on `nonce` only; the parent bumps it when the vault comes online. */
function useTrash(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const online = hasSession && syncStatus === "synced";
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const cached = vaultId ? lastTrash.get(vaultId) : undefined;
  const [listing, setListing] = useState<TrashListing | null>(cached?.listing ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setListing(vaultId ? (lastTrash.get(vaultId)?.listing ?? null) : null);
  }, [vaultId]);

  useEffect(() => {
    if (!syncEnabled || !vaultId || !onlineRef.current) return;
    let cancelled = false;
    setBusy(true);
    authManager.api.listTrash(vaultId).then(
      (l) => {
        if (cancelled) return;
        lastTrash.set(vaultId, { listing: l, at: Date.now() });
        setListing(l);
        setError(null);
        setBusy(false);
      },
      (e) => {
        if (cancelled) return;
        setError(trashErrorMessage(e));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [syncEnabled, vaultId, nonce]);

  return { listing: syncEnabled && vaultId ? listing : null, error, online, busy };
}

function useCopies(nonce: number) {
  const epoch = useStore((s) => s.vault?.epoch);
  const hasVault = useStore((s) => s.vault != null);
  const [copies, setCopies] = useState<ipc.TrashCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!hasVault) return;
    let cancelled = false;
    setBusy(true);
    ipc.listTrashCopies(epoch).then(
      (list) => {
        if (cancelled) return;
        setCopies(list);
        setError(null);
        setBusy(false);
      },
      (e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [hasVault, epoch, nonce]);
  return { copies, error, busy };
}

function ReconcileRowActions({ item, onChanged }: { item: ReconcileItem; onChanged: () => void }) {
  const copy = reconcileCopyRef(item);
  if (copy) return <RecoveryCopyActions copy={copy} notePath={item.path} onChanged={onChanged} />;
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

/** The empty state's muted glyph: the same activity-log mark as the tab. */
function ActivityLogIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="6" r="1.4" />
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="5" cy="18" r="1.4" />
      <path d="M10 6h10M10 12h10M10 18h7" />
    </svg>
  );
}

export function ActivityFeed() {
  const now = useNow();
  const { nonce, schedule } = useAutoRefresh();
  const [limit, setLimit] = useState(PAGE);
  const [reconcile, setReconcile] = useState<ReconcileItem[]>(() => reconcileReport.items());
  const trash = useTrash(nonce);
  const { copies, error: copiesError, busy: copiesBusy } = useCopies(nonce);
  const pending = usePendingReviewCount();
  const updating = useSlow(trash.busy || copiesBusy);

  // A new reconcile item usually means a recovery copy was just written, and
  // a resolved one may have restored or deleted a copy: either way, refetch.
  useEffect(
    () =>
      reconcileReport.subscribe((items) => {
        setReconcile(items);
        schedule();
      }),
    [schedule],
  );

  // The vault channel reaching "synced" (connect, reconnect, a finished pull).
  const vaultSyncStatus = useStore((s) => s.vaultSyncStatus);
  useEffect(() => {
    if (vaultSyncStatus === "synced") schedule();
  }, [vaultSyncStatus, schedule]);

  // A gentle background refresh while the app window is visible. Mounting
  // (the panel opening on Activity) fetches through the hooks' first run.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") schedule();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [schedule]);

  const rows = useMemo(
    () => buildActivity({ reconcile, trash: trash.listing?.items ?? [], copies: copies ?? [] }),
    [reconcile, trash.listing, copies],
  );

  const showToolbar = pending > 0 || updating;
  return (
    <div className="activity-feed">
      {showToolbar && (
        <div className="activity-toolbar">
          {pending > 0 && (
            <button type="button" className="primary sm" onClick={openReviewTab}>
              {`Review changes (${pending.toLocaleString()})`}
            </button>
          )}
          {updating && (
            <span className="activity-updating muted" role="status">
              Updating…
            </span>
          )}
        </div>
      )}
      {!trash.online && trash.listing && (
        <p className="muted activity-note">Deleted notes are the last known list. Reconnect to restore.</p>
      )}
      {(trash.error || copiesError) && (
        <p role="alert" className="auth-error health-missing-error">
          {trash.error ?? copiesError}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="activity-empty">
          <span className="activity-empty-icon">
            <ActivityLogIcon />
          </span>
          <p className="activity-empty-title">No activity yet.</p>
          <p className="muted activity-empty-hint">
            Changes sync made for you, deleted notes and recovery copies will appear here.
          </p>
        </div>
      ) : (
        <>
          <ul className="activity-list">
            {rows.slice(0, limit).map((row) => (
              <li key={row.key} className="activity-row">
                <span
                  className="health-pill activity-row-chip"
                  data-tone={row.type === "trash" && row.item.hasUnsyncedContributions ? "warn" : undefined}
                >
                  {row.label}
                </span>
                <span className="activity-row-main" title={rowTitle(row)}>
                  <span className="activity-row-path">
                    <PathText path={row.path} />
                    {row.type === "reconcile" && row.item.newPath && (
                      <>
                        <span className="muted" aria-label="renamed to">
                          →
                        </span>
                        <PathText path={row.item.newPath} />
                      </>
                    )}
                  </span>
                  <span className="activity-row-meta muted" title={clockTime(row.at)}>
                    {rowMeta(row, now)}
                    {row.type === "trash" && row.item.hasUnsyncedContributions && (
                      <span
                        className="health-pill"
                        data-tone="warn"
                        title="Someone's edits arrived after it was deleted. Review before it is purged."
                      >
                        Has unseen edits
                      </span>
                    )}
                  </span>
                </span>
                <div className="activity-row-actions">
                  {row.type === "reconcile" ? (
                    <ReconcileRowActions item={row.item} onChanged={schedule} />
                  ) : row.type === "trash" ? (
                    <TrashRowActions item={row.item} online={trash.online} onRestored={schedule} />
                  ) : (
                    <RecoveryCopyActions
                      copy={{ stamp: row.copy.stamp, relPath: row.copy.relPath }}
                      modified={row.copy.modified}
                      onChanged={schedule}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
          {rows.length > limit && (
            <button type="button" className="link-btn activity-more" onClick={() => setLimit(limit + PAGE)}>
              {`Show more (${(rows.length - limit).toLocaleString()} remaining)`}
            </button>
          )}
          {trash.listing?.truncated && (
            <p className="muted activity-note">Only the most recent deleted notes are listed.</p>
          )}
        </>
      )}
    </div>
  );
}
