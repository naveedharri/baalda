import { useEffect } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import {
  BACKEND_CHECK_INTERVAL_MS,
  backendStatus,
  primeServerFeatures,
} from "../lib/serverFeatures";

/** Copy for the two audiences: a self-hoster can act, a managed user waits. */
export const BACKEND_BEHIND_SELF_HOSTED =
  "Your Baalda backend is behind this app. Update your self-hosted server (your Railway Baalda backend project) to keep sync working.";
export const BACKEND_BEHIND_MANAGED =
  "The Baalda server is being updated. Some sync features are paused until it finishes.";

/**
 * Polls `/health` and mirrors the verdict into the store. Re-runs when the
 * server URL, the signed-in user or the open vault changes, and every
 * {@link BACKEND_CHECK_INTERVAL_MS} while mounted. A failed check writes null
 * (unknown), so a flaky network can never raise the notice.
 */
function useBackendStatusPoll(): void {
  const serverUrl = useStore((s) => s.serverUrl);
  const userId = useStore((s) => s.session?.user.id ?? null);
  const vaultRoot = useStore((s) => s.vault?.path ?? null);
  const setBackendStatus = useStore((s) => s.setBackendStatus);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const health = await authManager.api.getHealth(serverUrl);
      // The sync layer reads the same answer (`serverFeatures`): no second poll.
      primeServerFeatures(serverUrl, health);
      if (!cancelled) setBackendStatus(backendStatus(health, serverUrl));
    };
    // A URL change must not keep showing the previous server's verdict.
    setBackendStatus(null);
    void check();
    const timer = setInterval(() => void check(), BACKEND_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverUrl, userId, vaultRoot, setBackendStatus]);
}

/**
 * Persistent, non-dismissible line at the bottom of the sidebar, above the
 * identity bar, shown only when the server demonstrably lacks a required
 * feature. Reuses the footer's compact `local-sync-row` styling. Clicking it
 * opens Account Settings → About, where version and Check for updates live.
 */
export function BackendBehindNotice() {
  useBackendStatusPoll();
  const status = useStore((s) => s.backendStatus);
  const requestAccountSettings = useStore((s) => s.requestAccountSettings);
  if (!status?.outdated) return null;

  const copy = status.managed ? BACKEND_BEHIND_MANAGED : BACKEND_BEHIND_SELF_HOSTED;
  const tooltip = [
    copy,
    `Missing: ${status.missing.join(", ")}`,
    `Server version: ${status.serverVersion ?? "unknown (older than feature reporting)"}`,
  ].join("\n");

  return (
    <button
      type="button"
      className="local-sync-row backend-behind-row"
      title={tooltip}
      onClick={() => requestAccountSettings("about")}
    >
      <svg
        className="local-sync-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      <span className="local-sync-label backend-behind-label">{copy}</span>
    </button>
  );
}
