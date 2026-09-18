// The React half of Vault Settings → Health: read the store and the sync layer,
// fold them through the pure model, and expose the actions the page can take.
//
// Everything with a decision in it lives in `model.ts` (pure, tested); this file
// is wiring only. The split is deliberate — the verdict a user is going to trust
// should not be reachable only through a rendered component.
//
// Nothing here invents a server route. Every action is an existing code path:
// the sidebar's own delete, the sync pill's retry, the startup CRDT sweep, the
// copy-link clipboard helper.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import * as ipc from "../ipc";
import { useStore } from "../../store";
import { syncManager } from "../sync/docSession";
import { collectCrdtGarbage } from "../sync/crdtGc";
import { deletePaths } from "../vault/mutatePaths";
import { removeFromOrder } from "../ordering";
import { copyText } from "../clipboard";
import { toast } from "../toast";
import { runCheckAction, type CheckActionDeps } from "./checkActions";
import {
  buildHealthReport,
  composeInspectionVerdict,
  ownerOf,
  safetyLabel,
  type HealthFailures,
  type HealthInput,
} from "./model";
import type {
  HealthActions,
  HealthIssue,
  NoteInspection,
  SyncLogEntry,
  VaultChecks,
  VaultHealthSnapshot,
  VaultStats,
} from "./types";

export interface UseVaultHealthOptions {
  /** Open the billing/upgrade surface. Absent ⇒ the `upgrade` remedy no-ops. */
  onOpenUpgrade?: () => void;
  /** Put the sign-in card up. Absent ⇒ the `sign-in` remedy no-ops. */
  onRequestSignIn?: () => void;
}

/** Empty failure set — what the sync layer reports when it isn't running. */
const NO_FAILURES: HealthFailures = { registry: [], content: [], limitCode: null };

export function useVaultHealth(options: UseVaultHealthOptions = {}): VaultHealthSnapshot {
  const vault = useStore((s) => s.vault);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const syncStatus = useStore((s) => s.syncStatus);
  const authStatus = useStore((s) => s.authStatus);
  const hasSession = useStore((s) => s.session != null);
  const openFolderIsSynced = useStore((s) => s.openFolderIsSynced);
  const syncProgress = useStore((s) => s.syncProgress);
  const lastSyncedAt = useStore((s) => s.lastSyncedAt);
  const serverUrl = useStore((s) => s.serverUrl);
  const docIdByPath = useStore((s) => s.docIdByPath);
  const docSyncState = useStore((s) => s.docSyncState);
  const titles = useStore((s) => s.titles);
  const members = useStore((s) => s.members);

  const [stats, setStats] = useState<VaultStats | null>(null);
  const [checks, setChecks] = useState<VaultChecks | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped by `refresh()` and by any action that changes what a census would
   *  say (reclaim, reset-history). */
  const [nonce, setNonce] = useState(0);

  const vaultPath = vault?.path ?? null;
  const vaultEpoch = vault?.epoch;

  // ── The Rust census ────────────────────────────────────────────────────────
  // Re-run on vault change and on every `refresh()`. A response that lands after
  // the vault moved on is dropped: it describes a folder the page is no longer
  // showing, and the epoch pin only protects Rust's side of that race.
  useEffect(() => {
    if (!vaultPath) {
      setStats(null);
      setChecks(null);
      setStatsError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    // The registry's ids are the second live id space (see `crdtGc.ts`): without
    // them a server-pulled note's history reads as an orphan the sweep then
    // refuses to remove — "18 reclaimable" beside a Reclaim that frees nothing.
    const liveDocs: Record<string, string> = {};
    for (const [path, docId] of Object.entries(useStore.getState().docIdByPath)) {
      liveDocs[docId] = path;
    }
    void ipc
      .vaultStats(liveDocs, vaultEpoch, new Date().setHours(0, 0, 0, 0))
      .then((s) => {
        if (!live) return;
        setStats(s);
        setStatsError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setStats(null);
        setStatsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    // The integrity checks are a SECOND pass, run alongside the census rather
    // than after it: they are slower (they read every file) and the page's
    // headline never waits on them. A failure blanks the checks card only — the
    // census, the verdict and every remedy stay on screen.
    void ipc
      .vaultChecks(liveDocs, vaultEpoch)
      .then((c) => {
        if (live) setChecks(c);
      })
      .catch(() => {
        if (live) setChecks(null);
      });
    return () => {
      live = false;
    };
  }, [vaultPath, vaultEpoch, nonce, docIdByPath]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // ── Sync-layer failures ────────────────────────────────────────────────────
  // `syncFailures()` is a synchronous read of state the sync layer already holds,
  // so there is nothing to poll: re-reading it whenever progress, per-doc state
  // or the socket status moves covers every transition that can create or clear
  // one.
  const failures = useMemo<HealthFailures>(() => {
    try {
      return syncManager.syncFailures();
    } catch {
      return NO_FAILURES;
    }
    // The deps are deliberately the store fields that MOVE when a failure could
    // have appeared or cleared, not the things the body reads: `syncManager` is a
    // process singleton with a stable identity, so listing it would change
    // nothing.
  }, [syncProgress, docSyncState, syncStatus, syncEnabled, nonce]);

  const localNotePaths = useMemo(() => titles.map((t) => t.path), [titles]);

  // ── The sync timeline ──────────────────────────────────────────────────────
  // A ring buffer the sync manager already keeps; this mirrors it into React
  // state and follows it. Deliberately effect + state rather than
  // `useSyncExternalStore`: `syncLog()` hands back a fresh array on every call,
  // which a snapshot-comparing store would treat as a change on every render.
  //
  // Every call is guarded. The log is diagnostics — a sync manager that is not
  // running (or an older one without this plumbing) must leave the page working,
  // not throw it away.
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      if (!live) return;
      try {
        setLog(syncManager.syncLog());
      } catch {
        /* no log available */
      }
    };
    read();
    let off: (() => void) | undefined;
    try {
      off = syncManager.onSyncLog(read);
    } catch {
      /* nothing to subscribe to */
    }
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const report = useMemo(() => {
    const input: HealthInput = {
      syncEnabled,
      syncStatus,
      authStatus,
      hasSession,
      openFolderIsSynced,
      syncProgress,
      lastSyncedAt,
      serverUrl,
      now: Date.now(),
      docIdByPath,
      docSyncState,
      localNotePaths,
      failures,
      stats,
      members,
    };
    return buildHealthReport(input);
  }, [
    syncEnabled,
    syncStatus,
    authStatus,
    hasSession,
    openFolderIsSynced,
    syncProgress,
    lastSyncedAt,
    serverUrl,
    docIdByPath,
    docSyncState,
    localNotePaths,
    failures,
    stats,
    members,
  ]);

  // ── Actions ────────────────────────────────────────────────────────────────
  // Kept in a ref-backed object so the identity is stable across renders: the
  // tab passes these straight to row buttons, and a fresh object every render
  // would defeat any memoisation there.
  const reportRef = useRef(report);
  reportRef.current = report;
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Self-referential on purpose: `applyCheckAction` runs the OTHER actions in
  // this object rather than a second copy of them, so a heal and the per-item
  // button beside it can never drift apart.
  const actions = useMemo<HealthActions>(() => {
    const api: HealthActions = {
      syncNow: () => syncManager.retrySync(),

      retryDoc: (docId: string) => syncManager.retryDoc(docId),

      resetHistory: (docId: string) => syncManager.resetNoteHistory(docId),

      async reclaimOrphans() {
        // The live set must be COMPLETE — Rust refuses an empty one, and an
        // incomplete one would delete a live note's unsynced edits. Reuse the
        // startup sweep's own wiring rather than assembling a second allow-list:
        // it unions the registry's doc ids with the local index's `notes.id`, and
        // the open note is pinned on top.
        const st = useStore.getState();
        const openPath = st.openNote?.path;
        const pinned = openPath ? [st.docIdByPath[openPath]].filter(Boolean) : [];
        const out = await collectCrdtGarbage(
          { registryDocIds: () => syncManager.registry.allDocIds() },
          { epoch: st.vault?.epoch ?? undefined, pinned: pinned as string[] },
        );
        refresh();
        return {
          docsRemoved: out?.docsRemoved ?? 0,
          bytesReclaimed: out?.bytesReclaimed ?? 0,
        };
      },

      openNote(path: string) {
        void useStore.getState().openNoteByPath(path);
      },

      async reveal(path: string) {
        const root = useStore.getState().vault?.path;
        if (!root) return;
        await ipc.revealInFileManager(`${root}/${path}`);
      },

      async deleteNote(path: string) {
        const { failed } = await deleteVaultPaths([path]);
        if (failed.length > 0) throw new Error(failed[0].reason);
        refresh();
      },

      openUpgrade() {
        optionsRef.current.onOpenUpgrade?.();
      },

      requestSignIn() {
        optionsRef.current.onRequestSignIn?.();
      },

      async copyDiagnostics() {
        const text = await buildDiagnostics(reportRef.current, statsRef.current);
        await copyText(text);
        return text;
      },

      async exportCopy(path: string) {
        // The native save dialog decides the destination, so this can never
        // write somewhere the user did not choose. Cancelling returns null and
        // nothing is copied.
        const st = useStore.getState();
        const dest = await ipc.saveFile(basename(path));
        if (!dest) return null;
        await ipc.exportPath(path, dest, st.vault?.epoch);
        toast(`Saved a copy to ${dest}`);
        return dest;
      },

      async copyIssue(issue: HealthIssue) {
        const text = await buildIssueReport(issue, reportRef.current.serverHost);
        await copyText(text);
        return text;
      },

      async reregister(path: string) {
        // The same call `store.openNoteByPath` makes: the local index's doc_id
        // goes with it so the server adopts THIS note's identity rather than
        // forking a second one for the same file.
        const meta = await ipc.getNoteMeta(path).catch(() => null);
        const title = meta?.title ?? basename(path);
        const mapping = await syncManager.registry.registerNote(path, title, meta?.id);
        if (!mapping) {
          throw new Error(
            "This note couldn't be registered: the vault isn't reconciled with the " +
              "server yet. Try again once the connection is back.",
          );
        }
        // Registering creates the row; the content still has to be pushed, and
        // this note is precisely one whose content the server has never had.
        await syncManager.retryDoc(mapping.docId);
        refresh();
      },

      async contactOwner() {
        const st = useStore.getState();
        const owner = ownerOf(st.members);
        const vaultName = st.vault?.name ?? "this vault";
        const me = st.session?.user.email;
        const message =
          `Hi${owner ? ` ${owner.name}` : ""},\n\n` +
          `Could you give me access to the Baalda vault "${vaultName}"? ` +
          `Right now the server refuses to sync it for me.` +
          (me ? ` My account email is ${me}.` : "") +
          `\n\nThanks!`;
        await copyText(message);
        return { owner, message };
      },

      async inspectNote(path: string): Promise<NoteInspection> {
        const st = useStore.getState();
        const epoch = st.vault?.epoch;
        const report = reportRef.current;
        const docId = st.docIdByPath[path] ?? null;

        const [exists, meta] = await Promise.all([
          ipc.noteExists(path, epoch).catch(() => false),
          ipc.getNoteMeta(path).catch(() => null),
        ]);

        // Everything the sync layer already holds for this doc. A manager that
        // is not running answers nothing rather than pretending: every field
        // below then stays at its "we don't know" value, and the verdict says so.
        let probe = {
          pushed: false,
          queued: false,
          diverged: false,
          permanentFailure: null as string | null,
          emptyEverywhere: false,
        };
        if (docId) {
          try {
            probe = syncManager.inspectDoc(docId);
          } catch {
            /* nothing known */
          }
        }

        let historyBytes: number | null = null;
        if (docId) {
          try {
            const state = await ipc.loadYjsState(docId, epoch);
            historyBytes =
              (state.snapshot?.byteLength ?? 0) +
              state.updates.reduce((n, u) => n + u.byteLength, 0);
          } catch {
            historyBytes = null;
          }
        }

        // There is no cheap per-file size IPC, so the only honest source is the
        // census's top-10 list. Absent ⇒ null, which the page renders as
        // "not measured" rather than as a zero.
        const bytes =
          statsRef.current?.largestNotes.find((n) => n.path === path)?.bytes ?? null;

        const issue =
          report.issues.find(
            (i) => (docId != null && i.docId === docId) || (i.path != null && i.path === path),
          ) ?? null;

        const state = docId ? (st.docSyncState[docId] ?? null) : null;

        return {
          path,
          exists,
          docId,
          state,
          pushed: probe.pushed,
          queued: probe.queued,
          diverged: probe.diverged,
          permanentFailure: probe.permanentFailure,
          emptyEverywhere: probe.emptyEverywhere,
          bytes,
          // Rust stores mtimes in SECONDS (`index.rs file_mtime`); everything on
          // this page is ms since epoch. A 0 means "unknown", not 1970.
          mtime: meta && meta.mtime > 0 ? meta.mtime * 1000 : null,
          historyBytes,
          verdict: composeInspectionVerdict({
            exists,
            syncEnabled: st.syncEnabled,
            issue,
            permanentFailure: probe.permanentFailure,
            queued: probe.queued,
            diverged: probe.diverged,
            state,
            pushed: probe.pushed,
            docId,
          }),
          issue,
        };
      },

      async emptyTrash() {
        const st = useStore.getState();
        const out = await ipc.emptyTrash(st.vault?.epoch);
        refresh();
        return out;
      },

      async rebuildIndex() {
        const st = useStore.getState();
        await ipc.rebuildIndex(st.vault?.epoch);
        // The index is what the tree, search and half the census read from, so
        // the page's own numbers are stale the moment this returns.
        await st.refreshTree();
        refresh();
      },

      applyCheckAction(plan, onProgress) {
        // Every dep is an EXISTING path: the sidebar's delete, the sync layer's
        // history reset, the startup sweep, `ipc.createNote`, and the store's
        // rename — which is the one that keeps `doc_id` stable across a move.
        // A heal that wrote to disk by itself would fork notes the moment two
        // devices ran it.
        const epoch = () => useStore.getState().vault?.epoch;
        const deps: CheckActionDeps = {
          deleteNotes: (paths, onStep) => deleteVaultPaths(paths, onStep),
          resetHistory: (docId) => api.resetHistory(docId),
          reclaim: () => api.reclaimOrphans(),
          emptyTrash: () => api.emptyTrash(),
          rebuildIndex: () => api.rebuildIndex(),
          syncNow: () => api.syncNow(),
          pickFolder: () => ipc.pickFolder(),
          exportTo: (path, dest) => ipc.exportPath(path, dest, epoch()),
          readNote: (path) => ipc.readNote(path, epoch()),
          resolveLink: (target) => ipc.resolveWikilink(target).then((r) => r != null),
          async createNote(dir, name) {
            // The root-freeze latch is the sidebar's rule and it applies here
            // too: a vault whose root is frozen does not get notes dropped into
            // it by a heal either.
            if (dir === "" && useStore.getState().rootFrozen) {
              throw new Error("this vault's root is frozen — create it inside a folder");
            }
            return ipc.createNote(dir, name, epoch());
          },
          isFile: (path) => ipc.noteExists(path, epoch()),
          async rename(from, to) {
            await useStore.getState().renameNoteFileExact(from, to);
          },
        };
        return runCheckAction(plan, deps, onProgress);
      },
    };
    return api;
  }, [refresh]);

  // A reset discards history on both sides, so the census it produced is stale.
  // Wrapping here (rather than inside the memo) keeps `actions` stable.
  const wrapped = useMemo<HealthActions>(
    () => ({
      ...actions,
      async resetHistory(docId: string) {
        const out = await actions.resetHistory(docId);
        refresh();
        return out;
      },
    }),
    [actions, refresh],
  );

  return { report, stats, checks, statsError, loading, log, refresh, actions: wrapped };
}

/**
 * The sidebar's delete, for one path or twenty: server row first (so a refusal
 * leaves the file alone instead of producing a reappearing ghost), then disk,
 * then the view state that named the gone paths.
 *
 * One function because the single Delete on a check row and its Delete all are
 * the same operation at two sizes — the bug this whole helper exists to prevent
 * (`vault/mutatePaths.ts`) was two hand-copied deletes drifting apart.
 */
async function deleteVaultPaths(
  paths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ deleted: string[]; failed: Array<{ path: string; reason: string }> }> {
  const st = useStore.getState();
  const { deleted, failed } = await deletePaths(paths, {
    epoch: st.vault?.epoch,
    deleteDisk: (p, epoch) => ipc.deletePath(p, epoch),
    unregister: (p) => syncManager.registry.deletePath(p),
    onProgress,
  });
  if (deleted.length > 0) {
    let order = st.itemOrder;
    for (const path of deleted) order = removeFromOrder(order, path);
    st.setItemOrder(order);
    st.pruneTabs(deleted);
  }
  return { deleted, failed };
}

/** The last path segment — what the save dialog should offer as a filename. */
function basename(path: string): string {
  const seg = path.split("/").pop();
  return seg && seg !== "" ? seg : path;
}

// ── One issue, as text ────────────────────────────────────────────────────────

/**
 * What the `copy-details` remedy puts on the clipboard: everything the page says
 * about ONE issue, in the order it says it, plus the two lines that make a
 * report actionable (the app version and which server this vault talks to).
 *
 * The same honesty rule as the page: this is the explanation the user read, not
 * a re-derivation of it, so a bug report and the screen can never disagree.
 * No secrets — no token, no session, no note content.
 */
export async function buildIssueReport(
  issue: HealthIssue,
  serverHost: string | null,
): Promise<string> {
  let version = "unknown";
  try {
    version = await getVersion();
  } catch {
    /* not running under Tauri */
  }

  const lines: string[] = [];
  lines.push(`Baalda — ${issue.title}`);
  if (issue.path) lines.push(issue.path);
  lines.push("");
  lines.push(issue.why);
  lines.push("");
  lines.push("What this means");
  lines.push(issue.explanation.meaning);
  lines.push("");
  lines.push("What Baalda does next");
  lines.push(issue.explanation.next);
  lines.push("");
  lines.push("What you can do");
  for (const fix of issue.explanation.fixes) lines.push(`- ${fix}`);
  lines.push("");
  lines.push("Where your content is");
  lines.push(safetyLabel(issue.explanation.safety));
  if (issue.facts.length > 0) {
    lines.push("");
    lines.push("Details");
    for (const f of issue.facts) lines.push(`${f.label}: ${f.value}`);
  }
  lines.push("");
  lines.push(`app ${version} · server ${serverHost ?? "(local only)"}`);
  return lines.join("\n");
}

// ── Diagnostics bundle ────────────────────────────────────────────────────────

/**
 * A plain-text dump for a bug report. Deliberately boring and deliberately
 * complete: it is what someone pastes into an issue instead of a screenshot.
 *
 * NO SECRETS. The server URL's host, the vault's name and the two server ids go
 * in — those are what make a report actionable — but never a token, a session,
 * an email, or the contents of any note.
 */
export async function buildDiagnostics(
  report: VaultHealthSnapshot["report"],
  stats: VaultStats | null,
): Promise<string> {
  const st = useStore.getState();
  let version = "unknown";
  try {
    version = await getVersion();
  } catch {
    /* not running under Tauri */
  }
  const platform =
    typeof navigator === "undefined" ? "unknown" : navigator.userAgent || "unknown";

  const lines: string[] = [];
  lines.push("Baalda vault health");
  lines.push(`app: ${version}`);
  lines.push(`platform: ${platform}`);
  lines.push(`server: ${report.serverHost ?? "(local only)"}`);
  lines.push(`vault: ${st.vault?.name ?? "(none)"}`);
  lines.push(`org id: ${st.session?.activeOrganizationId ?? "(none)"}`);
  lines.push(`collection id: ${syncManager.registry.vaultId ?? "(none)"}`);
  lines.push("");
  lines.push(`verdict: ${report.verdict}`);
  lines.push(`headline: ${report.headline}`);
  lines.push(`detail: ${report.detail}`);
  lines.push(
    `last synced: ${report.lastSyncedAt != null ? new Date(report.lastSyncedAt).toISOString() : "never"}`,
  );
  lines.push("");

  const c = report.counts;
  lines.push("counts:");
  if (!c) {
    lines.push("  (sync is off for this vault)");
  } else {
    lines.push(
      `  total=${c.total} synced=${c.synced} pending=${c.pending} ` +
        `failed=${c.failed} unsynced=${c.unsynced} unreported=${c.unreported}`,
    );
  }
  lines.push("");

  lines.push("stages:");
  for (const s of report.stages) {
    lines.push(`  ${s.id} [${s.state}] ${s.headline} — ${s.detail}`);
  }
  lines.push("");

  lines.push(`issues (${report.issues.length}):`);
  if (report.issues.length === 0) lines.push("  (none)");
  for (const i of report.issues) {
    lines.push(
      `  [${i.severity}] ${i.kind}` +
        `${i.code ? ` code=${i.code}` : ""}` +
        `${i.docId ? ` doc=${i.docId}` : ""}` +
        `${i.path ? ` path=${i.path}` : ""}`,
    );
    lines.push(`    ${i.why}`);
  }
  lines.push("");

  lines.push("stats:");
  if (!stats) {
    lines.push("  (not available)");
  } else {
    lines.push(
      `  notes=${stats.notes.count} bytes=${stats.notes.bytes} empty=${stats.notes.empty}`,
    );
    lines.push(
      `  folders=${stats.folders} attachments=${stats.attachments.count}/${stats.attachments.bytes} ` +
        `otherFiles=${stats.otherFiles.count}/${stats.otherFiles.bytes}`,
    );
    lines.push(
      `  tags=${stats.tags} links=${stats.links} brokenLinks=${stats.brokenLinks} ` +
        `index=${stats.index.bytes}`,
    );
    lines.push(
      `  history docs=${stats.history.docs} updates=${stats.history.updates} ` +
        `bytes=${stats.history.bytes} orphans=${stats.history.orphanDocs}/${stats.history.orphanBytes}`,
    );
    lines.push(
      `  activity 7d=${stats.activity.modifiedLast7d} 30d=${stats.activity.modifiedLast30d}`,
    );
  }
  return lines.join("\n");
}
