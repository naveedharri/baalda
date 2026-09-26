/* Vault Settings → Health: the two offline-reconciliation sections.

   "Reconciled on reconnect" lists every item `sync/reconcileReport.ts` recorded
   this app session — what the reconnect banner summarised, one row per note.

   "Trash" is the server's soft-deleted notes for a synced vault, each with a
   Restore. Offline or signed out it keeps showing the last list it fetched,
   labelled as last known, and Restore waits for the connection. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { ApiError, type TrashItem, type TrashListing } from "../lib/api";
import { syncManager } from "../lib/sync/docSession";
import { reconcileReport, type ReconcileItem } from "../lib/sync/reconcileReport";
import { RECONCILE_KIND_LABEL, dedupeReconcileItems } from "../lib/reconcileSummary";
import { relativeTime, clockTime } from "../lib/health/format";
import { AsyncButton } from "./AsyncButton";
import { PathText, Section } from "./HealthShared";
import { reconcileFocusRequest } from "./ReconcileBanner";
import * as ipc from "../lib/ipc";
import { formatBytes } from "../lib/health/format";
import { RecoveryCopyActions, TrashPreviewActions } from "./RecoveryCopyActions";
import { groupCopies, reconcileCopyRef, stampTime } from "./recoveryCopies";
import { compareTrash, openTrashPreview } from "./recoveryActions";

/** Rows shown before "Show more", like the other Health lists. */
const PAGE = 20;

// ── Reconciled on reconnect ─────────────────────────────────────────────────

export function HealthReconciled({ now }: { now: number }) {
  const [items, setItems] = useState<ReconcileItem[]>(() => reconcileReport.items());
  const [limit, setLimit] = useState(PAGE);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => reconcileReport.subscribe(setItems), []);

  // Newest first; a retried record of the same outcome is one row.
  const rows = useMemo(() => dedupeReconcileItems(items).reverse(), [items]);

  useEffect(() => {
    if (!reconcileFocusRequest.pending) return;
    reconcileFocusRequest.pending = false;
    ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return (
    <div ref={ref} id="health-reconciled">
      <Section
        title="Reconciled on reconnect"
        description="What sync changed for you after being offline, since Baalda launched."
      >
        {rows.length === 0 ? (
          <p className="muted">Nothing was reconciled this session.</p>
        ) : (
          <div className="health-difference-group health-place-group">
            <ul>
              {rows.slice(0, limit).map((it) => (
                <li key={`${it.kind}:${it.docId ?? it.path}:${it.at}`}>
                  <span className="health-place-row" title={it.detail ?? it.path}>
                    <span className="health-pill">{RECONCILE_KIND_LABEL[it.kind]}</span>
                    <PathText path={it.path} />
                    {it.newPath && (
                      <>
                        <span className="muted" aria-label="renamed to">
                          →
                        </span>
                        <PathText path={it.newPath} />
                      </>
                    )}
                  </span>
                  <span className="health-missing-actions muted" title={clockTime(it.at)}>
                    {relativeTime(it.at, now)}
                  </span>
                  {(() => {
                    const copy = reconcileCopyRef(it);
                    if (copy) return <RecoveryCopyActions copy={copy} notePath={it.path} />;
                    // A restored note is a notice: nothing to compare, only the note.
                    if (it.kind === "restoredFromServer") {
                      return (
                        <span className="health-missing-actions">
                          <button
                            type="button"
                            className="ghost-pill sm"
                            onClick={() => {
                              useStore.getState().dismissSettings();
                              void useStore.getState().openNoteByPath(it.path);
                            }}
                          >
                            Open note
                          </button>
                        </span>
                      );
                    }
                    return null;
                  })()}
                </li>
              ))}
            </ul>
            {rows.length > limit && (
              <button type="button" className="link-btn" onClick={() => setLimit(limit + PAGE)}>
                {`Show more (${(rows.length - limit).toLocaleString()} remaining)`}
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Trash ───────────────────────────────────────────────────────────────────

/** Last listing per server vault id, this app session. What an offline or
 *  signed-out Health shows, labelled as last known. Never authorises anything. */
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
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function HealthTrash({ now }: { now: number }) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  // Same freshness rule as the inventory: only a connected vault is current.
  const online = hasSession && syncStatus === "synced";

  const cached = vaultId ? lastTrash.get(vaultId) : undefined;
  const [listing, setListing] = useState<TrashListing | null>(cached?.listing ?? null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.at ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(PAGE);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!vaultId) return;
    const c = lastTrash.get(vaultId);
    setListing(c?.listing ?? null);
    setFetchedAt(c?.at ?? null);
  }, [vaultId]);

  useEffect(() => {
    if (!syncEnabled || !vaultId || !online) return;
    let cancelled = false;
    setLoadError(null);
    authManager.api
      .listTrash(vaultId)
      .then((l) => {
        if (cancelled) return;
        const at = Date.now();
        lastTrash.set(vaultId, { listing: l, at });
        setListing(l);
        setFetchedAt(at);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(trashErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [syncEnabled, vaultId, online, nonce]);

  if (!syncEnabled || !vaultId) return null;

  const restore = async (item: TrashItem) => {
    setRowErrors((r) => {
      const next = { ...r };
      delete next[item.docId];
      return next;
    });
    try {
      await authManager.api.restoreNote(item.docId);
    } catch (e) {
      setRowErrors((r) => ({ ...r, [item.docId]: trashErrorMessage(e) }));
      return;
    }
    setNonce((n) => n + 1);
  };

  const items = listing?.items ?? [];
  const stale = !online && listing != null;
  const description = stale
    ? `Last known${fetchedAt ? `, ${relativeTime(fetchedAt, now)}` : ""}. Reconnect to restore.`
    : "Deleted notes stay here until they are purged. Restore brings a note back for everyone.";

  return (
    <Section
      title="Trash"
      description={description}
      right={
        online ? (
          <AsyncButton className="ghost-pill sm" onClick={() => setNonce((n) => n + 1)}>
            Refresh
          </AsyncButton>
        ) : undefined
      }
    >
      {loadError && (
        <p role="alert" className="auth-error health-missing-error">
          {loadError}
        </p>
      )}
      {listing == null ? (
        <p className="muted">
          {online ? "Loading Trash…" : "Trash is shown when Baalda is connected."}
        </p>
      ) : items.length === 0 ? (
        <p className="muted">Trash is empty.</p>
      ) : (
        <div className="health-difference-group health-place-group">
          <ul>
            {items.slice(0, limit).map((item) => (
              <li key={item.docId}>
                <span className="health-place-row" title={item.relPath}>
                  <PathText path={item.relPath} />
                  {item.hasUnsyncedContributions && (
                    <span
                      className="health-pill"
                      data-tone="warn"
                      title="Someone's edits arrived after it was deleted. Review before it is purged."
                    >
                      Has unseen edits
                    </span>
                  )}
                  <span className="muted">
                    {`Deleted ${item.deletedBy ? `by ${item.deletedBy.name} ` : ""}${relativeTime(Date.parse(item.deletedAt), now)} · purges on ${formatDate(item.purgeAfter)}`}
                  </span>
                </span>
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
                    onClick={() => restore(item)}
                  >
                    Restore
                  </AsyncButton>
                </span>
                {rowErrors[item.docId] && (
                  <p role="alert" className="auth-error health-missing-error">
                    {rowErrors[item.docId]}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {items.length > limit && (
            <button type="button" className="link-btn" onClick={() => setLimit(limit + PAGE)}>
              {`Show more (${(items.length - limit).toLocaleString()} remaining)`}
            </button>
          )}
          {listing.truncated && (
            <p className="muted">Only the most recent deleted notes are listed.</p>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Recovery copies (.context/trash on this device) ─────────────────────────

export function HealthRecoveryCopies({ now }: { now: number }) {
  const vault = useStore((s) => s.vault);
  const [copies, setCopies] = useState<ipc.TrashCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const epoch = vault?.epoch;

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    setError(null);
    ipc.listTrashCopies(epoch).then(
      (list) => !cancelled && setCopies(list),
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, nonce]);

  const groups = useMemo(() => groupCopies(copies ?? []), [copies]);
  if (!vault) return null;
  const refresh = () => setNonce((n) => n + 1);

  let shown = 0;
  return (
    <Section
      title="Recovery copies"
      description="Local text sync set aside on this device, in .context/trash. They never sync. Open, compare or restore one, or delete it."
      right={
        <AsyncButton className="ghost-pill sm" onClick={refresh}>
          Refresh
        </AsyncButton>
      }
    >
      {error && (
        <p role="alert" className="auth-error health-missing-error">
          {error}
        </p>
      )}
      {copies == null ? (
        <p className="muted">Loading…</p>
      ) : copies.length === 0 ? (
        <p className="muted">No recovery copies on this device.</p>
      ) : (
        <div className="health-difference-group health-place-group">
          {groups.map((g) => {
            if (shown >= limit) return null;
            const at = stampTime(g.stamp) ?? g.at;
            const rows = g.copies.slice(0, limit - shown);
            shown += rows.length;
            return (
              <div key={g.stamp}>
                <p className="muted" title={g.stamp}>
                  {`Saved ${relativeTime(at, now)} · ${clockTime(at)}`}
                </p>
                <ul>
                  {rows.map((c) => (
                    <li key={`${c.stamp}/${c.relPath}`}>
                      <span className="health-place-row" title={`.context/trash/${c.stamp}/${c.relPath}`}>
                        <PathText path={c.relPath} />
                        <span className="muted">{formatBytes(c.bytes)}</span>
                      </span>
                      <RecoveryCopyActions
                        copy={{ stamp: c.stamp, relPath: c.relPath }}
                        modified={c.modified}
                        onChanged={refresh}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {copies.length > limit && (
            <button type="button" className="link-btn" onClick={() => setLimit(limit + PAGE)}>
              {`Show more (${(copies.length - limit).toLocaleString()} remaining)`}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
