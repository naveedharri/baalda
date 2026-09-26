/* The right panel's Activity tab (RightPanel.tsx): ONE chronological feed of
   what happened to this vault's notes, merged by `activityRows.ts`. This file
   only renders; the data, fetch schedule, notice log and unread state live in
   `activitySource.tsx`, mounted once so the toolbar badge works while closed.

   The server Trash keeps its old rules: only a connected vault is current;
   offline or signed out it shows the last listing it fetched (per vault id,
   this app session) and Restore waits for the connection. */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import type { ShrinkEvent, TrashItem } from "../lib/api";
import { toast } from "../lib/toast";
import { syncManager } from "../lib/sync/docSession";
import type { ReconcileItem } from "../lib/sync/reconcileReport";
import { clockTime, formatBytes, relativeTime } from "../lib/health/format";
import { AsyncButton } from "./AsyncButton";
import { PathText } from "./HealthShared";
import { RecoveryCopyActions, TrashPreviewActions, useNoteExists } from "./RecoveryCopyActions";
import { reconcileCopyRef } from "./recoveryCopies";
import { compareTrash, openReviewTab, openTrashPreview } from "./recoveryActions";
import { usePendingReviewCount } from "./ReviewTab";
import {
  ACTIVITY_HINT,
  type ActivityRow,
  type FailedEntry,
} from "./activityRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { trashErrorMessage, useActivitySnapshot } from "./activitySource";
import { openCompare } from "./recoveryActions";
import { noteLabel } from "../lib/notePath";

/** Rows shown before "Show more", like the Health lists. */
const PAGE = 20;

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

function HeldRowActions({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  // Exactly the banner's handler (App.tsx BulkDeleteBanner).
  const answer = (a: "delete" | "restore") => {
    setBusy(true);
    void useStore
      .getState()
      .resolveBulkDelete(a)
      .catch((e) => console.warn("[sync] bulk delete answer failed", e))
      .finally(() => {
        setBusy(false);
        onDone();
      });
  };
  return (
    <span className="health-missing-actions">
      <button type="button" className="ghost-pill sm danger" disabled={busy} onClick={() => answer("delete")}>
        Delete for everyone
      </button>
      <button type="button" className="ghost-pill sm" disabled={busy} onClick={() => answer("restore")}>
        Restore
      </button>
    </span>
  );
}

function ShrunkRowActions({
  event,
  online,
  onDone,
}: {
  event: ShrinkEvent;
  online: boolean;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const compare = () =>
    openCompare(
      {
        label: `${noteLabel(event.relPath)} before it shrank`,
        source: { type: "version", docId: event.docId, versionId: event.versionId },
      },
      event.relPath,
    );
  const restore = async () => {
    setConfirm(false);
    try {
      await authManager.api.revertNoteToVersion(event.docId, event.versionId);
      toast(`Restored ${noteLabel(event.relPath)} to its text from before it shrank.`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
    onDone();
  };
  if (event.deleted) return null;
  return (
    <>
      <span className="health-missing-actions">
        <button type="button" className="ghost-pill sm" disabled={!online} onClick={compare}>
          Compare
        </button>
        <button
          type="button"
          className="ghost-pill sm"
          disabled={!online}
          title={online ? "Put the text from before back, for everyone." : "Reconnect to restore."}
          onClick={() => setConfirm(true)}
        >
          Restore version
        </button>
      </span>
      {confirm && (
        <ConfirmDialog
          title="Restore this version?"
          confirmLabel="Restore version"
          onConfirm={restore}
          onCancel={() => setConfirm(false)}
        >
          The note goes back to its text from before it shrank, for everyone. The current text is
          kept as a version, so this can be undone from Version history.
        </ConfirmDialog>
      )}
    </>
  );
}

function OpenNoteButton({ path }: { path: string }) {
  return (
    <button
      type="button"
      className="ghost-pill sm"
      onClick={() => void useStore.getState().openNoteByPath(path)}
    >
      Open note
    </button>
  );
}

function GrantRowActions({ paths }: { paths: readonly string[] }) {
  const first = paths[0] ?? null;
  const readable = useNoteExists(first) === true;
  if (!first || !readable) return null;
  return (
    <span className="health-missing-actions">
      <OpenNoteButton path={first} />
    </span>
  );
}

function FailedRowActions({ failure, onDone }: { failure: FailedEntry; onDone: () => void }) {
  const exists = useNoteExists(failure.path || null) === true;
  if (!exists && !failure.retryable) return null;
  return (
    <span className="health-missing-actions">
      {exists && <OpenNoteButton path={failure.path} />}
      {failure.retryable && failure.docId && (
        // Health's retry handler (useVaultHealth `retryDoc`).
        <AsyncButton
          className="ghost-pill sm"
          onClick={async () => {
            await syncManager.retryDoc(failure.docId as string);
            onDone();
          }}
        >
          Retry
        </AsyncButton>
      )}
    </span>
  );
}

function rowMeta(row: ActivityRow, now: number): string {
  const when = relativeTime(row.at, now);
  if (row.type === "trash") {
    const by = row.item.deletedBy ? `by ${row.item.deletedBy.name} ` : "";
    return `${by}${when} · purges on ${formatDate(row.item.purgeAfter)}`;
  }
  if (row.type === "copy") return `${when} · ${formatBytes(row.copy.bytes)}`;
  if (row.type === "held") return "Waiting for your answer";
  if (row.type === "shrunk" || row.type === "access" || row.type === "failed") {
    return row.path ? `${row.text} · ${when}` : when;
  }
  return when;
}

function rowTitle(row: ActivityRow): string {
  if (row.type === "reconcile") return `${ACTIVITY_HINT.reconcile}\n${row.item.detail ?? row.path}`;
  if (row.type === "trash") return `${ACTIVITY_HINT.trash}\n${row.path}`;
  if (row.type === "held") return ACTIVITY_HINT.held;
  if (row.type === "shrunk") {
    return `${ACTIVITY_HINT.shrunk}${row.event.deleted ? "\nThe note is deleted now." : ""}\n${row.path}`;
  }
  if (row.type === "access") {
    if (row.event.kind === "granted") {
      const paths = row.event.paths ?? [];
      const more = row.event.count - paths.length;
      return [ACTIVITY_HINT.access, ...paths, ...(more > 0 ? [`and ${more.toLocaleString()} more`] : [])].join("\n");
    }
    return `${ACTIVITY_HINT.access}\n${row.path}`;
  }
  if (row.type === "failed") return `${ACTIVITY_HINT.failed}\n${row.text}`;
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
  const [limit, setLimit] = useState(PAGE);
  const snap = useActivitySnapshot();
  const { rows, schedule, updating, activeFailures } = snap;
  const pending = usePendingReviewCount();
  const trash = { online: snap.trashOnline };

  // Opening the panel on Activity refreshes (the host also schedules on the
  // tab switch; the debounce makes the two one fetch).
  useEffect(() => {
    schedule();
  }, [schedule]);

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
      {!snap.trashOnline && snap.trashCached && (
        <p className="muted activity-note">Deleted notes are the last known list. Reconnect to restore.</p>
      )}
      {snap.error && (
        <p role="alert" className="auth-error health-missing-error">
          {snap.error}
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
                  data-tone={
                    (row.type === "trash" && row.item.hasUnsyncedContributions) ||
                    row.type === "held" ||
                    row.type === "shrunk" ||
                    row.type === "failed"
                      ? "warn"
                      : undefined
                  }
                >
                  {row.label}
                </span>
                <span className="activity-row-main" title={rowTitle(row)}>
                  <span className="activity-row-path">
                    {row.path ? <PathText path={row.path} /> : "text" in row ? <span>{row.text}</span> : null}
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
                  ) : row.type === "held" ? (
                    <HeldRowActions onDone={schedule} />
                  ) : row.type === "shrunk" ? (
                    <ShrunkRowActions event={row.event} online={trash.online} onDone={schedule} />
                  ) : row.type === "failed" ? (
                    activeFailures.has(row.key) ? <FailedRowActions failure={row.failure} onDone={schedule} /> : null
                  ) : row.type === "access" ? (
                    row.event.kind === "granted" ? <GrantRowActions paths={row.event.paths ?? []} /> : null
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
          {snap.trashTruncated && (
            <p className="muted activity-note">Only the most recent deleted notes are listed.</p>
          )}
        </>
      )}
    </div>
  );
}
