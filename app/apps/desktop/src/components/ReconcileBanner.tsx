import { useEffect, useMemo, useState } from "react";
import { Banner } from "./Banner";
import { useStore } from "../store";
import { reconcileReport, type ReconcileItem } from "../lib/sync/reconcileReport";
import { summarizeReconcile } from "../lib/reconcileSummary";
import { isReadOnlyRejection } from "../lib/sync/readOnlyRejections";
import { pendingItems, reviewItems, reviewKey } from "./reviewModel";
import { useReviewState } from "./ReviewTab";
import { useReviewPersistence } from "./useReviewPersistence";

/** A burst of records (one reconnect reconciles many notes) settles into ONE
 *  banner instead of re-rendering a growing one per note. */
export const RECONCILE_BANNER_DEBOUNCE_MS = 600;

/** The report items the user has already dismissed this session, by identity
 *  (the report can drop items when access comes back, so an index would shift).
 *  Module state on purpose: the banner remounting (a vault switch re-renders
 *  the chrome) must not re-announce what was dismissed. */
const dismissed = new WeakSet<ReconcileItem>();

/** What the banner announces: this session's new items only. Items seeded from
 *  the saved review were announced the session they happened in; raising them
 *  again on every launch and vault switch is what made the banner unkillable.
 *  A rejected read-only edit was already told once by a transient toast; it
 *  stays in Activity but never raises this persistent bar. */
const announce = (all: readonly ReconcileItem[]) =>
  all.filter((it) => !it.seeded && !dismissed.has(it) && !isReadOnlyRejection(it));

/** The user removed their own access: their copy is noted, nothing to review. */
const isQuiet = (it: ReconcileItem) => it.kind === "selfRevoked";


/**
 * What sync did on the user's behalf when it reconnected: a note put back, a
 * teammate's delete that sent offline edits to Trash, a clash rename. One line
 * per kind, one banner at a time. Dismiss drains the report; anything recorded
 * later raises the banner again with only the new items. Details opens the
 * Activity panel, where the review lives; only Dismiss hides the banner for
 * this session.
 */
export function ReconcileBanner() {
  useReviewPersistence();
  const [items, setItems] = useState<ReconcileItem[]>(() => announce(reconcileReport.items()));
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = reconcileReport.subscribe((all) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setItems(announce(all)),
        RECONCILE_BANNER_DEBOUNCE_MS,
      );
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const resolved = useReviewState();
  // Resolved items leave the summary, so the banner counts down as the user
  // works through the review; what has nothing to review stays as it was.
  const unresolved = useMemo(
    () => items.filter((it) => !resolved.has(reviewKey(it))),
    [items, resolved],
  );
  const lines = useMemo(() => summarizeReconcile(unresolved), [unresolved]);
  // A self-made revocation still lists its copy in Activity, but it is not a
  // "change to review": the user did it a moment ago, on purpose.
  const reviewable = useMemo(() => reviewItems(items.filter((it) => !isQuiet(it))), [items]);
  const pendingReview = pendingItems(reviewable, resolved).length;
  const quiet = lines.length > 0 && lines.every((l) => l.kind === "selfRevoked") && pendingReview === 0;
  // Notices (restored notes, kept folders) are never reviewable: a launch with
  // only notices shows its sentences with no review count.
  const allResolved = reviewable.length > 0 && pendingReview === 0;

  const dismiss = () => {
    reconcileReport.drain();
    for (const it of reconcileReport.items()) dismissed.add(it);
    setItems([]);
  };

  // Details opens the right panel's Activity tab, where every item is listed with
  // its actions. Like before, it also dismisses the banner for this session.
  const details = () => {
    useStore.getState().openRightPanel("activity");
    dismiss();
  };

  return (
    <Banner
      show={lines.length > 0 || pendingReview > 0 || allResolved}
      role="status"
      className={quiet ? "reconcile-banner reconcile-banner--quiet" : "reconcile-banner"}
    >
      <span className="reconcile-banner-lines">
        {allResolved && <span className="reconcile-banner-line">All resolved.</span>}
        {pendingReview > 0 && (
          <span className="reconcile-banner-line">
            {`${pendingReview.toLocaleString()} ${pendingReview === 1 ? "change" : "changes"} to review.`}
          </span>
        )}
        {lines.map((l) => (
          <span key={l.kind} className="reconcile-banner-line">
            {l.text}
          </span>
        ))}
      </span>
      <div className="banner-actions">
        <button onClick={details}>Details</button>
        <button className="secondary" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </Banner>
  );
}
