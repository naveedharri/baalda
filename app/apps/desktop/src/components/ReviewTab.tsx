/* "Review changes": one editor-area tab that walks every reconnect item with
   something to compare. The main area shows the compare for the selected item;
   the list on the right shows every item with its kind, path, size of the
   difference and pending/resolved state. Resolved state is per app session
   (`reviewModel.ts reviewState`), which is also what the banner counts. */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { noteLabel } from "../lib/notePath";
import { reconcileReport, type ReconcileItem } from "../lib/sync/reconcileReport";
import { RECONCILE_KIND_LABEL } from "../lib/reconcileSummary";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { CompareBody, ReadOnlyText } from "./CompareTab";
import { PathText } from "./HealthShared";
import { useNoteExists } from "./RecoveryCopyActions";
import { copyTabTitle, stampTime } from "./recoveryCopies";
import {
  deleteCopy,
  openCopy,
  openReviewTab,
  restoreCopyAsSibling,
  restoreCopyReplace,
} from "./recoveryActions";
import { loadSource } from "./textSources";
import { formatLineChanges, lineChanges, type LineChanges } from "./lineChanges";
import {
  nextPendingKey,
  pendingItems,
  planResolveAll,
  reviewItems,
  reviewState,
  type Resolution,
  type ResolvedMap,
  type ReviewItem,
} from "./reviewModel";
import type { TextSource } from "./virtualTabs";

/** The one-line header of a "Restored" row, which has nothing to diff. */
export const RESTORED_NOTICE =
  "Restored from the server on launch. Nothing to compare: this note was missing on this device and came back unchanged. Delete it again to remove it for everyone.";

/** A clash rename has two notes to keep; a restored note has one. */
export function keepLabel(kind: ReviewItem["kind"]): string {
  return kind === "renamedConflict" ? "Keep both" : "Keep";
}

/** Line counts are computed for at most this many rows up front. */
const COUNT_LIMIT = 200;

const RESOLUTION_LABEL: Record<Resolution, string> = {
  kept: "Kept current",
  restored: "Copy restored",
  restoredSibling: "Restored as new note",
  skipped: "Skipped",
};

export function useReviewState(): ResolvedMap {
  const [m, setM] = useState<ResolvedMap>(() => reviewState.get());
  useEffect(() => reviewState.subscribe(setM), []);
  return m;
}

function useReportItems(): ReconcileItem[] {
  const [items, setItems] = useState<ReconcileItem[]>(() => reconcileReport.items());
  useEffect(() => reconcileReport.subscribe(setItems), []);
  return items;
}

function sidesOf(it: ReviewItem): { left: TextSource; right: TextSource } | null {
  if (it.copy) return { left: { type: "copy", ...it.copy }, right: { type: "note", path: it.path } };
  if (it.otherPath) return { left: { type: "note", path: it.path }, right: { type: "note", path: it.otherPath } };
  return null;
}

function useLineCounts(items: readonly ReviewItem[], nonce: number): Record<string, LineChanges> {
  const epoch = useStore((s) => s.vault?.epoch);
  const [counts, setCounts] = useState<Record<string, LineChanges>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const it of items.slice(0, COUNT_LIMIT)) {
        const sides = sidesOf(it);
        if (!sides) continue;
        try {
          const [a, b] = await Promise.all([loadSource(sides.left, epoch), loadSource(sides.right, epoch)]);
          if (cancelled) return;
          setCounts((c) => ({ ...c, [it.key]: lineChanges(a, b) }));
        } catch {
          // A side that cannot load (the note was deleted) has no count.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, epoch, nonce]);
  return counts;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ItemView({
  item,
  resolution,
  onResolved,
}: {
  item: ReviewItem;
  resolution: Resolution | undefined;
  onResolved: (how: Resolution) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const noteExists = useNoteExists(item.path, nonce);
  const run = async (fn: () => Promise<Resolution>) => {
    setError(null);
    try {
      onResolved(await fn());
      setNonce((n) => n + 1);
    } catch (e) {
      setError(errText(e));
    }
  };
  const at = item.copy ? stampTime(item.copy.stamp) ?? item.at : item.at;

  let body;
  if (item.copy && noteExists) {
    body = (
      <CompareBody
        key={item.key}
        left={{ label: copyTabTitle(item.copy.relPath, at), source: { type: "copy", ...item.copy } }}
        right={{ label: `Current: ${noteLabel(item.path)}`, source: { type: "note", path: item.path } }}
        nonce={nonce}
      />
    );
  } else if (item.copy) {
    body = (
      <div className="vtab-view">
        <div className="vtab-header">
          <span className="vtab-label">
            <strong>{copyTabTitle(item.copy.relPath, at)}</strong>
            {noteExists === false ? " · The note no longer exists here. This is your version." : ""}
          </span>
        </div>
        <ReadOnlyText source={{ type: "copy", ...item.copy }} nonce={nonce} />
      </div>
    );
  } else if (item.otherPath) {
    body = (
      <CompareBody
        key={item.key}
        left={{ label: noteLabel(item.path), source: { type: "note", path: item.path } }}
        right={{ label: noteLabel(item.otherPath), source: { type: "note", path: item.otherPath } }}
        nonce={nonce}
      />
    );
  } else {
    body = (
      <div className="vtab-view">
        <div className="vtab-header">
          <span className="vtab-label" title={RESTORED_NOTICE}>
            <strong>{noteLabel(item.path)}</strong>
            {` · ${RESTORED_NOTICE}`}
          </span>
        </div>
        <ReadOnlyText source={{ type: "note", path: item.path }} nonce={nonce} />
      </div>
    );
  }

  const copy = item.copy;
  return (
    <div className="review-main">
      <div className="review-compare">{body}</div>
      <div className="review-actions">
        {resolution && <span className="health-pill">{RESOLUTION_LABEL[resolution]}</span>}
        {copy ? (
          <>
            <AsyncButton
              className="ghost-pill sm"
              title="Keep the note as it is and delete this copy."
              onClick={() =>
                run(async () => {
                  await deleteCopy(copy);
                  return "kept";
                })
              }
            >
              Keep current
            </AsyncButton>
            {noteExists && (
              <AsyncButton
                className="ghost-pill sm"
                title="Put this copy's text into the note, then delete the copy."
                onClick={() =>
                  run(async () => {
                    await restoreCopyReplace(copy, item.path);
                    await deleteCopy(copy);
                    openReviewTab();
                    return "restored";
                  })
                }
              >
                Restore this copy
              </AsyncButton>
            )}
            <AsyncButton
              className="ghost-pill sm"
              title="Create a new note beside the original with this copy's text."
              onClick={() =>
                run(async () => {
                  await restoreCopyAsSibling(copy);
                  openReviewTab();
                  return "restoredSibling";
                })
              }
            >
              Restore as sibling
            </AsyncButton>
            <button type="button" className="ghost-pill sm" onClick={() => openCopy(copy)}>
              Open copy
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ghost-pill sm"
              onClick={() => void useStore.getState().openNoteByPath(item.path)}
            >
              Open note
            </button>
            {item.otherPath && (
              <button
                type="button"
                className="ghost-pill sm"
                onClick={() => void useStore.getState().openNoteByPath(item.otherPath!)}
              >
                Open other note
              </button>
            )}
            <AsyncButton className="ghost-pill sm" onClick={() => run(async () => "kept")}>
              {keepLabel(item.kind)}
            </AsyncButton>
          </>
        )}
        <AsyncButton
          className="ghost-pill sm"
          title={copy ? "Mark as reviewed and keep the copy in .context/trash." : "Mark as reviewed."}
          onClick={() => run(async () => "skipped")}
        >
          Skip
        </AsyncButton>
      </div>
      {error && (
        <p role="alert" className="auth-error vtab-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReviewTab() {
  const report = useReportItems();
  const resolved = useReviewState();
  const items = useMemo(() => reviewItems(report), [report]);
  const [selected, setSelected] = useState<string | null>(null);
  const [countNonce, setCountNonce] = useState(0);
  const counts = useLineCounts(items, countNonce);
  const [confirmAll, setConfirmAll] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const pending = pendingItems(items, resolved);

  const current =
    items.find((it) => it.key === selected) ??
    pending[0] ??
    items[0] ??
    null;

  const resolveCurrent = (how: Resolution) => {
    if (!current) return;
    const next = new Map(resolved);
    next.set(current.key, how);
    reviewState.set(next);
    setSelected(nextPendingKey(items, next, current.key) ?? current.key);
    setCountNonce((n) => n + 1);
  };

  const plan = planResolveAll(items, resolved);
  const resolveAll = async () => {
    setAllError(null);
    const failed: string[] = [];
    const next = new Map(resolved);
    for (const it of pending) {
      try {
        if (it.copy) await deleteCopy(it.copy);
        next.set(it.key, "kept");
      } catch (e) {
        failed.push(`${noteLabel(it.path)}: ${errText(e)}`);
      }
    }
    reviewState.set(next);
    setConfirmAll(false);
    if (failed.length) setAllError(`Some copies could not be deleted. ${failed.join(" · ")}`);
  };

  return (
    <div className="review-tab">
      <div className="review-body">
        {current ? (
          <ItemView
            key={current.key}
            item={current}
            resolution={resolved.get(current.key)}
            onResolved={resolveCurrent}
          />
        ) : (
          <p className="muted vtab-status">Nothing to review from this session.</p>
        )}
      </div>
      <aside className="review-list" aria-label="Changes to review">
        <div className="review-list-header">
          <span>
            {pending.length === 0
              ? "All resolved"
              : `${pending.length.toLocaleString()} of ${items.length.toLocaleString()} to review`}
          </span>
          {pending.length > 0 && (
            <button type="button" className="ghost-pill sm" onClick={() => setConfirmAll(true)}>
              Resolve all
            </button>
          )}
        </div>
        {allError && (
          <p role="alert" className="auth-error vtab-error">
            {allError}
          </p>
        )}
        <ul>
          {items.map((it) => {
            const how = resolved.get(it.key);
            const c = counts[it.key];
            return (
              <li key={it.key}>
                <button
                  type="button"
                  className={`review-row${current?.key === it.key ? " active" : ""}${how ? " resolved" : ""}`}
                  aria-current={current?.key === it.key}
                  onClick={() => setSelected(it.key)}
                >
                  <span className="health-pill">{RECONCILE_KIND_LABEL[it.kind]}</span>
                  <PathText path={it.path} />
                  <span className="review-row-meta muted">
                    {c ? formatLineChanges(c) : ""}
                    {c ? " · " : ""}
                    {how ? RESOLUTION_LABEL[how] : "Pending"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      {confirmAll && (
        <ConfirmDialog
          title="Resolve all changes?"
          confirmLabel="Resolve all"
          tone="danger"
          onConfirm={resolveAll}
          onCancel={() => setConfirmAll(false)}
        >
          {plan.copiesToDelete.length === 0
            ? `Keep the current version of ${pending.length === 1 ? "1 note" : `${pending.length.toLocaleString()} notes`}. No copies will be deleted.`
            : `Keep the current version of every pending note. ${plan.copiesToDelete.length === 1 ? "1 copy" : `${plan.copiesToDelete.length.toLocaleString()} copies`} in .context/trash will be deleted from this device.`}
        </ConfirmDialog>
      )}
    </div>
  );
}
