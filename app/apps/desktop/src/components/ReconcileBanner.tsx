import { useEffect, useMemo, useState } from "react";
import { Banner } from "./Banner";
import { useStore } from "../store";
import { reconcileReport, type ReconcileItem } from "../lib/sync/reconcileReport";
import { summarizeReconcile } from "../lib/reconcileSummary";

/** A burst of records (one reconnect reconciles many notes) settles into ONE
 *  banner instead of re-rendering a growing one per note. */
export const RECONCILE_BANNER_DEBOUNCE_MS = 600;

/** How many report items the user has already dismissed this session. Module
 *  state on purpose: the banner remounting (a vault switch re-renders the
 *  chrome) must not re-announce what was dismissed. */
let dismissedUpTo = 0;

/**
 * Asks Vault Health to scroll to the "Reconciled on reconnect" section when it
 * next mounts. Set by the banner's Details button, consumed once by
 * `HealthReconciled`.
 */
export const reconcileFocusRequest = { pending: false };

/**
 * What sync did on the user's behalf when it reconnected: a note put back, a
 * teammate's delete that sent offline edits to Trash, a clash rename. One line
 * per kind, one banner at a time. Dismiss drains the report; anything recorded
 * later raises the banner again with only the new items.
 */
export function ReconcileBanner() {
  const [items, setItems] = useState<ReconcileItem[]>(() =>
    reconcileReport.items().slice(dismissedUpTo),
  );
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = reconcileReport.subscribe((all) => {
      if (all.length < dismissedUpTo) dismissedUpTo = 0;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setItems(all.slice(dismissedUpTo)),
        RECONCILE_BANNER_DEBOUNCE_MS,
      );
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const lines = useMemo(() => summarizeReconcile(items), [items]);

  const dismiss = () => {
    reconcileReport.drain();
    dismissedUpTo = reconcileReport.items().length;
    setItems([]);
  };

  const details = () => {
    reconcileFocusRequest.pending = true;
    useStore.getState().requestSettings("health");
    dismiss();
  };

  return (
    <Banner show={lines.length > 0} role="status" className="reconcile-banner">
      <span className="reconcile-banner-lines">
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
