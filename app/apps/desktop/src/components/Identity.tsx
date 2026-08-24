import { useEffect, useMemo, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import { PRESENCE_PALETTE } from "../lib/presence/color";
import { CheckMark } from "./Spinner";
import type { SyncProgress } from "../lib/sync/vaultScope";

/* ============================================================
   Character avatars — every user is auto-assigned a unique illustrated
   character (DiceBear "notionists" — clean, professional Notion-style line
   art) from a stable seed (their id/email/name), so nobody is stuck with a
   flat "TU". Generated as pure SVG on-device: no network, no external avatar
   service (which would break local-first and leak identity), and the same
   seed renders the same character on every machine. Backgrounds are drawn
   from our happy palette so the vibe stays coherent.
   ============================================================ */

// Palette hex values without the leading "#", as DiceBear expects. DiceBear
// deterministically picks one per seed, so each character gets its own colour.
const AVATAR_BG = PRESENCE_PALETTE.map((c) => c.slice(1));

/** Build the illustrated-character SVG for a seed. */
export function characterSvg(seed: string): string {
  return createAvatar(notionists, {
    seed,
    backgroundColor: AVATAR_BG,
    backgroundType: ["solid"],
    radius: 50,
  }).toString();
}

export function Avatar({ label, image }: { label: string; image?: string | null }) {
  const svg = useMemo(() => characterSvg(label || "?"), [label]);
  // Prefer a real profile photo (e.g. from Google) when present; fall back to
  // the generated character if there's no image or it fails to load.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [image]);

  if (image && !imgFailed) {
    return (
      <span className="avatar" aria-hidden="true">
        <img
          src={image}
          alt=""
          // Google's lh3.googleusercontent.com can 403 when a referrer is sent.
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="avatar"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** "just now" / "1m ago" / "2h ago" — coarse on purpose; it ticks every 30s. */
export function relativeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Phases in which the vault is actively moving data, as opposed to idle or
 *  terminal. Only these turn the pill into a counted progress report. */
const ACTIVE_SYNC_PHASES: ReadonlySet<string> = new Set([
  "registering",
  "uploading",
  "downloading",
]);

/** True while the open vault has a bulk sync run in flight. */
export function isSyncRunActive(progress: SyncProgress | null | undefined): boolean {
  return progress != null && ACTIVE_SYNC_PHASES.has(progress.phase);
}

/** The run's completion as a whole percentage, or null when it has no total.
 *  Floored, so it never reads 100% while a unit of work is still outstanding. */
export function syncRunPercent(progress: SyncProgress | null | undefined): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.done / progress.total) * 100)));
}

/**
 * Pure label for the sync pill. Extracted so the (surprisingly load-bearing)
 * "Syncing…" vs "Synced · just now" logic is unit-testable without a DOM.
 *
 * `pending` (local edits not yet acked) wins over the timestamp: while flushing
 * we show "Syncing…" — the pill speaks exactly two words, Syncing and Synced,
 * so nobody has to learn what a third ("Saving") means. Once acked, the caller
 * has bumped `lastSyncedAt`, so it reads "Synced · just now" and counts up.
 *
 * `progress` is the VAULT's bulk run, and it outranks `status` (the open note's
 * CONNECTION) whenever it is live. Those two are genuinely independent: the
 * socket can be perfectly "synced" while 380 of 500 notes have never reached the
 * server, and reporting "Synced · just now" there is precisely the lie this
 * progress exists to kill.
 *
 * `noteOpen: false` puts the pill in vault-wide mode: `status` belongs to a
 * socket that doesn't exist, so the label is derived from `progress` alone —
 * counter while running, "Synced" once done, the failure count on error.
 */
export function syncBadgeLabel(args: {
  status: string;
  pending?: boolean;
  lastSyncedAt?: number | null;
  now: number;
  enabled?: boolean;
  /** The open vault's bulk sync run, when one is in flight. */
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note. */
  noteOpen?: boolean;
}): string {
  const { status, pending, lastSyncedAt, now, enabled, progress, noteOpen } = args;
  // A grant fact about the open note outranks everything else: there is no point
  // reporting upload progress on a doc we are not allowed to write.
  if (noteOpen !== false) {
    if (status === "no-access") return "No access";
    if (status === "read-only") return "Read-only";
  }
  if (progress && isSyncRunActive(progress)) {
    if (progress.total <= 0) return "Syncing…";
    // One verb for every phase. The old per-phase labels ("Uploading",
    // "Downloading") described the mechanism, not the user's situation — the
    // content pass pulls each note's server state before pushing anything, so
    // on an already-synced vault "Uploading files" read as "my synced vault is
    // being re-sent". Done is clamped so a racing denominator can never render
    // an impossible "585/164".
    return `Syncing ${Math.min(progress.done, progress.total)}/${progress.total}`;
  }
  // A run that finished with failures must not read "Synced". `failed` is the
  // number of notes that are still only on this device.
  if (progress?.phase === "error") {
    return progress.failed > 0 ? `${progress.failed} not synced` : "Sync incomplete";
  }
  if (noteOpen === false) {
    return progress?.phase === "done" ? "Synced" : "Syncing…";
  }
  if (status === "synced") {
    if (pending) return "Syncing…";
    return lastSyncedAt != null ? `Synced · ${relativeAgo(lastSyncedAt, now)}` : "Synced";
  }
  if (status === "connecting") return "Syncing…";
  if (status === "error") return "Retrying…";
  return enabled === false ? "Local only" : "Offline";
}

/**
 * The pill's tone class. Same precedence as {@link syncBadgeLabel}, so the colour
 * never contradicts the words (a green "Syncing 12/500" would be worse than no
 * indicator at all).
 */
export function syncBadgeTone(args: {
  status: string;
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note. */
  noteOpen?: boolean;
}): string {
  const { status, progress, noteOpen } = args;
  if (noteOpen !== false && (status === "no-access" || status === "read-only")) {
    return status;
  }
  if (isSyncRunActive(progress)) return "connecting";
  if (progress?.phase === "error") return "error";
  if (noteOpen === false) {
    return progress?.phase === "done" ? "synced" : "connecting";
  }
  return status;
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function SyncBadge({
  status,
  enabled,
  lastSyncedAt,
  pending,
  progress,
  noteOpen,
  onRetry,
}: {
  status: string;
  enabled?: boolean;
  /** When set and status is "synced", the badge reads "Synced · 1m ago". */
  lastSyncedAt?: number | null;
  /** True while local edits are still flushing to the server → "Syncing…". */
  pending?: boolean;
  /** The open vault's bulk sync run — turns the pill into "Syncing 128/500"
   *  with a determinate bar. Omit for a pill that only tracks the connection. */
  progress?: SyncProgress | null;
  /** False when the pill stands for the vault, not an open note: socket-derived
   *  states are skipped and the label comes from `progress` alone. */
  noteOpen?: boolean;
  /** When set, a run that ended with failures ("N not synced") renders as a
   *  button that retries the whole sync — the remedy lives on the message. */
  onRetry?: () => void;
}) {
  const running = isSyncRunActive(progress);
  // Only tick the relative clock once we're settled (synced, nothing pending, no
  // bulk run — while one is live the label is a counter, not a timestamp).
  const now = useNowTick(
    status === "synced" && !pending && lastSyncedAt != null && !running,
  );
  const label = syncBadgeLabel({
    status,
    pending,
    lastSyncedAt,
    now,
    enabled,
    progress,
    noteOpen,
  });
  const tone = syncBadgeTone({ status, progress, noteOpen });
  // A determinate fill whenever the run knows its own size; the pre-existing
  // indeterminate slide covers "working, size unknown" (connecting, saving).
  const percent = running ? syncRunPercent(progress) : null;
  // Hover answers "how far along?" in the same shape as the folder tooltips.
  const runTitle =
    running && progress && percent != null
      ? `${progress.done} of ${progress.total} notes · ${percent}%`
      : undefined;
  // A run that ended with failures is actionable when the caller gave us the
  // action: the pill becomes a button and one click retries everything.
  const retryable = onRetry != null && !running && progress?.phase === "error";
  const title = retryable ? "Click to sync now" : runTitle;
  const body = (
    <>
      {tone === "connecting" || (tone === "synced" && pending) ? (
        <span
          className={`sync-progress${percent != null ? " determinate" : ""}`}
          aria-hidden="true"
        >
          <span
            className="sync-progress-fill"
            style={percent != null ? { width: `${percent}%` } : undefined}
          />
        </span>
      ) : tone === "read-only" ? (
        <svg
          className="sync-lock"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      ) : tone === "synced" ? (
        // Settled and safe reads as a tick, not just a green dot — the same
        // "this completed" glyph AsyncButton uses.
        <CheckMark size="xs" />
      ) : (
        <span className="sync-dot" aria-hidden="true" />
      )}
      {label}
    </>
  );
  if (retryable) {
    return (
      <button
        type="button"
        className={`sync-badge sync-badge-retry ${tone}`}
        title={title}
        onClick={onRetry}
      >
        {body}
        <span className="sync-retry-cta">Sync now</span>
      </button>
    );
  }
  return (
    <span className={`sync-badge ${tone}${pending ? " pending" : ""}`} title={title}>
      {body}
    </span>
  );
}
