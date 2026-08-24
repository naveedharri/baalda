import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import "./App.css";
import { AccountMenu } from "./components/AccountMenu";
import { AsyncButton } from "./components/AsyncButton";
import { TalkButton } from "./components/TalkButton";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { GraphView } from "./components/GraphView";
import { SyncBadge } from "./components/Identity";
import { Wordmark } from "./components/Logo";
import { SearchPanel } from "./components/SearchPanel";
import { SidebarHeader } from "./components/SidebarHeader";
import { SidebarResizer } from "./components/SidebarResizer";
import { Toasts } from "./components/Toasts";
import { toast } from "./lib/toast";
import { VaultPicker } from "./components/VaultPicker";
import { VersionPanel } from "./components/VersionPanel";
import { bridgeManager } from "./lib/bridge";
import { BRAND_NAME } from "./lib/brand";
import * as ipc from "./lib/ipc";
import { syncManager } from "./lib/sync/docSession";
import {
  backgroundUpdateCheck,
  checkForUpdate,
  clearJustUpdated,
  installUpdate,
  isUpdateBlocking,
  justUpdatedTo,
  releaseNoteLines,
  useUpdateState,
} from "./lib/updater";
import { runConfetti } from "./lib/celebrate/celebrate";
import { previewKind } from "./lib/preview";
import { ShareNoteButton } from "./components/ShareNoteButton";
import { listenForNoteLinks } from "./lib/deepLink";
import { useSidebarWidth } from "./lib/useSidebarWidth";
import { useStore } from "./store";

/** How often a running app re-checks for a new release (it also checks at
 *  launch). The check is one cheap GET of the release's static `latest.json`
 *  off GitHub's CDN; 15 minutes keeps a long-running app reasonably current
 *  without pinging GitHub all day. */
const UPDATE_POLL_MS = 15 * 60 * 1000;

/**
 * Every banner in the app slides down out of the chrome it belongs to and
 * collapses its own height on the way out.
 *
 * The height animation is the part that matters: a banner that appears with
 * `display: none → block` shoves the editor down by 44px in one frame, and the
 * eye reads that as the *content* jumping rather than as a message arriving.
 * Animating `height` means the layout opens up for it, so attention follows the
 * banner instead of chasing the text that moved.
 */
function Banner({
  children,
  show,
  className = "",
  role,
}: {
  children: React.ReactNode;
  show: boolean;
  className?: string;
  role?: "status" | "alert";
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className="banner-slot"
          initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={
            reduceMotion
              ? { duration: 0.12 }
              : { type: "spring", stiffness: 380, damping: 34 }
          }
        >
          <div className={`banner ${className}`.trim()} role={role}>
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function RemovedBanner() {
  const noteRemoved = useStore((s) => s.noteRemoved);
  const openNote = useStore((s) => s.openNote);
  return (
    <Banner show={!!noteRemoved && !!openNote}>
      <span>
        <strong>{openNote?.title}</strong> was deleted on disk.
      </span>
      <div className="banner-actions">
        <button className="primary" onClick={() => useStore.getState().closeNote()}>
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
 * and can only offer to close the note. This one knows the delete was intentional
 * and — because inbound deletes move the file rather than unlinking it — can say
 * where the local copy went, which is the difference between a scare and a note.
 */
function DeletedByTeammateBanner() {
  const trashedTo = useStore((s) => s.noteRemovedByTeammate);
  return (
    <Banner show={!!trashedTo}>
      <span>
        A teammate deleted this note. Your copy was moved to <code>{trashedTo}</code>.
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
 * Shown when a vault is active but has no local folder yet (freshly created
 * or joined). Rather than silently reusing whatever folder is open, ask the
 * user to point this vault at its own folder — or start with an empty one.
 */
function VaultFolderPrompt() {
  const pending = useStore((s) => s.pendingVaultFolder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pending) return null;

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
            <p>{pending.reason.text}</p>
            {pending.reason.path && <code>{pending.reason.path}</code>}
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
          <AsyncButton
            className="wf-btn wf-btn-primary"
            disabled={busy}
            spinnerTone="on-accent"
            onClick={run(() => useStore.getState().chooseVaultFolder())}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2" />
              <path d="M3 10h16.5a2 2 0 0 1 1.95 2.46l-1.1 5A2 2 0 0 1 18.4 19H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>Open a folder…</span>
          </AsyncButton>
          <AsyncButton
            className="wf-btn wf-btn-ghost"
            disabled={busy}
            onClick={run(() => useStore.getState().startEmptyVault())}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Start with an empty folder</span>
          </AsyncButton>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Full-screen REQUIRED-update wall. Updates are not optional: the moment a
 * newer version is discovered (at launch or by the background poll) this covers
 * the whole window and the only way forward is "Install & Restart". No "Later".
 *
 * Why a wall and not a bar: every dismissible banner left part of the fleet on
 * old builds, and old builds are exactly where the bugs we just fixed live —
 * one stale client can resurrect deleted folders for a whole team. Keeping
 * everyone on the latest version is a correctness feature here, not a nag.
 *
 * The version is LATCHED: once `available` has been seen, an install error
 * keeps the wall up with a retry rather than letting a known-stale build back
 * in. A failed background *check* (offline launch, dev build without the
 * updater) never had an `available` to latch, so it never walls anything off.
 * Local edits stay safe throughout — notes are on disk, and `installUpdate`
 * flushes the open note before relaunching.
 */
function UpdateGate() {
  const update = useUpdateState();
  const [required, setRequired] = useState<string | null>(null);
  useEffect(() => {
    if (update.phase === "available") setRequired(update.version);
  }, [update]);

  if (!isUpdateBlocking(update) && !(update.phase === "error" && required)) {
    return null;
  }

  const pct =
    update.phase === "downloading" && update.total > 0
      ? Math.round((update.downloaded / update.total) * 100)
      : null;

  return (
    <div className="update-gate" role="alertdialog" aria-modal="true" aria-label="Update required">
      <div className="update-gate-card">
        <Wordmark className="update-gate-logo" />
        <h1>Update required</h1>
        {update.phase === "available" && (
          <>
            <p>
              {BRAND_NAME} <strong>v{update.version}</strong> is ready. Install the update to
              continue using the app — it takes a moment and your notes stay right where they
              are, on your disk.
            </p>
            <AsyncButton className="primary update-gate-cta" onClick={() => installUpdate()}>
              Install &amp; Restart
            </AsyncButton>
          </>
        )}
        {(update.phase === "downloading" || update.phase === "installing") && (
          <>
            <p role="status">
              {update.phase === "installing"
                ? "Installing — the app will restart itself…"
                : `Downloading v${update.version}${pct != null ? ` — ${pct}%` : "…"}`}
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
        {update.phase === "error" && required && (
          <>
            <p>
              The update to <strong>v{required}</strong> didn&rsquo;t finish
              {update.message ? ` — ${update.message}` : ""}. Check your connection and try
              again.
            </p>
            <AsyncButton
              className="primary update-gate-cta"
              onClick={async () => {
                // Re-discover then install: the failed attempt may have died at
                // either stage, and checkForUpdate re-arms the pending update.
                if (await checkForUpdate()) await installUpdate();
              }}
            >
              Try again
            </AsyncButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "What's New" — a centered modal shown on the first launch after an update,
 * with the release's one-liners and a one-shot confetti burst. A modal rather
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
      // A wider cap than the banner's: this is a dialog with room, and a
      // release that changed ten things should say so rather than stop at six.
      setUpdated({ version: stash.version, notes: releaseNoteLines(stash.notes, 12) });
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
              {BRAND_NAME} just updated itself — here&rsquo;s what changed.
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

function SyncIndicator({ noteOpen }: { noteOpen: boolean }) {
  // Per-note sync status (offline / connecting / synced / read-only) PLUS the
  // vault's bulk-run progress, so a vault that is still uploading 380 of its 500
  // notes says so instead of claiming "Synced · just now" off a live socket.
  // With no note open the pill goes vault-wide: it appears whenever a bulk run
  // has something to report and stays put afterwards ("Synced ✓" / "N not
  // synced"), so a fresh hydration is never invisible.
  const status = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const pending = useStore((s) => s.syncPending);
  const progress = useStore((s) => s.syncProgress);
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
      // "N not synced" carries its own remedy: one click re-pulls the registry
      // and re-runs the content pass for everything still unconfirmed.
      onRetry={syncEnabled ? () => void syncManager.retrySync() : undefined}
    />
  );
}

export default function App() {
  const vault = useStore((s) => s.vault);
  const openNote = useStore((s) => s.openNote);
  const switchingVault = useStore((s) => s.switchingVault);
  // Version history is a synced-vault feature: it needs the note's docId on the
  // server. No mapping (local vault, unregistered note) → no history button.
  const versionDocId = useStore((s) => {
    const path = s.openNote?.path;
    return path && s.syncEnabled ? (s.docIdByPath[path] ?? null) : null;
  });
  const versionPanelOpen = useStore((s) => s.versionPanelDocId != null);
  // An open image/PDF preview isn't a synced note — hide the save/sync chrome.
  const isPreview = openNote != null && previewKind(openNote.path) != null;
  const [booting, setBooting] = useState(true);
  const [graphOpen, setGraphOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  // Guards the launch auto-reopen against StrictMode's double-invoke (dev).
  const didAutoReopenRef = useRef(false);

  // The history panel is about ONE note; switching notes under it would leave a
  // list of versions that no longer belong to what's in the editor.
  useEffect(() => {
    useStore.getState().closeVersionPanel();
  }, [openNote?.path]);

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
          await useStore.getState().refreshTree();
          await useStore.getState().refreshTitles();
        }
      } catch (e) {
        console.error("auto-reopen failed", e);
      }
      try {
        await useStore.getState().initAuth();
      } catch (e) {
        console.error("auth init failed", e);
      } finally {
        setBooting(false);
      }
      // Check for updates at launch AND on a background poll, but never install
      // uninvited: a found release raises the required-update wall (UpdateGate),
      // and the download/relaunch waits for the user's "Install & Restart" click.
      // Failures (offline, non-bundled dev build) are swallowed by the updater
      // store — surfaced only in Settings → Updates. App-lifetime interval —
      // never cleared, and the launch guard above keeps it single in dev
      // StrictMode.
      void backgroundUpdateCheck();
      setInterval(() => void backgroundUpdateCheck(), UPDATE_POLL_MS);
    })();
  }, []);

  // Subscribe to Rust events: tree refresh + open-note reconciliation.
  useEffect(() => {
    let unlistenFile: (() => void) | undefined;
    let unlistenVault: (() => void) | undefined;
    // Coalesce sidebar refreshes: a bulk change (e.g. importing a folder) emits
    // many `file-changed` batches in quick succession; refreshing the tree on
    // each one re-renders the whole sidebar repeatedly and flickers hover state.
    // Debounce so a burst settles into a single refresh.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void useStore.getState().refreshTree();
        void useStore.getState().refreshTitles();
        void useStore.getState().refreshBacklinks();
      }, 120);
    };
    (async () => {
      unlistenFile = await ipc.onFileChanged(async (e) => {
        // Attachments are content-synced, not indexed/CRDT-bridged. A change
        // under `attachments/` triggers a debounced two-way blob reconcile.
        if (e.path === "attachments" || e.path.startsWith("attachments/")) {
          syncManager.handleAttachmentChanged();
          scheduleRefresh();
          return;
        }

        // Open-note reconciliation runs immediately (per event); the sidebar
        // refresh is coalesced via scheduleRefresh below.
        const open = useStore.getState().openNote;
        if (open && e.path === open.path) {
          if (e.kind === "removed") {
            useStore.getState().setNoteRemoved(true);
          } else {
            // Route the edit into the bridge; it debounces, drops our own echo,
            // and merges genuine external edits live into the open Y.Text.
            bridgeManager.handleFileChanged(e.path);
          }
        }

        // Refresh tree + titles + backlinks (coalesced for bursts).
        scheduleRefresh();
      });
      unlistenVault = await ipc.onVaultOpened((v) => {
        useStore.getState().setVault(v);
      });
    })();
    return () => {
      unlistenFile?.();
      unlistenVault?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, []);

  // ⌘N / Ctrl+N → new note at vault root.
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
        // ⌘N creates at the vault root, so it honours the same freeze latch as
        // the tree's New-note button — silently writing a root file here would
        // leave it permanently unsyncable (the server refuses to register it).
        if (useStore.getState().rootFrozen) {
          toast(
            "This vault's root is frozen — create this inside a folder instead.",
            "error",
          );
          return;
        }
        try {
          const path = await ipc.createNote("", `Untitled ${Date.now()}`);
          await useStore.getState().refreshTree();
          await useStore.getState().refreshTitles();
          await useStore.getState().openNoteByPath(path);
        } catch (err) {
          console.error(err);
        }
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

  if (booting) {
    return <div className="booting">Loading…</div>;
  }

  if (!vault) {
    // The folder-prompt rides along here too: switching to a synced vault
    // that has no local folder yet (e.g. clicked from the welcome screen) asks
    // the user to choose/create one before its folder opens.
    return (
      <div className="app-shell">
        <UpdateGate />
        <VaultPicker />
        <VaultFolderPrompt />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Window-global, above the sidebar+main split: a new release must be
          visible the moment the poll finds it, whatever is on screen. */}
      <UpdateGate />
      <div
        className="app"
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        {/* Centered overlay, not a sidebar panel — it searches the whole vault
            and its button lives in the main header. */}
        {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
        <aside className="sidebar">
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
        <SidebarResizer width={sidebarWidth} onWidth={setSidebarWidth} />
  
        <main className="main">
          <MemberJoinedBanner />
          <WhatsNewModal />
          {/* Sits flush against the top of the window now that there's no system
              title bar above it (`titleBarStyle: "Overlay"`), which is where the
              reclaimed ~28px comes from — and that makes it the strip you'd expect
              to drag the window by. "deep" hands the whole row over as a drag
              region; Tauri exempts the buttons on the right, so they still click. */}
          <header className="main-header" data-tauri-drag-region="deep">
            <span className="note-title">{openNote?.title ?? "No note open"}</span>
            <SyncIndicator noteOpen={openNote != null && !isPreview} />
            {/* Vault-wide, so it sits in the header regardless of the open note. */}
            <TalkButton />
            {/* Same gate as history: a link is a doc_id, so it only exists for a
                note the server knows about. */}
            {versionDocId && !isPreview && <ShareNoteButton docId={versionDocId} />}
            {versionDocId && !isPreview && (
              <button
                className={`icon-btn history-btn${versionPanelOpen ? " active" : ""}`}
                title="Version history"
                aria-label="Version history"
                aria-pressed={versionPanelOpen}
                onClick={() => {
                  if (versionPanelOpen) useStore.getState().closeVersionPanel();
                  else void useStore.getState().openVersionPanel(versionDocId);
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
                  <path d="M3 12a9 9 0 1 0 2.6-6.4" />
                  <path d="M3 4v4h4" />
                  <path d="M12 8v4l3 2" />
                </svg>
              </button>
            )}
            <button
              className="icon-btn search-btn"
              title="Search notes (⌘F)"
              aria-label="Search notes"
              onClick={() => setSearchOpen((v) => !v)}
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
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </button>
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
          </header>
          <RemovedBanner />
          <DeletedByTeammateBanner />
          <div className="editor-wrap">
            <Editor />
          </div>
          <BacklinksPanel />
          {/* Slides in over the editor from the right; anchored to .main. */}
          <VersionPanel />
        </main>
  
        {graphOpen && (
          <ErrorBoundary
            label="Graph view"
            resetKeys={[graphOpen]}
            onError={() => setGraphOpen(false)}
          >
            <GraphView onClose={() => setGraphOpen(false)} />
          </ErrorBoundary>
        )}
        <VaultFolderPrompt />
        {/* Last child so it layers over everything without a z-index race. */}
        <Toasts />
      </div>
    </div>
  );
}
