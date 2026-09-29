import { lazy, Suspense, useEffect, useRef, useState } from "react";
import "./App.css";
import { AccountMenu } from "./components/AccountMenu";
import { AsyncButton } from "./components/AsyncButton";
import { Banner } from "./components/Banner";
import { ReconcileBanner } from "./components/ReconcileBanner";
import { NotSyncingBannerView, notSyncingReason } from "./components/NotSyncingBanner";
import { VaultUnsyncedBannerView } from "./components/VaultUnsyncedBanner";
import { NoteLimitBannerView, noteLimitBanner } from "./components/NoteLimitBanner";
import {
  LOCATE_FOLDER,
  RESTORE_HERE,
  SWITCH_VAULT,
  VaultFolderMissingBannerView,
} from "./components/VaultFolderMissing";
import { TalkButton } from "./components/TalkButton";
import { ActivityBadge, ActivityHost } from "./components/activitySource";
import { SilentBoundary } from "./components/SilentBoundary";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { EditorEmpty, EditorSkeleton } from "./components/EditorPlaceholders";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { SyncBadge } from "./components/Identity";
import { SearchPanel } from "./components/SearchPanel";
import { SidebarHeader } from "./components/SidebarHeader";
import { Spinner } from "./components/Spinner";
import { SidebarResizer } from "./components/SidebarResizer";
import { SidebarToggle } from "./components/SidebarToggle";
import { TabBar } from "./components/TabBar";
import { VirtualTabHost } from "./components/VirtualTabHost";
import { Toasts } from "./components/Toasts";
import { toast } from "./lib/toast";
import { RightPanel } from "./components/RightPanel";
import { usePendingReviewCount } from "./components/ReviewTab";
import { bridgeManager } from "./lib/bridge";
import { BRAND_NAME } from "./lib/brand";
import * as ipc from "./lib/ipc";
import * as perf from "./lib/perf";
import { implicatedFolders, refreshWorthy } from "./lib/tree/lazyTree";
import { syncManager } from "./lib/sync/docSession";
import { routesToAttachmentSync } from "./lib/sync/attachments";
import {
  backgroundUpdateCheck,
  checkForUpdate,
  clearJustUpdated,
  installUpdate,
  isUpdateBlocking,
  justUpdatedTo,
  useUpdateState,
} from "./lib/updater";
import { isSilentRelease, notesForVersion, releaseNoteLines } from "./lib/releaseNotes";
import { runConfetti } from "./lib/celebrate/celebrate";
import { viewerFor } from "./lib/formats";
import { onOpenFileRequest } from "./lib/openFileRequest";
import { editorMeasureStyle } from "./lib/editorMeasure";
import { noteLabel } from "./lib/notePath";
import { ShareNoteButton } from "./components/ShareNoteButton";
import { AttachmentSyncNotice } from "./components/AttachmentSyncNotice";
import { listenForNoteLinks } from "./lib/deepLink";
import { useSidebarWidth } from "./lib/useSidebarWidth";
import { readSidebarHidden, writeSidebarHidden } from "./lib/prefs";
import { requestOpenVault, useStore } from "./store";
import { clearPendingNoteLink } from "./lib/noteLinkFlow";
import { prefetchAfterPaint } from "./lib/prefetch";
import { revealWindowOnce } from "./lib/windowReveal";

/* Lazy chunks. Each of these is either a rare deliberate action (the graph),
   a modal (settings, auth), or big enough that the first paint should not wait
   on it (the editor carries CodeMirror + lezer). `lib/prefetch.ts` warms the
   editor right after the first paint, so the first note click is still
   instant. */
const Editor = lazy(() => import("./components/Editor").then((m) => ({ default: m.Editor })));
const GraphView = lazy(() =>
  import("./components/GraphView").then((m) => ({ default: m.GraphView })),
);
const VaultPicker = lazy(() =>
  import("./components/VaultPicker").then((m) => ({ default: m.VaultPicker })),
);
const AuthDialog = lazy(() =>
  import("./components/AuthDialog").then((m) => ({ default: m.AuthDialog })),
);

/** How often a running app re-checks for a new release (it also checks at
 *  launch). The check is one cheap GET of the release's static `latest.json`
 *  off GitHub's CDN; 15 minutes keeps a long-running app reasonably current
 *  without pinging GitHub all day. */
const UPDATE_POLL_MS = 15 * 60 * 1000;

/**
 * The file behind the open note vanished from disk (Finder, `rm`, a script, an
 * AI tidying the vault).
 *
 * In a synced vault that is now a real delete: the sync layer permanently
 * removes the note for the team, exactly like the
 * sidebar's Delete (see `SyncManager.drainDiskDeletes`). The banner says so
 * rather than implying the app lost track of the file — and it still only offers
 * to close, because the editor may hold text the user has not saved anywhere.
 */
function RemovedBanner() {
  const noteRemoved = useStore((s) => s.noteRemoved);
  const openNote = useStore((s) => s.openNote);
  // Latched when the file vanished, not read live: propagating the delete drops
  // the note's mapping, which would otherwise re-word the banner mid-sentence.
  const synced = useStore((s) => s.noteRemovedSynced);
  return (
    <Banner show={!!noteRemoved && !!openNote}>
      <span>
        <strong>{openNote ? noteLabel(openNote.path) : ""}</strong> was deleted on disk
        {synced ? " and permanently removed for the team." : "."}
      </span>
      <div className="banner-actions">
        <button
          className="primary"
          onClick={() => {
            // The file is gone — drop its tab too, and let the neighbour tab
            // (if any) take the screen rather than an empty editor.
            const open = useStore.getState().openNote;
            if (open) useStore.getState().closeTab(open.path);
            else useStore.getState().closeNote();
          }}
        >
          Close note
        </button>
      </div>
    </Banner>
  );
}

/**
 * A teammate (or an AI) deleted the note that was open, and we applied it here.
 *
 * Separate from `RemovedBanner`: that one means "the file vanished from under us"
 * and can only offer to close the note. This one knows the server confirmed a
 * deliberate deletion or access removal.
 */
function DeletedByTeammateBanner() {
  const removed = useStore((s) => s.noteRemovedByTeammate);
  return (
    <Banner show={!!removed}>
      <span>
        {removed?.reason === "revoked" ? (
          <>Your access to this note was removed. It is no longer on this device.</>
        ) : (
          <>A teammate deleted this note. It was permanently removed from this device.</>
        )}
      </span>
      <div className="banner-actions">
        <button
          className="primary"
          onClick={() => useStore.setState({ noteRemovedByTeammate: null })}
        >
          Dismiss
        </button>
      </div>
    </Banner>
  );
}

/**
 * The signed-out / no-access strip (#145).
 *
 * A user on a self-hosted server was signed out without noticing: the vault
 * opened, the notes rendered, the edits were accepted, and the only thing that
 * said otherwise was the sync pill in the sidebar corner, which reads "Offline"
 * — a state that normally fixes itself. Days of external file edits and
 * server-side MCP edits then merged character-by-character on the next sign-in.
 * So the fact goes where the eyes are: a full-width strip above the note.
 *
 * Wired here, alongside the other banners, so `NotSyncingBannerView` stays a
 * pure component and its one decision (`notSyncingReason`) stays unit-testable.
 * Sign in raises the same card the account menu does, via the store's
 * `authPrompt` — the one path that is already de-duplicated against the
 * link-driven prompts (see `PromptedAuthDialog`).
 */
function NotSyncingBanner() {
  const authStatus = useStore((s) => s.authStatus);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.syncStatus);
  const vaultSyncStatus = useStore((s) => s.vaultSyncStatus);
  const folderIsSynced = useStore((s) => s.openFolderIsSynced);
  const noteOpen = useStore((s) => s.openNote != null);
  const reason = notSyncingReason({
    authStatus,
    hasSession,
    syncStatus,
    vaultSyncStatus,
    folderIsSynced,
    noteOpen,
  });
  return (
    <NotSyncingBannerView
      reason={reason}
      onSignIn={() => useStore.getState().setAuthPrompt("sign-in")}
      onOpenHealth={() => useStore.getState().requestSettings("health")}
    />
  );
}

/**
 * The strip for a vault whose owner made it **local only** from somewhere else.
 *
 * The probe is here rather than in the launch chain because its two inputs land
 * at different times: the folder's stamp is peeked during the auto-reopen, but
 * `organizations` only arrives with the detached `initAuth`, and asking before
 * that would accuse every vault of being deleted for the first second of every
 * launch. Re-running it whenever the folder, the session or the vault list
 * changes costs one `peekVaultStamp` for a healthy vault — `checkUnsyncedVaultStamp`
 * answers those locally and never reaches the network.
 *
 * Wired here, alongside the other banners, so `VaultUnsyncedBannerView` stays a
 * pure component and its one decision (`planUnsyncStamp`) stays unit-testable.
 */
function VaultUnsyncedBanner() {
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const authStatus = useStore((s) => s.authStatus);
  // The IDS, not the count: swapping one vault for another (left one, joined
  // one) leaves `organizations.length` identical, and the probe's whole question
  // is whether THIS folder's org is still in that list. A joined string is exact
  // and just as cheap as reading the length.
  const orgIds = useStore((s) => s.organizations.map((o) => o.id).join(","));
  const pending = useStore((s) => s.vaultUnsynced);

  useEffect(() => {
    if (!vaultPath || authStatus !== "signed-in") return;
    void useStore
      .getState()
      .checkUnsyncedVaultStamp()
      .catch((e) => console.warn("[vault] unsynced-stamp check failed", e));
  }, [vaultPath, authStatus, orgIds]);

  return (
    <VaultUnsyncedBannerView
      show={pending != null && pending.path === vaultPath}
      onKeepLocal={() => useStore.getState().keepUnsyncedVaultLocal()}
      onTurnOnSync={() => useStore.getState().resyncUnsyncedVault()}
    />
  );
}

/**
 * The Free note-limit upgrade strip (the only part of the old "N notes didn't
 * sync" banner that survives — see `noteLimitBanner`).
 *
 * The dismissal is local state on purpose: it is a view preference about ONE
 * run, and keying it on the store's `failedRunToken` means the next failing run
 * raises the strip again by itself.
 */
function NoteLimitBanner() {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const progress = useStore((s) => s.syncProgress);
  const runToken = useStore((s) => s.failedRunToken);
  const [dismissedRunToken, setDismissedRunToken] = useState<number | null>(null);
  const show = noteLimitBanner({
    syncEnabled,
    progress,
    noteLimit: syncManager.registry.limitCode() === "note_limit_reached",
    runToken,
    dismissedRunToken,
  });
  return (
    <NoteLimitBannerView
      show={show}
      onUpgrade={() => useStore.getState().requestSettings("billing")}
      onDismiss={() => setDismissedRunToken(runToken)}
    />
  );
}

/**
 * The vault folder itself moved, was renamed, was deleted or its drive was
 * unmounted (#221, #228). The sync layer has already stopped every structural
 * step for it and the tabs are closed; the banner offers the recovery directly:
 * Restore here (recreate the folder where it was and sync it down — a synced
 * vault only) or Locate folder… (bind the folder where it now lives). Both run
 * the same store actions as the Set-up prompt, and both reopen the vault, which
 * clears the missing state and resumes sync.
 */
function VaultRootMissingBanner() {
  const missing = useStore((s) => s.structureNotice.rootMissing);
  const synced = useStore((s) => s.syncEnabled && !!s.session?.activeOrganizationId);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`Couldn't recover the vault folder — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <VaultFolderMissingBannerView
      show={missing}
      synced={synced}
      busy={busy}
      onRestore={run(() => useStore.getState().restoreVaultFolder())}
      onLocate={run(() => useStore.getState().locateVaultFolder())}
      onSwitch={() => useStore.getState().requestSettings("vaults")}
    />
  );
}

/**
 * Many notes were removed from the vault folder at once with the app open
 * (#221). Past the blast-radius cap the change is held instead of undone:
 * nothing is deleted for the team and nothing is put back until one of these
 * two answers. Everything else keeps syncing meanwhile.
 */
function BulkDeleteBanner() {
  const pending = useStore((s) => s.structureNotice.pendingDelete);
  const [busy, setBusy] = useState(false);
  const answer = (a: "delete" | "restore") => {
    setBusy(true);
    void useStore
      .getState()
      .resolveBulkDelete(a)
      .catch((e) => console.warn("[sync] bulk delete answer failed", e))
      .finally(() => setBusy(false));
  };
  const n = pending?.count ?? 0;
  return (
    <Banner show={pending != null} role="alert">
      <span>
        You removed {n} {n === 1 ? "note" : "notes"}. Delete them for everyone, or restore them?
      </span>
      <div className="banner-actions">
        <button className="primary" disabled={busy} onClick={() => answer("delete")}>
          Delete for everyone
        </button>
        <button disabled={busy} onClick={() => answer("restore")}>
          Restore
        </button>
      </div>
    </Banner>
  );
}

/**
 * Renames, moves or deletes were made while the app was closed (#221). Edits
 * were merged as always; the structure changes were not applied, and this is
 * the one place that says so. Shown once per open.
 */
function ClosedAppChangesBanner() {
  const show = useStore((s) => s.structureNotice.closedAppChanges);
  return (
    <Banner show={show} role="status">
      <span>
        Files changed while Baalda was closed. Edits were merged; renames, moves and deletes made
        while closed were not applied. Keep Baalda open when reorganising.
      </span>
      <div className="banner-actions">
        <button onClick={() => useStore.getState().dismissClosedAppChanges()}>Dismiss</button>
      </div>
    </Banner>
  );
}

/**
 * Celebrates a teammate joining the vault: a soft top banner (auto-fades
 * after a few seconds) plus a one-shot confetti burst over the whole window.
 * The chime is played by the store when the celebration is triggered.
 */
function MemberJoinedBanner() {
  const memberJoined = useStore((s) => s.memberJoined);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Fire confetti whenever a new celebration starts (`at` changes on each join).
  useEffect(() => {
    if (!memberJoined || !canvasRef.current) return;
    const cancel = runConfetti(canvasRef.current);
    return cancel;
  }, [memberJoined?.at]);

  return (
    <>
      {memberJoined && (
        <canvas ref={canvasRef} className="celebrate-confetti" aria-hidden="true" />
      )}
      <Banner show={!!memberJoined} className="celebrate-banner" role="status">
        <span>
          🎉 <strong>{memberJoined?.name}</strong> joined the vault
        </span>
        <div className="banner-actions">
          <button
            className="secondary"
            onClick={() => useStore.getState().dismissMemberJoined()}
          >
            Dismiss
          </button>
        </div>
      </Banner>
    </>
  );
}

/**
 * App-wide "switching vault" overlay. A switch is many round trips (activate
 * org → session → roster → open the folder → re-enable sync → reconcile), and
 * for that stretch the window is a mix of the vault you left and the one you're
 * going to. Rather than a spinner in one corner, cover the whole app with a
 * calm card that names the destination, so nothing half-updated can be read or
 * clicked in the meantime. Sits above every modal (Settings is where most
 * switches start) and below only the update wall.
 *
 * Fades in after a short delay (CSS) so a near-instant local switch never
 * flashes it.
 */
function VaultSwitchOverlay() {
  const switching = useStore((s) => s.switchingVault);
  if (!switching) return null;
  return (
    <div className="vault-switch-overlay" role="status" aria-live="polite">
      <div className="vault-switch-card">
        <Spinner size="md" tone="accent" />
        <div className="vault-switch-text">
          <span className="vault-switch-title">
            Switching to <strong>{switching.name}</strong>
          </span>
          <span className="vault-switch-sub">
            {switching.orgId
              ? "Opening its folder and catching up on sync…"
              : "Opening its folder…"}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown when a vault is active but has no local folder yet (freshly created
 * or joined). Rather than silently reusing whatever folder is open, ask the
 * user to point this vault at its own folder — or start with an empty one.
 */
function VaultFolderPrompt() {
  const pending = useStore((s) => s.pendingVaultFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;
  // The folder is GONE (#228): same wording and actions as the in-vault banner.
  const missing = pending.reason?.missing === true;

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickBtn = (
    <AsyncButton
      key="pick"
      className={`wf-btn ${missing ? "wf-btn-ghost" : "wf-btn-primary"}`}
      disabled={busy}
      spinnerTone={missing ? undefined : "on-accent"}
      onClick={run(() => useStore.getState().chooseVaultFolder())}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2" />
        <path d="M3 10h16.5a2 2 0 0 1 1.95 2.46l-1.1 5A2 2 0 0 1 18.4 19H5a2 2 0 0 1-2-2z" />
      </svg>
      <span>{missing ? LOCATE_FOLDER : "Open a folder…"}</span>
    </AsyncButton>
  );
  const emptyBtn = (
    <AsyncButton
      key="empty"
      className={`wf-btn ${missing ? "wf-btn-primary" : "wf-btn-ghost"}`}
      disabled={busy}
      spinnerTone={missing ? "on-accent" : undefined}
      onClick={run(() => useStore.getState().startEmptyVault())}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span>{missing ? RESTORE_HERE : "Start with an empty folder"}</span>
    </AsyncButton>
  );

  return (
    <div className="modal-backdrop vault-folder-backdrop">
      <div className="modal vault-folder-prompt" onClick={(e) => e.stopPropagation()}>
        <button
          className="icon-btn wf-close"
          disabled={busy}
          aria-label="Close"
          onClick={run(() => useStore.getState().cancelVaultFolder())}
        >
          ✕
        </button>
        <div className="wf-badge" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </div>
        <h2 className="wf-title">
          Set up <strong>{pending.orgName}</strong>
        </h2>
        {/* When there's a reason (folder moved / failed to open) it replaces the
            generic pitch — both at once read as a wall of text. */}
        {pending.reason ? (
          <div className="wf-notice" role="alert">
            <svg className="wf-notice-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
            <div className="wf-notice-body">
              <p>{pending.reason.text}</p>
              {pending.reason.path && <code>{pending.reason.path}</code>}
            </div>
          </div>
        ) : (
          <p className="wf-desc">
            Choose the local folder this vault syncs to. Each vault keeps its
            own folder — separate from your other vaults.
          </p>
        )}
        <div className="vault-folder-actions">
          {/* Both of these open a vault: a native picker, then a full vault open
              + reconcile. Easily a second or two, so each reports for itself. */}
          {/* A missing folder leads with Restore here, like the banner (#228). */}
          {missing ? [emptyBtn, pickBtn] : [pickBtn, emptyBtn]}
        </div>
        {missing && (
          <button
            type="button"
            className="link-btn wf-switch"
            disabled={busy}
            onClick={run(() => useStore.getState().cancelVaultFolder())}
          >
            {SWITCH_VAULT}
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Full-screen REQUIRED-update wall — the FALLBACK path, not the normal one.
 *
 * Updates install themselves: a newer version found at launch or by the poll is
 * downloaded, installed and restarted into silently, and this component never
 * renders. It appears only once the silent path has spent both its attempts
 * (`failed`), when the app is knowingly stale and needs the user to fix a
 * network before it can heal itself.
 *
 * Why a wall rather than a dismissible bar at that point: old builds are
 * exactly where the bugs we just fixed live — one stale client can resurrect
 * deleted folders for a whole team. Keeping everyone on the latest version is a
 * correctness feature here, not a nag.
 *
 * The version is LATCHED on `failed`, so the wall stays up through a manual
 * retry and its download progress instead of vanishing mid-install and letting
 * a known-stale build back in. A failed background *check* (offline launch, dev
 * build without the updater) never reaches `failed`, so it still walls nothing
 * off. Local edits stay safe throughout — notes are on disk, and
 * `installUpdate` flushes the open note before it touches anything.
 */
function UpdateGate() {
  const update = useUpdateState();
  const [required, setRequired] = useState<string | null>(null);
  useEffect(() => {
    if (isUpdateBlocking(update) && "version" in update) setRequired(update.version);
  }, [update]);

  if (!required) return null;

  const pct =
    update.phase === "downloading" && update.total > 0
      ? Math.round((update.downloaded / update.total) * 100)
      : null;

  const version = ("version" in update ? update.version : null) ?? required;

  // Once the wall is up the only thing left in the window is this card, so a
  // manual retry restarts the moment it can — the quiet-moment wait exists to
  // protect someone who is typing, and nobody is typing behind the wall.
  const retry = async () => {
    // Re-discover then install: the failed attempt may have died at either
    // stage, and checkForUpdate re-arms the pending update.
    if (await checkForUpdate()) await installUpdate({ waitForQuiet: false });
  };

  const working =
    update.phase === "checking" ||
    update.phase === "downloading" ||
    update.phase === "installing" ||
    update.phase === "ready";

  // Escape hatch beside the install CTA: flush the open note, then reboot the
  // webview — same as the reload shortcut. Useful when a wall raised by a
  // half-failed check would otherwise strand the window.
  const reload = async () => {
    try {
      await bridgeManager.currentBridge()?.flushEgest();
    } catch {
      // Best-effort: reload regardless, notes are already on disk.
    }
    window.location.reload();
  };

  return (
    <div className="update-gate" role="alertdialog" aria-modal="true" aria-label="Update required">
      <div className="update-gate-card">
        <div className="update-gate-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v11" />
            <path d="m7 10 5 5 5-5" />
            <path d="M4 19h16" />
          </svg>
        </div>
        <div className="update-gate-heading">
          <h1>Update required</h1>
          {version && <span className="update-gate-version">v{version}</span>}
        </div>
        {working && (
          <>
            <p role="status">
              {update.phase === "checking"
                ? "Checking for the update…"
                : update.phase === "downloading"
                  ? `Downloading v${update.version}${pct != null ? ` — ${pct}%` : "…"}`
                  : "Installing — the app will restart itself…"}
            </p>
            {/* A determinate bar when the server sent a content length, an
                indeterminate sweep when it didn't — a bar that fills to an
                unknown target and stalls is worse than one that never claimed
                to know. */}
            <div
              className={`update-progress${pct == null ? " indeterminate" : ""}`}
              role="progressbar"
              aria-valuenow={pct ?? undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                className="update-progress-fill"
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
          </>
        )}
        {!working && (
          <>
            <p>
              {BRAND_NAME} couldn&rsquo;t install the update to <strong>v{required}</strong>
              {"message" in update && update.message ? ` — ${update.message}` : ""}. It tried
              twice on its own. Check your connection and try again — your notes stay right
              where they are, on your disk.
            </p>
            <div className="update-gate-actions">
              <AsyncButton className="primary update-gate-cta" onClick={retry}>
                Try again
              </AsyncButton>
              <button className="ghost-pill lg" onClick={() => void reload()}>
                Reload
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "What's New" — a centered modal shown on the first launch after an update,
 * with that version's handful of points and a one-shot confetti burst. Only
 * that version's: the notes are per-release now, so nobody reads a fresh
 * update's dialog and sees changes they already had. A modal rather
 * than a banner: the old top strip pushed the whole page down, which read as
 * the content jumping. Stays until dismissed (the stash survives a quit), so
 * an update never lands completely unannounced.
 */
function WhatsNewModal() {
  const [updated, setUpdated] = useState<{ version: string; notes: string[] } | null>(
    null,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void justUpdatedTo().then((stash) => {
      if (cancelled || !stash) return;
      // A silent release (its notes section left empty) updates without a word.
      if (isSilentRelease(stash.notes, stash.version)) {
        clearJustUpdated();
        return;
      }
      // Only the section for the version we were actually given, and at most
      // five points of it. The body used to be the whole cumulative notes file,
      // so every update opened on twelve bullets from releases already
      // installed; the workflow ships one section now and this is the backstop.
      setUpdated({
        version: stash.version,
        notes: releaseNoteLines(notesForVersion(stash.notes, stash.version), 5),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = updated != null;

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    return runConfetti(canvasRef.current);
  }, [open]);

  const close = () => {
    clearJustUpdated();
    setUpdated(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!updated) return null;
  return (
    <>
      <canvas ref={canvasRef} className="celebrate-confetti" aria-hidden="true" />
      <div className="modal-backdrop" onClick={close}>
        <div
          className="modal whats-new"
          role="dialog"
          aria-label="What's new"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="whats-new-hero">
            <div className="whats-new-glyph" aria-hidden="true">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
                <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7L19 15z" />
              </svg>
            </div>
            <h2 className="whats-new-title">What&rsquo;s New</h2>
            <span className="whats-new-version">v{updated.version}</span>
            <p className="whats-new-sub">
              {BRAND_NAME} updated itself to the latest version — here&rsquo;s what
              changed.
            </p>
          </div>
          {updated.notes.length > 0 && (
            <ul className="whats-new-notes">
              {updated.notes.map((line, i) => (
                <li key={i} style={{ animationDelay: `${120 + i * 70}ms` }}>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
          <button className="primary whats-new-cta" autoFocus onClick={close}>
            Nice — let&rsquo;s go
          </button>
        </div>
      </div>
    </>
  );
}

function SyncIndicator({
  noteOpen,
  attachmentLocalOnly = false,
}: {
  noteOpen: boolean;
  attachmentLocalOnly?: boolean;
}) {
  // Per-note sync status (offline / connecting / synced / read-only) PLUS the
  // vault's bulk-run progress, so a vault that is still uploading 380 of its 500
  // notes says so instead of claiming "Synced · just now" off a live socket.
  // With no note open the pill goes vault-wide: it appears whenever a bulk run
  // has something to report and stays put afterwards ("Synced ✓" — per-note
  // failures are the Health page's), so a fresh hydration is never invisible.
  const status = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const pending = useStore((s) => s.syncPending);
  const progress = useStore((s) => s.syncProgress);
  const rootMissing = useStore((s) => s.structureNotice.rootMissing);
  // The folder is gone (#228): nothing syncs until it is back, so the pill
  // must not claim "Synced". Neutral, not an error — the banner has the fix.
  if (rootMissing) {
    return (
      <span className="sync-badge offline" title="Sync is paused until the vault folder is back">
        <span className="sync-dot" aria-hidden="true" />
        Paused
      </span>
    );
  }
  if (attachmentLocalOnly) {
    return <SyncBadge status="offline" enabled={false} noteOpen />;
  }
  // "idle" is the reporter's pre-start value — nothing to report yet.
  if (!noteOpen && (progress == null || progress.phase === "idle")) return null;
  return (
    <SyncBadge
      status={status}
      enabled={syncEnabled}
      lastSyncedAt={lastSyncedAt}
      pending={pending}
      progress={progress}
      noteOpen={noteOpen}
      // A run that could not proceed carries its own remedy: one click re-pulls
      // the registry and re-runs the content pass for everything unconfirmed.
      onRetry={syncEnabled ? () => void syncManager.retrySync() : undefined}
      // …and the first click should EXPLAIN rather than retry blindly.
      onOpenHealth={
        syncEnabled ? () => useStore.getState().requestSettings("health") : undefined
      }
    />
  );
}

/**
 * Sign-in dialog raised by a flow, not by a click. Two flows use it, both
 * arriving as a `baalda://` deep link while the app is signed out:
 *
 *   - "note-link": a shared note. The link is queued in lib/noteLinkFlow and
 *     signing in here opens it automatically.
 *   - "server-link": a server invite (#91). The offered URL is parked in
 *     `pendingServerLink` and the dialog opens on its confirm step, so a
 *     self-hosting team can send one link instead of dictating a URL.
 *   - "invite": a team invitation link; the card names the vault + address.
 *   - "sign-in": a password was reset in the browser and this device's session
 *     went with it; the card opens ready for the new password.
 *
 * Dismissing the dialog abandons whichever was pending (and, for a note link,
 * the vault-landing request it armed) so nothing fires on a later, unrelated
 * sign-in. Mounted in BOTH root branches — a signed-out user can receive a link
 * with or without a folder open.
 */
function PromptedAuthDialog() {
  const authPrompt = useStore((s) => s.authPrompt);
  if (
    authPrompt !== "note-link" &&
    authPrompt !== "server-link" &&
    authPrompt !== "invite" &&
    authPrompt !== "sign-in"
  ) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <AuthDialog
        // An invitee usually has no account yet — the link is often the first
        // time they hear of us — so the invite card opens on sign-up.
        initialMode={authPrompt === "invite" ? "sign-up" : "sign-in"}
        onSignedIn={() => useStore.getState().setAuthPrompt(null)}
        onClose={() => {
          clearPendingNoteLink();
          requestOpenVault(null);
          useStore.getState().clearServerLink();
          // Dismissing the card declines for now: drop the queued invitation too,
          // or the next unrelated sign-in would surprise-join a vault.
          // Unconditional, because an invitation can be parked behind the
          // "server-link" prompt as well — the invite that offered the server.
          useStore.getState().clearInvitePrompt();
          useStore.getState().setAuthPrompt(null);
        }}
      />
    </Suspense>
  );
}

export default function App() {
  const vault = useStore((s) => s.vault);
  const openNote = useStore((s) => s.openNote);
  const activeVirtual = useStore(
    (s) => s.virtualTabs.find((t) => t.id === s.activeVirtualTab) ?? null,
  );
  const openingNotePath = useStore((s) => s.openingNotePath);
  const switchingVault = useStore((s) => s.switchingVault);
  // Version history is a synced-vault feature: it needs the note's docId on the
  // server. No mapping (local vault, unregistered note) → no history button.
  const versionDocId = useStore((s) => {
    const path = s.openNote?.path;
    return path && s.syncEnabled ? (s.docIdByPath[path] ?? null) : null;
  });
  const rightPanelOpen = useStore((s) => s.rightPanel != null);
  const versionsTabOpen = useStore((s) => s.rightPanel?.tab === "versions");
  const pendingReview = usePendingReviewCount();
  const editorMeasure = useStore((s) => s.editorMeasure);
  // An open preview (image, PDF, video, spreadsheet, code…) isn't a synced
  // note — hide the save/sync chrome. The registry decides, so this cannot
  // disagree with what `FilePreview` actually rendered.
  const isPreview = openNote != null && viewerFor(openNote.path) !== "editor";
  const attachmentLocalOnly = useStore(
    (s) =>
      s.attachmentSyncBlocked &&
      s.openNote != null &&
      routesToAttachmentSync(s.openNote.path),
  );
  // Covers the LAST VAULT'S OPEN and nothing else. It used to cover the whole
  // session restore + sync reconcile too, which is why launch showed "Loading…"
  // for seconds on a big vault: the sidebar was ready long before auth was.
  const [openingLastVault, setOpeningLastVault] = useState(true);
  const [graphOpen, setGraphOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(readSidebarHidden);
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  // Guards the launch auto-reopen against StrictMode's double-invoke (dev).
  const didAutoReopenRef = useRef(false);

  // Reveal the window on React's FIRST commit — deliberately not on the tree
  // or on `!booting`. That first commit is the themed shell, so the user gets a
  // correctly coloured window immediately instead of an empty frame while the
  // bundle parses; holding it back until the sidebar has data would hide the
  // app for the whole boot sequence. Effects run before the `booting` early
  // return below, so this fires on the shell.
  useEffect(() => {
    revealWindowOnce();
    prefetchAfterPaint();
  }, []);

  // The history panel is about ONE note; switching notes under it would leave a
  // list of versions that no longer belong to what's in the editor.
  // The Versions tab follows the open note: switch notes and it shows the new
  // note's history (or its empty state for a note the server does not know).
  useEffect(() => {
    if (!versionsTabOpen) return;
    if (versionDocId) void useStore.getState().openVersionPanel(versionDocId);
    else useStore.getState().closeVersionPanel();
  }, [versionsTabOpen, versionDocId]);

  // `baalda://` links, from a teammate's chat window into this app. Mounted for
  // the app's whole life (not gated on a vault being open) because the very
  // first thing a link may have to do is switch vaults.
  useEffect(() => listenForNoteLinks(), []);

  // Auto-reopen the last vault on launch, then restore the session (spec 04 §7)
  // and enable sync. Vault first so `enableSyncForVault` (called inside initAuth)
  // sees the loaded tree.
  useEffect(() => {
    // Run exactly once. In dev, StrictMode double-invokes this effect, which
    // otherwise fires two concurrent `openVault` calls that race on the index
    // write lock → "database is locked" → the vault fails to open.
    if (didAutoReopenRef.current) return;
    didAutoReopenRef.current = true;
    (async () => {
      try {
        const last = await ipc.getLastVault();
        if (last) {
          // The index can be briefly write-locked right at startup; retry a few
          // times before giving up so a transient lock doesn't strand the vault.
          let opened: ipc.VaultInfo | null = null;
          for (let attempt = 0; ; attempt++) {
            try {
              opened = await ipc.openVault(last.path);
              break;
            } catch (err) {
              if (attempt >= 3) throw err;
              await new Promise((r) => setTimeout(r, 400));
            }
          }
          // Use the info the OPEN returned, not the pre-open probe: only the
          // former carries the vault epoch this session must pin its writes to
          // (`get_last_vault` reports the epoch from before it opened anything).
          useStore.getState().setVault(opened ?? last);
          // Does this folder belong to a synced vault? One ~60-byte IPC, fired
          // WITHOUT awaiting so it can't delay the paint. It is what tells a
          // click that beats the sync prime whether waiting for a doc-id map is
          // worth it — see `lib/sync/openGate`.
          void ipc
            .peekVaultStamp((opened ?? last).path)
            .then((stamp) => {
              if (useStore.getState().vault?.path !== (opened ?? last).path) return;
              useStore.setState({ openFolderIsSynced: stamp?.organizationId != null });
            })
            .catch(() => {
              /* unreadable: stays null, so the gate keeps waiting for the prime */
            });
          await useStore.getState().refreshTree();
          perf.mark("tree-ready");
          // Not awaited: the index rebuild runs in the background now (#84), and
          // this call parks on its lock until it commits. The tree above needs
          // no index, so the vault is on screen while the rebuild runs; titles
          // land when it finishes (and `index-ready` refreshes them again).
          void useStore.getState().refreshTitles();
        }
      } catch (e) {
        console.error("auto-reopen failed", e);
      } finally {
        // The tree is in the store; NOTHING below this line may gate the paint.
        setOpeningLastVault(false);
        // The frame AFTER the state flush is the one the user sees.
        requestAnimationFrame(() => perf.mark("tree-painted"));
      }
      // Detached, deliberately: the session restore is 3+ HTTP round trips and
      // it ends in the sync reconcile, which on a large vault is minutes of
      // work. Every `set()` inside it is generation-guarded (`authInitGen`), so
      // a sign-in/sign-out the user performs meanwhile still wins.
      void useStore
        .getState()
        .initAuth()
        .catch((e) => console.error("auth init failed", e));
      // Check for updates at launch AND on a background poll, and install what
      // we find WITHOUT asking: a found release is downloaded and installed
      // silently, then the app restarts itself at the next pause in typing (see
      // lib/quietMoment.ts). Nothing is shown on the way through — the user
      // meets the new version in the What's New modal after the restart. The
      // required-update wall (UpdateGate) is the fallback for when that silent
      // path has failed twice.
      //
      // Failures (offline, non-bundled dev build) are swallowed by the updater
      // store — surfaced only in Settings → Updates. App-lifetime interval —
      // never cleared, and the launch guard above keeps it single in dev
      // StrictMode.
      //
      // Not in a dev build: `tauri dev` still has the updater plugin and it
      // polls PRODUCTION's `latest.json`, so the day after any release every
      // dev session would silently download a release bundle and then ask Tauri
      // to relaunch a `cargo run` binary, which quits the app outright.
      if (!import.meta.env.DEV) {
        void backgroundUpdateCheck();
        setInterval(() => void backgroundUpdateCheck(), UPDATE_POLL_MS);
      }
    })();
  }, []);

  // An in-note file chip was clicked (`lib/editor/livePreview.ts` →
  // `requestOpenFile`). The editor extensions are store-free on purpose, so the
  // widget asks and the app — which owns the store — opens the pane.
  useEffect(() => onOpenFileRequest((rel) => {
    void useStore.getState().openNoteByPath(rel);
  }), []);

  // A vault folder renamed in Finder may report nothing at all to the watcher
  // (FSEvents follows the path, not the folder), and coming back to the window
  // is the moment the user expects to find out (#221). One cheap disk question;
  // the sync layer latches the answer and raises the reopen banner.
  useEffect(() => {
    const onFocus = () => void syncManager.checkVaultRoot();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Subscribe to Rust events: tree refresh + open-note reconciliation.
  useEffect(() => {
    let unlistenFile: (() => void) | undefined;
    let unlistenVault: (() => void) | undefined;
    let unlistenIndex: (() => void) | undefined;
    let unlistenIndexed: (() => void) | undefined;
    // Coalesce sidebar refreshes: a bulk change (e.g. importing a folder) emits
    // many `file-changed` batches in quick succession; refreshing the tree on
    // each one re-renders the whole sidebar repeatedly and flickers hover state.
    // Debounce so a burst settles into a single refresh.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Folders whose listings the pending batches can have changed; null once any
    // batch in the window carried a structural change (then the whole tree is
    // re-listed, as before).
    let pendingFolders: Set<string> | null = new Set();
    // The file changes themselves (last kind per path), for the titles patch.
    let pendingChanges = new Map<string, "modified" | "removed">();
    const scheduleRefresh = (batch: ipc.FileChanged[]) => {
      // Entries whose bytes did not move (#155) change nothing the sidebar, the
      // titles or the backlinks render, so they neither implicate a folder nor
      // arm the timer. An all-unchanged batch — an idle vault under a cloud-sync
      // agent, or Linux's read events — must cost exactly one `filter`.
      const changes = refreshWorthy(batch);
      if (changes.length === 0) return;
      if (pendingFolders) {
        const dirs = implicatedFolders(changes);
        if (dirs) for (const d of dirs) pendingFolders.add(d);
        else pendingFolders = null;
      }
      for (const c of changes) if (c.kind !== "tree") pendingChanges.set(c.path, c.kind);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const folders = pendingFolders;
        const fileChanges = [...pendingChanges].map(([path, kind]) => ({ path, kind }));
        pendingFolders = new Set();
        pendingChanges = new Map();
        const store = useStore.getState();
        void store.refreshTree(folders ?? undefined);
        // Titles: patch the named rows for a plain file batch; only a structural
        // change (folder rename/move, which rewrites many paths) re-lists all.
        if (folders) void store.patchTitles(fileChanges);
        else void store.refreshTitles();
        void store.refreshBacklinks();
      }, 120);
    };
    (async () => {
      // Whole batches, not one event per file: the sync layer folds every
      // unmapped/structural item in a batch into a SINGLE registry pull, which it
      // cannot do when the items arrive one at a time.
      unlistenFile = await ipc.onFilesChanged((changes) => {
        if (changes.length === 0) return;
        const open = useStore.getState().openNote;
        const forSync: ipc.FileChanged[] = [];
        for (const e of changes) {
          // Binaries are content-synced, not CRDT-bridged: a change to one
          // triggers a debounced two-way blob reconcile and nothing else.
          //
          // The test is the FORMAT, not the folder. It used to be "does this
          // path start with `attachments/`", which was the same question back
          // when the hidden store was the only home a binary had — a `.docx`
          // dropped into a folder fell through to the note path below, where an
          // unmapped file means "register it as a note" (`routesToAttachmentSync`).
          //
          // The PATH goes with it now: a binary that disappears is reported as
          // a `tree` change like any other non-note file, and the blob mirror's
          // diff reads a missing local file as "content the server has and we
          // don't" — i.e. as a download. Deleting a synced PDF therefore
          // brought it straight back. The sync layer's delete queue takes the
          // path, waits out its grace window and asks the disk.
          if (routesToAttachmentSync(e.path)) {
            syncManager.handleAttachmentChanged(e.path);
            continue;
          }
          // Open-note reconciliation runs immediately (per event); the sidebar
          // refresh is coalesced via scheduleRefresh below.
          if (open && e.path === open.path) {
            if (e.kind === "removed") {
              useStore.getState().setNoteRemoved(true);
            } else {
              // Route the edit into the bridge; it debounces, drops our own echo,
              // and merges genuine external edits live into the open Y.Text.
              //
              // `unchanged` entries go in too, deliberately. This is the one
              // consumer that reconciles the open doc against the FILE rather
              // than against the index, and those two can disagree while the
              // bytes sit still (a cold-applied update, a hydrate that lost a
              // race). It is 150ms-debounced, echo-guarded by `lastWrittenHash`
              // and scoped to the single open note, so the worst an idle vault's
              // read-event storm costs here is one `readNote` — nothing like the
              // tree re-list, title re-read and graph rebuild below.
              bridgeManager.handleFileChanged(e.path);
            }
            // …and the sync layer sees it either way. Deleting the note you have
            // open must reach the team exactly like deleting a closed one, and
            // the `modified` half of a third-party atomic save is what CANCELS
            // that delete inside its grace window — so skipping these events for
            // the open note is what made an open note behave differently from
            // every other one. The sync layer's own suppressed-doc guard keeps
            // the open note out of the content-push queue.
            forSync.push(e);
            continue;
          }
          // Everything that is NOT the open note goes to the sync layer: an
          // external writer (an AI with the vault folder open, another editor)
          // creating or changing files must reach the server live — not on the
          // next sign-in reconcile, and not only once someone opens the note.
          forSync.push(e);
        }
        if (forSync.length > 0) syncManager.handleLocalFilesChanged(forSync);

        // Refresh tree + titles + backlinks (coalesced for bursts; the tree
        // refresh is targeted at the folders this batch touched — #82).
        scheduleRefresh(changes);
      });
      unlistenVault = await ipc.onVaultOpened((v) => {
        useStore.getState().setVault(v);
      });
      // Rust finished pulling the words out of these binaries. The sync layer
      // offers them to the server as search fuel (never as content) — already
      // coalesced in Rust, and debounced again there.
      unlistenIndexed = await ipc.onFilesIndexed((paths) => {
        syncManager.handleFilesIndexed(paths);
      });
      // The background index rebuild committed: everything derived from the
      // index catches up. Stale epochs (a vault switched during a long rebuild)
      // are dropped — the open that replaced it gets its own event.
      unlistenIndex = await ipc.onIndexReady((e) => {
        const vault = useStore.getState().vault;
        if (!vault || vault.epoch !== e.epoch) return;
        perf.mark("index-ready");
        if (!e.ok) toast("Couldn't finish indexing this vault — search and backlinks may be incomplete.", "error");
        void useStore.getState().refreshTitles();
        void useStore.getState().refreshBacklinks();
      });
    })();
    return () => {
      unlistenFile?.();
      unlistenVault?.();
      unlistenIndex?.();
      unlistenIndexed?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, []);

  // Window commands: ⌘N new note, ⌘W close tab, Ctrl-Tab cycle, ⌘S/⌘G/⌘F, reload.
  useEffect(() => {
    // Timestamp of the last bare "r" press, for the "rr" reload chord below.
    let lastRAt = 0;

    // True when focus is in the editor or any text field, so bare-key chords
    // (like "rr") never fire mid-typing — they only work when just viewing.
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        el.isContentEditable ||
        el.closest(".cm-editor") != null
      );
    };

    const reloadApp = async () => {
      // Flush pending writes first so no in-flight edit is lost, then reboot the
      // UI (re-opens the vault, re-inits auth, re-establishes sync). The Rust
      // core stays alive across a webview reload.
      try {
        await bridgeManager.currentBridge()?.flushEgest();
      } catch (err) {
        console.error("flush before reload failed", err);
      }
      window.location.reload();
    };

    const onKey = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // One shared create path with the sidebar's New-note button and the tab
        // strip's `+`: the same `Untitled` / `Untitled N` naming, the same root
        // freeze latch (writing a root file past it would leave the note
        // permanently unsyncable — the server refuses to register it), and the
        // same reveal-into-rename. This used to invent `Untitled ${Date.now()}`.
        void useStore.getState().createNoteIn("");
        return;
      }
      // ⌘W closes the active tab (and clears the editor with the last one).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const active = useStore.getState().openNote?.path;
        if (active) useStore.getState().closeTab(active);
        return;
      }
      // Ctrl-Tab / Ctrl-Shift-Tab walk the strip in its visible order (tabs
      // never reorder, so a live read is the right one). Ctrl, not ⌘, on every
      // platform: ⌘-Tab is the macOS app switcher and never reaches the webview.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        const { openTabs, openNote } = useStore.getState();
        if (openTabs.length < 2) return;
        const i = openNote ? openTabs.indexOf(openNote.path) : -1;
        const step = e.shiftKey ? -1 : 1;
        const next = openTabs[(i + step + openTabs.length) % openTabs.length];
        if (next) void useStore.getState().openNoteByPath(next);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // The bridge autosaves; ⌘S just flushes any pending debounced write.
        void bridgeManager.currentBridge()?.flushEgest();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGraphOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      // ⌘R / Ctrl+R → reload the whole app. On macOS the webview often swallows
      // ⌘R before JS sees it, so the "rr" chord below is the reliable path.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        lastRAt = 0;
        void reloadApp();
        return;
      }

      // "rr" chord → reload. Press "r" twice within 500ms while NOT typing
      // (i.e. focus is not in the editor or a text field). A single "r" does
      // nothing, so this never gets in the way of normal navigation.
      if (
        e.key.toLowerCase() === "r" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isTyping()
      ) {
        const now = e.timeStamp;
        if (now - lastRAt < 500) {
          e.preventDefault();
          lastRAt = 0;
          void reloadApp();
        } else {
          lastRAt = now;
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Only while we still don't know WHICH folder to show. `setVault` lands
  // before `refreshTree` resolves, so the app shell appears the instant the
  // vault is known; keeping the `!vault` conjunct is what stops VaultPicker
  // flashing for the 10–50ms of `getLastVault` + `openVault` on a relaunch.
  if (openingLastVault && !vault) {
    return <div className="booting">Loading…</div>;
  }

  if (!vault) {
    // The folder-prompt rides along here too: switching to a synced vault
    // that has no local folder yet (e.g. clicked from the welcome screen) asks
    // the user to choose/create one before its folder opens.
    return (
      <div className="app-shell">
        <UpdateGate />
        {/* Reusing `.booting` means the loading→welcome hand-off reads as one
            continuous boot rather than a flash of a second loader. */}
        <Suspense fallback={<div className="booting">Loading…</div>}>
          <VaultPicker />
        </Suspense>
        <VaultFolderPrompt />
        <PromptedAuthDialog />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Window-global, above the sidebar+main split: a new release must be
          visible the moment the poll finds it, whatever is on screen. */}
      <UpdateGate />
      <VaultSwitchOverlay />
      <PromptedAuthDialog />
      <div
        className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <SidebarToggle
          hidden={sidebarHidden}
          onToggle={() => setSidebarHidden((hidden) => {
            const next = !hidden;
            writeSidebarHidden(next);
            return next;
          })}
          searchOpen={searchOpen}
          onSearch={() => setSearchOpen((open) => !open)}
        />
        {/* Centered overlay, not a sidebar panel — it searches the whole vault
            and its button lives in the main header. */}
        {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
        <aside
          className="sidebar"
          id="vault-sidebar"
          aria-hidden={sidebarHidden}
          inert={sidebarHidden}
        >
          <SidebarHeader />
          {/* The tree still lists the OUTGOING vault's files until the folder
              swaps, so a switch fades it and stops taking clicks — opening a note
              from a vault you're leaving would be cancelled by the epoch guard
              anyway, and a row that highlights then does nothing reads as a bug. */}
          <div className={`sidebar-tree-wrap${switchingVault ? " is-switching" : ""}`}>
            <FileTree />
          </div>
          <div className="sidebar-footer">
            {/* Boundary so a crash here degrades to a visible fallback instead of
                silently emptying the corner — the identity bar must never just
                vanish. */}
            <ErrorBoundary label="Account">
              <AccountMenu />
            </ErrorBoundary>
          </div>
        </aside>
        {!sidebarHidden && <SidebarResizer width={sidebarWidth} onWidth={setSidebarWidth} />}
  
        <main className="main">
          <MemberJoinedBanner />
          <WhatsNewModal />
          {/* Sits flush against the top of the window now that there's no system
              title bar above it (`titleBarStyle: "Overlay"`), which is where the
              reclaimed ~28px comes from — and that makes it the strip you'd expect
              to drag the window by. "deep" hands the whole row over as a drag
              region; Tauri exempts the buttons on the right, so they still click. */}
          <header className="main-header" data-tauri-drag-region="deep">
            {/* The tab strip IS the header's title row — the note's one and only
                title. A `.note-title` span used to sit here showing the *indexed*
                title, which for a legacy note whose H1 and filename disagree said
                something different from its own tab. */}
            <TabBar />
            <SyncIndicator
              noteOpen={openNote != null && !isPreview}
              attachmentLocalOnly={attachmentLocalOnly}
            />
            {/* Vault-wide, so it sits in the header regardless of the open note. */}
            <TalkButton />
            {/* Same gate as history: a link is a doc_id, so it only exists for a
                note the server knows about. */}
            {versionDocId && !isPreview && <ShareNoteButton docId={versionDocId} />}
            <button
              className="icon-btn graph-btn"
              title="Graph view (⌘G)"
              aria-label="Open graph view"
              onClick={() => setGraphOpen(true)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="5.5" cy="6" r="2.5" />
                <circle cx="18" cy="4.5" r="2" />
                <circle cx="12.5" cy="13" r="2.5" />
                <circle cx="6" cy="19" r="2" />
                <circle cx="19.5" cy="18.5" r="2.5" />
                <path d="M7.8 7.2 10.6 11M14.4 11.3 16.6 6M11 15 7.3 17.6M14.8 14.6l3 2.6" />
              </svg>
            </button>
            {/* Far right: the Activity / Versions panel (push-to-talk lives in
                its header now). */}
            <button
              className={`icon-btn panel-btn${rightPanelOpen ? " active" : ""}`}
              title={pendingReview > 0 ? `Panel (${pendingReview} to review)` : "Panel"}
              aria-label={pendingReview > 0 ? `Panel, ${pendingReview} changes to review` : "Panel"}
              aria-pressed={rightPanelOpen}
              onClick={() => {
                if (rightPanelOpen) useStore.getState().closeRightPanel();
                else useStore.getState().openRightPanel();
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M15 4v16" />
              </svg>
              <SilentBoundary label="Activity badge">
                <ActivityBadge />
              </SilentBoundary>
            </button>
          </header>
          <VaultUnsyncedBanner />
          <VaultRootMissingBanner />
          <BulkDeleteBanner />
          <ClosedAppChangesBanner />
          <SilentBoundary label="Reconcile banner">
            <ReconcileBanner />
          </SilentBoundary>
          <NotSyncingBanner />
          <NoteLimitBanner />
          <RemovedBanner />
          <DeletedByTeammateBanner />
          {attachmentLocalOnly && <AttachmentSyncNotice />}
          <div className="editor-wrap">
            {activeVirtual && <VirtualTabHost tab={activeVirtual} />}
            {/* Stays MOUNTED under a virtual tab (display toggles, the tree does
                not), so the note's live editor is still there for Compare's
                right side and for "Replace current note". */}
            <div className="editor-slot" style={{ display: activeVirtual ? "none" : "contents" }}>
            {openNote ? (
              <Suspense
                fallback={
                  // The column the editor will use, not the default one:
                  // without this the bars sat at 88ch and jumped sideways when
                  // the real note landed. (The other half of that match is the
                  // skeleton's own font-size — `--editor-measure` is a `ch`
                  // length, so it resolves against whatever font the element
                  // using it has; see `components/editor.css`.)
                  <div className="editor-column" style={editorMeasureStyle(editorMeasure)}>
                    <EditorSkeleton />
                  </div>
                }
              >
                {/* The editor is the one subtree that binds React to
                    CodeMirror, and a throw anywhere in it used to unmount the
                    WHOLE app to a blank window with no message — the crash that
                    `lib/editor/effectDispatch.ts` describes reached users that
                    way, undiagnosable because release builds carry no logging.
                    `resetKeys` on the note path means switching notes (or
                    reopening this one) clears the fallback and tries again. */}
                <ErrorBoundary label="Editor" resetKeys={[openNote.path]}>
                  <Editor />
                </ErrorBoundary>
              </Suspense>
            ) : openingNotePath ? (
              // First open of the session: there is no `<Editor>` mounted yet to
              // draw its own skeleton, and the registration round trip happens
              // before `openNote` exists — so without this the very first click
              // showed "Select a note" for the whole wait.
              <div className="editor-column" style={editorMeasureStyle(editorMeasure)}>
                <EditorSkeleton />
              </div>
            ) : (
              <EditorEmpty />
            )}
            </div>
          </div>
          <BacklinksPanel />
          {/* Slides in over the editor from the right; anchored to .main. */}
          <SilentBoundary label="Activity host">
            <ActivityHost />
          </SilentBoundary>
          <SilentBoundary label="Right panel">
            <RightPanel />
          </SilentBoundary>
        </main>
  
        {graphOpen && (
          <ErrorBoundary
            label="Graph view"
            resetKeys={[graphOpen]}
            onError={() => setGraphOpen(false)}
          >
            {/* `.graph-view` is the full-window overlay itself, so the screen
                dims the instant the graph is asked for, then fills in. */}
            <Suspense fallback={<div className="graph-view" aria-busy="true" />}>
              <GraphView onClose={() => setGraphOpen(false)} />
            </Suspense>
          </ErrorBoundary>
        )}
        <VaultFolderPrompt />
        {/* Last child so it layers over everything without a z-index race. */}
        <Toasts />
      </div>
    </div>
  );
}
