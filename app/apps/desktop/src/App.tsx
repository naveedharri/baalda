import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AccountMenu } from "./components/AccountMenu";
import { TalkButton } from "./components/TalkButton";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileTree } from "./components/FileTree";
import { GraphView } from "./components/GraphView";
import { SyncBadge } from "./components/Identity";
import { SearchPanel } from "./components/SearchPanel";
import { SidebarHeader } from "./components/SidebarHeader";
import { VaultPicker } from "./components/VaultPicker";
import { bridgeManager } from "./lib/bridge";
import { BRAND_NAME } from "./lib/brand";
import * as ipc from "./lib/ipc";
import { syncManager } from "./lib/sync/docSession";
import { checkForUpdate, installUpdate, useUpdateState } from "./lib/updater";
import { runConfetti } from "./lib/celebrate/celebrate";
import { previewKind } from "./lib/preview";
import { useStore } from "./store";

function RemovedBanner() {
  const noteRemoved = useStore((s) => s.noteRemoved);
  const openNote = useStore((s) => s.openNote);
  if (!noteRemoved || !openNote) return null;
  return (
    <div className="banner">
      <span>
        <strong>{openNote.title}</strong> was deleted on disk.
      </span>
      <div className="banner-actions">
        <button className="primary" onClick={() => useStore.getState().closeNote()}>
          Close note
        </button>
      </div>
    </div>
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

  if (!memberJoined) return null;

  return (
    <>
      <canvas ref={canvasRef} className="celebrate-confetti" aria-hidden="true" />
      <div className="banner celebrate-banner" role="status">
        <span>
          🎉 <strong>{memberJoined.name}</strong> joined the vault
        </span>
        <div className="banner-actions">
          <button
            className="secondary"
            onClick={() => useStore.getState().dismissMemberJoined()}
          >
            Dismiss
          </button>
        </div>
      </div>
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
        <div className="wf-badge" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </div>
        <h2 className="wf-title">
          Set up <strong>{pending.orgName}</strong>
        </h2>
        <p className="wf-desc">
          Choose the local folder this vault syncs to. Each vault keeps its own
          folder — separate from your other vaults.
        </p>
        <div className="vault-folder-actions">
          <button
            className="wf-btn wf-btn-primary"
            disabled={busy}
            onClick={run(() => useStore.getState().chooseVaultFolder())}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2" />
              <path d="M3 10h16.5a2 2 0 0 1 1.95 2.46l-1.1 5A2 2 0 0 1 18.4 19H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>Open a folder…</span>
          </button>
          <button
            className="wf-btn wf-btn-ghost"
            disabled={busy}
            onClick={run(() => useStore.getState().startEmptyVault())}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Start with an empty folder</span>
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {pending.previousOrgId && (
          <button
            className="link-btn"
            disabled={busy}
            onClick={run(() => useStore.getState().cancelVaultFolder())}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Non-blocking bar shown when a newer version is published. The launch-time
 * check (in App) populates the shared updater state; this just renders it.
 * Errors and the "up to date" result are intentionally silent here — those
 * only surface when the user checks manually from Settings → Updates.
 */
function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const update = useUpdateState();

  if (update.phase === "available" && dismissed) {
    return null;
  }

  if (update.phase === "available") {
    return (
      <div className="banner update-banner">
        <span>
          A new version of {BRAND_NAME} (<strong>{update.version}</strong>) is
          available.
        </span>
        <div className="banner-actions">
          <button className="primary" onClick={() => void installUpdate()}>
            Install &amp; Restart
          </button>
          <button className="secondary" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      </div>
    );
  }

  if (update.phase === "downloading" || update.phase === "installing") {
    const pct =
      update.phase === "downloading" && update.total > 0
        ? Math.round((update.downloaded / update.total) * 100)
        : null;
    return (
      <div className="banner update-banner">
        <span>
          {update.phase === "installing"
            ? "Installing update — the app will restart…"
            : `Downloading update${pct != null ? ` — ${pct}%` : "…"}`}
        </span>
      </div>
    );
  }

  return null;
}

function SaveIndicator() {
  // The CRDT bridge autosaves to disk on a debounce, so the note is always
  // being persisted; there is no "unsaved" state to surface anymore.
  return <span className="save-indicator saved">Auto-saved</span>;
}

function SyncIndicator() {
  // Per-note sync status (offline / connecting / synced / read-only) PLUS the
  // vault's bulk-run progress, so a vault that is still uploading 380 of its 500
  // notes says so instead of claiming "Synced · just now" off a live socket.
  const status = useStore((s) => s.syncStatus);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const pending = useStore((s) => s.syncPending);
  const progress = useStore((s) => s.syncProgress);
  return (
    <SyncBadge
      status={status}
      enabled={syncEnabled}
      lastSyncedAt={lastSyncedAt}
      pending={pending}
      progress={progress}
    />
  );
}

export default function App() {
  const vault = useStore((s) => s.vault);
  const openNote = useStore((s) => s.openNote);
  // An open image/PDF preview isn't a synced note — hide the save/sync chrome.
  const isPreview = openNote != null && previewKind(openNote.path) != null;
  const [booting, setBooting] = useState(true);
  const [graphOpen, setGraphOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Guards the launch auto-reopen against StrictMode's double-invoke (dev).
  const didAutoReopenRef = useRef(false);

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
      // Check for app updates once on launch. Failures (e.g. offline, or a
      // non-bundled dev build) are swallowed by the updater store — the banner
      // only appears when an update is genuinely available.
      void checkForUpdate();
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
      <>
        <VaultPicker />
        <VaultFolderPrompt />
      </>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <SidebarHeader />
        {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
        <FileTree />
        <div className="sidebar-footer">
          <AccountMenu />
        </div>
      </aside>

      <main className="main">
        <MemberJoinedBanner />
        <UpdateBanner />
        <header className="main-header">
          <span className="note-title">{openNote?.title ?? "No note open"}</span>
          {openNote && !isPreview && <SaveIndicator />}
          {openNote && !isPreview && <SyncIndicator />}
          {/* Vault-wide, so it sits in the header regardless of the open note. */}
          <TalkButton />
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
        <div className="editor-wrap">
          <Editor />
        </div>
        <BacklinksPanel />
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
    </div>
  );
}
