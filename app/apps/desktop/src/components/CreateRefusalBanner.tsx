import { Banner } from "./Banner";
import {
  createRefusalBannerText,
  groupCreateRefusals,
  type CreateRefusalInput,
} from "../lib/sync/createRefusals";

/**
 * Should the "new notes aren't syncing" strip be up?
 *
 * Unlike an ordinary per-note failure (Health only), a create the server refuses
 * for access is silent everywhere else: edits to existing notes keep syncing,
 * so a script or scheduled task can write new files into a view-only folder for
 * days before anyone notices teammates see none of them. Up whenever at least
 * one such refusal stands; Dismiss silences the current run only, like
 * `noteLimitBanner`.
 */
export function createRefusalBanner(args: {
  syncEnabled: boolean;
  /** `syncManager.registry.heldRefusals()`. */
  refusals: readonly CreateRefusalInput[];
  /** Identity of the current failed run (`store.failedRunToken`). */
  runToken: number;
  /** The run the user dismissed, or null when they have dismissed none. */
  dismissedRunToken: number | null;
}): { lead: string; detail: string } | null {
  const { syncEnabled, refusals, runToken, dismissedRunToken } = args;
  if (!syncEnabled) return null;
  if (dismissedRunToken != null && dismissedRunToken === runToken) return null;
  return createRefusalBannerText(groupCreateRefusals(refusals));
}

/** Presentational, reusing the shared `Banner` shape like `NoteLimitBannerView`. */
export function CreateRefusalBannerView({
  text,
  onShow,
  onDismiss,
}: {
  text: { lead: string; detail: string } | null;
  onShow: () => void;
  onDismiss: () => void;
}) {
  return (
    <Banner show={text != null} className="note-limit-banner" role="alert">
      <span>
        <strong>{text?.lead}</strong> {text?.detail}
      </span>
      <div className="banner-actions">
        <button className="primary" onClick={onShow}>
          Show
        </button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </Banner>
  );
}
