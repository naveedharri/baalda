import appIcon from "../assets/brand/app-icon.png";
import { BRAND_NAME } from "../lib/brand";
import type { UpdateState } from "../lib/updater";
import { AsyncButton } from "./AsyncButton";

/** The three steps the card ticks through: download, install, restart. */
const STEPS = ["Download", "Install", "Restart"] as const;

/** Bytes to the MB Finder shows (decimal), one decimal place. */
const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/**
 * Where an update stands, for the card: the step it is on (0 download,
 * 1 install, 2 restart) and one plain line. A download with no content
 * length says how much arrived instead of a percentage it cannot know.
 */
export function updateGateProgress(update: UpdateState): { step: 0 | 1 | 2; text: string; pct: number | null } {
  switch (update.phase) {
    case "checking":
      return { step: 0, text: "Checking for the update…", pct: null };
    case "available":
      return { step: 0, text: "Starting the download…", pct: null };
    case "downloading": {
      if (update.total > 0) {
        const pct = Math.min(100, Math.round((update.downloaded / update.total) * 100));
        return { step: 0, pct, text: `${pct}% · ${mb(update.downloaded)} of ${mb(update.total)} MB` };
      }
      return {
        step: 0,
        pct: null,
        text: update.downloaded > 0 ? `${mb(update.downloaded)} MB downloaded` : "Downloading…",
      };
    }
    case "installing":
      return { step: 1, text: "Installing…", pct: 100 };
    case "ready":
      return { step: 2, text: "Restarting…", pct: 100 };
    default:
      return { step: 0, text: "Getting the update…", pct: null };
  }
}

/**
 * The update wall's card (UpdateGate in App.tsx owns when it shows): the app
 * icon on the welcome screen's glow, a frosted card, the version, one line of
 * progress and three step chips. When it can't install, the same card says so
 * and offers Try again, Download manually and Reload.
 */
export function UpdateGateView({
  update,
  version,
  launching,
  required,
  working,
  onRetry,
  onDownloadManually,
  onReload,
}: {
  update: UpdateState;
  version: string | null;
  launching: boolean;
  required: string | null;
  working: boolean;
  onRetry: () => Promise<void>;
  onDownloadManually: () => void;
  onReload: () => void;
}) {
  const title = launching ? `Updating ${BRAND_NAME}` : "Update required";
  const progress = updateGateProgress(update);
  return (
    <div className="update-gate" role="alertdialog" aria-modal="true" aria-label={title}>
      <div className={`update-gate-card${working ? "" : " is-stopped"}`}>
        <span className="update-gate-icon" aria-hidden="true">
          <img src={appIcon} alt="" draggable={false} />
        </span>
        <h1>{title}</h1>
        {version && <span className="update-gate-version">v{version}</span>}
        {working ? (
          <>
            <p className="update-gate-status" role="status">
              {progress.text}
            </p>
            <ol className="update-gate-steps">
              {STEPS.map((label, i) => (
                <li
                  key={label}
                  className={i < progress.step ? "is-done" : i === progress.step ? "is-now" : undefined}
                  aria-current={i === progress.step ? "step" : undefined}
                >
                  <i aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            {required ? (
              <p>
                {BRAND_NAME} couldn&rsquo;t install the update to <strong>v{required}</strong>
                {"message" in update && update.message ? ` (${update.message})` : ""}. It tried
                twice on its own. Check your connection and try again. Your notes stay right
                where they are, on your disk.
              </p>
            ) : (
              <p>
                Your server needs a newer version of {BRAND_NAME} before this one can sync.
                Your notes and edits stay right where they are, on your disk, and sync as
                soon as the update is in.
              </p>
            )}
            <div className="update-gate-actions">
              <AsyncButton className="primary update-gate-cta" onClick={onRetry}>
                Try again
              </AsyncButton>
              {/* For when the updater itself cannot install (#251): the same
                  release, fetched by hand. */}
              <button className="ghost-pill lg" onClick={onDownloadManually}>
                Download manually
              </button>
              <button className="ghost-pill lg" onClick={onReload}>
                Reload
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
