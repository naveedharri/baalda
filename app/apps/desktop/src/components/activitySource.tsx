/* The Activity feed's DATA half, mounted once for the whole app
   (`<ActivityHost />` in App.tsx) so the toolbar badge can count unread rows
   while the panel is closed. It owns the fetch schedule (debounced triggers,
   the vault reaching "synced", a 60 s interval while the window is visible),
   the per-vault notice log (`activityLog.ts`) and the read state
   (`activityUnread.ts`). `ActivityFeed.tsx` only renders the snapshot. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore, type AccessEvent } from "../store";
import { authManager } from "../lib/auth/authManager";
import { ApiError, type ShrinkEvent, type TrashListing } from "../lib/api";
import type { HealthFailures } from "../lib/health/model";
import { syncManager } from "../lib/sync/docSession";
import { reconcileReport, type ReconcileItem, type ReconcileKind } from "../lib/sync/reconcileReport";
import * as ipc from "../lib/ipc";
import { buildActivity, failureEntries, type ActivityRow, type FailedEntry } from "./activityRows";
import { appendLog, loadLog, removeFromLog, saveLog, type ActivityLogEntry } from "./activityLog";
import { loadReadState, markAllRead, saveReadState, unreadCount, type ReadState } from "./activityUnread";

/** Last Trash listing per server vault id, this app session. Never authorises. */
const lastTrash = new Map<string, { listing: TrashListing; at: number }>();

export function trashErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "This note is no longer in Trash.";
    if (e.status === 403) return "You don't have permission to restore this note.";
    return e.message || `The server refused (${e.status}).`;
  }
  return e instanceof Error ? e.message : String(e);
}


/** Quiet-period before a refresh runs, so a burst of triggers is one fetch. */
const REFRESH_DEBOUNCE_MS = 250;
/** Background refresh while the tab is visible. */
const REFRESH_INTERVAL_MS = 60_000;
/** "Updating…" appears only for a fetch slower than this. */
const SLOW_FETCH_MS = 400;

/** One debounced refresh counter: every trigger calls `schedule`, and a burst
 *  of them bumps `nonce` once. */
function useAutoRefresh() {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setNonce((n) => n + 1);
    }, REFRESH_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  return { nonce, schedule };
}

/** True once `busy` has held for SLOW_FETCH_MS; false as soon as it clears. */
function useSlow(busy: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return;
    }
    const id = window.setTimeout(() => setSlow(true), SLOW_FETCH_MS);
    return () => window.clearTimeout(id);
  }, [busy]);
  return slow;
}

/** The server Trash for the open synced vault, or null (local vault / never fetched).
 *  Fetches on `nonce` only; the parent bumps it when the vault comes online. */
function useTrash(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const online = hasSession && syncStatus === "synced";
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const cached = vaultId ? lastTrash.get(vaultId) : undefined;
  const [listing, setListing] = useState<TrashListing | null>(cached?.listing ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setListing(vaultId ? (lastTrash.get(vaultId)?.listing ?? null) : null);
  }, [vaultId]);

  useEffect(() => {
    if (!syncEnabled || !vaultId || !onlineRef.current) return;
    let cancelled = false;
    setBusy(true);
    authManager.api.listTrash(vaultId).then(
      (l) => {
        if (cancelled) return;
        lastTrash.set(vaultId, { listing: l, at: Date.now() });
        setListing(l);
        setError(null);
        setBusy(false);
      },
      (e) => {
        if (cancelled) return;
        setError(trashErrorMessage(e));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [syncEnabled, vaultId, nonce]);

  return { listing: syncEnabled && vaultId ? listing : null, error, online, busy };
}

function useCopies(nonce: number) {
  const epoch = useStore((s) => s.vault?.epoch);
  const hasVault = useStore((s) => s.vault != null);
  const [copies, setCopies] = useState<ipc.TrashCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!hasVault) return;
    let cancelled = false;
    setBusy(true);
    ipc.listTrashCopies(epoch).then(
      (list) => {
        if (cancelled) return;
        setCopies(list);
        setError(null);
        setBusy(false);
      },
      (e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [hasVault, epoch, nonce]);
  return { copies, error, busy };
}


/** Server `pre-shrink` captures of the last SHRINK_DAYS, on the same schedule
 *  as Trash. Last listing per vault id is kept for offline, like Trash. */
const SHRINK_DAYS = 30;
const lastShrinks = new Map<string, ShrinkEvent[]>();

function useShrinks(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const onlineRef = useRef(hasSession && syncStatus === "synced");
  onlineRef.current = hasSession && syncStatus === "synced";
  const [items, setItems] = useState<ShrinkEvent[]>(() => (vaultId ? (lastShrinks.get(vaultId) ?? []) : []));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setItems(vaultId ? (lastShrinks.get(vaultId) ?? []) : []);
  }, [vaultId]);
  useEffect(() => {
    if (!syncEnabled || !vaultId || !onlineRef.current) return;
    let cancelled = false;
    setBusy(true);
    const since = new Date(Date.now() - SHRINK_DAYS * 86_400_000).toISOString();
    authManager.api.listShrinkEvents(vaultId, since).then(
      (l) => {
        if (cancelled) return;
        lastShrinks.set(vaultId, l.items);
        setItems(l.items);
        setBusy(false);
      },
      // An older server without the route (404) or a refusal: no Shrunk rows,
      // and no error line; the rest of the feed is unaffected.
      (e) => {
        if (cancelled) return;
        console.warn("[activity] shrink events unavailable", e);
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [syncEnabled, vaultId, nonce]);
  return { items: syncEnabled && vaultId ? items : [], busy };
}

/** The failures Health's Needs attention reads, re-read on the same signals. */
function useFailures(nonce: number): FailedEntry[] {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const syncProgress = useStore((s) => s.syncProgress);
  const docSyncState = useStore((s) => s.docSyncState);
  return useMemo(() => {
    if (!syncEnabled) return [];
    let f: HealthFailures | null = null;
    try {
      f = syncManager.syncFailures();
    } catch {
      return [];
    }
    return failureEntries(f);
    // `nonce` re-reads on the feed's own schedule too.
  }, [syncEnabled, syncStatus, syncProgress, docSyncState, nonce]);
}


/** Reconcile kinds that are notices with no durable source of their own. */
const LOGGED_RECONCILE: ReadonlySet<ReconcileKind> = new Set(["restoredFromServer", "folderKept"]);
const HELD_ID = "h:bulk-delete";

export interface ActivitySnapshot {
  rows: ActivityRow[];
  unread: number;
  /** Failure keys sync reports right now (a logged one not in here has no actions). */
  activeFailures: ReadonlySet<string>;
  trashOnline: boolean;
  trashCached: boolean;
  trashTruncated: boolean;
  error: string | null;
  updating: boolean;
  schedule: () => void;
}

const EMPTY: ActivitySnapshot = {
  rows: [],
  unread: 0,
  activeFailures: new Set(),
  trashOnline: false,
  trashCached: false,
  trashTruncated: false,
  error: null,
  updating: false,
  schedule: () => {},
};

let snapshot: ActivitySnapshot = EMPTY;
const listeners = new Set<() => void>();
function publish(next: ActivitySnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

export function useActivitySnapshot(): ActivitySnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

function reconcileFromLog(e: ActivityLogEntry): ReconcileItem {
  return { kind: e.kind as ReconcileKind, docId: e.docId, path: e.path, newPath: e.newPath, detail: e.detail, at: e.at };
}

function accessFromLog(e: ActivityLogEntry, vaultId: string | null): AccessEvent | null {
  if (e.detail?.startsWith("granted:")) {
    return { kind: "granted", at: e.at, vaultId, count: Number(e.detail.slice(8)) || 0 };
  }
  if (!e.docId) return null;
  return { kind: "removed", at: e.at, vaultId, docId: e.docId, path: e.path };
}

function accessLogEntry(e: AccessEvent): ActivityLogEntry {
  return e.kind === "removed"
    ? { id: `a:r:${e.docId}@${e.at}`, kind: "access", path: e.path, docId: e.docId, detail: "removed", at: e.at }
    : { id: `a:g@${e.at}`, kind: "access", path: "", detail: `granted:${e.count}`, at: e.at };
}

/** Renders nothing. Mount once, above the panel. */
export function ActivityHost(): null {
  const { nonce, schedule } = useAutoRefresh();
  const root = useStore((s) => s.vault?.path ?? null);
  const [reconcile, setReconcile] = useState<ReconcileItem[]>(() => reconcileReport.items());
  const trash = useTrash(nonce);
  const { copies, error: copiesError, busy: copiesBusy } = useCopies(nonce);
  const shrinks = useShrinks(nonce);
  const failures = useFailures(nonce);
  const pendingDelete = useStore((s) => s.structureNotice.pendingDelete);
  const accessEvents = useStore((s) => s.accessEvents);
  const vaultSyncStatus = useStore((s) => s.vaultSyncStatus);
  const onActivity = useStore((s) => s.rightPanel?.tab === "activity");
  const vaultId = syncManager.registry.vaultId ?? null;
  const updating = useSlow(trash.busy || copiesBusy || shrinks.busy);

  // ── The notice log: load per vault root, append as notices arrive. ──
  const [log, setLog] = useState<ActivityLogEntry[]>(() => (root ? loadLog(root) : []));
  const logRoot = useRef(root);
  useEffect(() => {
    logRoot.current = root;
    setLog(root ? loadLog(root) : []);
  }, [root]);
  const record = useCallback((entries: ActivityLogEntry[]) => {
    const r = logRoot.current;
    if (!r || entries.length === 0) return;
    setLog((prev) => {
      const next = appendLog(prev, entries, Date.now());
      if (next.length === prev.length && next.every((e, i) => e === prev[i])) return prev;
      saveLog(r, next);
      return next;
    });
  }, []);
  const forget = useCallback((ids: string[]) => {
    const r = logRoot.current;
    if (!r) return;
    setLog((prev) => {
      const next = removeFromLog(prev, ids);
      if (next.length === prev.length) return prev;
      saveLog(r, next);
      return next;
    });
  }, []);

  // A new reconcile item usually means a recovery copy was just written, and
  // a resolved one may have restored or deleted a copy: either way, refetch.
  useEffect(
    () =>
      reconcileReport.subscribe((items) => {
        setReconcile(items);
        schedule();
      }),
    [schedule],
  );
  useEffect(() => {
    record(
      reconcile
        .filter((it) => LOGGED_RECONCILE.has(it.kind))
        .map((it) => ({
          id: `r:${it.kind}:${it.docId ?? it.path}@${it.at}`,
          kind: it.kind as ActivityLogEntry["kind"],
          path: it.path,
          newPath: it.newPath,
          detail: it.detail,
          docId: it.docId,
          at: it.at,
        })),
    );
  }, [reconcile, record, root]);
  useEffect(() => {
    record(accessEvents.filter((e) => e.vaultId === vaultId).map(accessLogEntry));
  }, [accessEvents, vaultId, record, root]);
  useEffect(() => {
    const now = Date.now();
    record(
      failures.map((f) => ({
        id: f.key,
        kind: "failed" as const,
        path: f.path,
        docId: f.docId ?? undefined,
        detail: f.reason,
        at: now,
      })),
    );
  }, [failures, record, root]);
  useEffect(() => {
    if (pendingDelete) {
      record([{ id: HELD_ID, kind: "held", path: "", detail: String(pendingDelete.count), at: Date.now() }]);
    } else if (vaultSyncStatus === "synced") {
      // Live and nothing held: a logged batch from before was answered or undone.
      forget([HELD_ID]);
    }
  }, [pendingDelete, vaultSyncStatus, record, forget, root]);

  // ── Triggers ──
  useEffect(() => {
    if (vaultSyncStatus === "synced") schedule();
  }, [vaultSyncStatus, schedule]);
  useEffect(() => {
    if (onActivity) schedule();
  }, [onActivity, schedule]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") schedule();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [schedule]);

  // ── Rows ──
  const activeFailures = useMemo(() => new Set(failures.map((f) => f.key)), [failures]);
  const rows = useMemo(() => {
    const byId = new Map(log.map((e) => [e.id, e]));
    const seededReconcile = log.filter((e) => LOGGED_RECONCILE.has(e.kind as ReconcileKind)).map(reconcileFromLog);
    const access = log
      .filter((e) => e.kind === "access")
      .map((e) => accessFromLog(e, vaultId))
      .filter((e): e is AccessEvent => e != null);
    // Failures are timed by when the log first saw them, so a restart keeps
    // their place (and their read state). One not logged yet waits a render.
    const failed: (FailedEntry & { at: number })[] = [];
    for (const e of log) {
      if (e.kind !== "failed") continue;
      const live = failures.find((f) => f.key === e.id);
      failed.push(
        live
          ? { ...live, at: e.at }
          : { key: e.id, docId: e.docId ?? null, path: e.path, reason: e.detail ?? "", retryable: false, at: e.at },
      );
    }
    const heldAt = byId.get(HELD_ID)?.at;
    return buildActivity({
      reconcile: [...seededReconcile, ...reconcile],
      trash: trash.listing?.items ?? [],
      copies: copies ?? [],
      held: pendingDelete && heldAt != null ? { count: pendingDelete.count, at: heldAt } : null,
      shrinks: shrinks.items,
      access,
      failures: failed,
    });
  }, [log, reconcile, trash.listing, copies, pendingDelete, shrinks.items, failures, vaultId]);

  // ── Unread ──
  const [readState, setReadState] = useState<ReadState | null>(() => (root ? loadReadState(root) : null));
  useEffect(() => {
    setReadState(root ? loadReadState(root) : null);
  }, [root]);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    if (!onActivity || !visible || !readState || !root) return;
    const next = markAllRead(readState, rows);
    if (next === readState) return;
    saveReadState(root, next);
    setReadState(next);
  }, [onActivity, visible, readState, rows, root]);
  const unread = readState && !(onActivity && visible) ? unreadCount(rows, readState) : 0;

  useEffect(() => {
    publish({
      rows,
      unread,
      activeFailures,
      trashOnline: trash.online,
      trashCached: trash.listing != null,
      trashTruncated: trash.listing?.truncated === true,
      error: trash.error ?? copiesError,
      updating,
      schedule,
    });
  }, [rows, unread, activeFailures, trash.online, trash.listing, trash.error, copiesError, updating, schedule]);
  useEffect(() => () => publish(EMPTY), []);
  return null;
}
