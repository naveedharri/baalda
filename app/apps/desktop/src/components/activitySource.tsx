/* The Activity feed's DATA half, mounted once for the whole app
   (`<ActivityHost />` in App.tsx) so the toolbar badge can count unread rows
   while the panel is closed. It owns the fetch schedule (debounced triggers,
   the vault reaching "synced", the server's push that Trash / shrink /
   expired-invitation listings moved, window focus, and a long safety interval
   while the window is visible), the per-vault notice log (`activityLog.ts`)
   and the read state (`activityUnread.ts`). `ActivityFeed.tsx` only renders
   the snapshot. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore, type AccessEvent } from "../store";
import { authManager } from "../lib/auth/authManager";
import {
  ApiError,
  type InvitationExpiry,
  type ShrinkBrakeListing,
  type ShrinkEvent,
  type TrashListing,
} from "../lib/api";
import type { HealthFailures } from "../lib/health/model";
import { syncManager } from "../lib/sync/docSession";
import { reconcileReport, type ReconcileItem, type ReconcileKind } from "../lib/sync/reconcileReport";
import * as ipc from "../lib/ipc";
import { buildActivity, failureEntries, staleFailureIds, type ActivityRow, type FailedEntry } from "./activityRows";
import { ACTIVITY_LOG_MAX_PATHS, appendLog, loadLog, removeFromLog, saveLog, type ActivityLogEntry } from "./activityLog";
import {
  afterClear,
  badgeText,
  loadClearedAt,
  loadReadState,
  markAllRead,
  saveClearedAt,
  saveReadState,
  unreadCount,
  type ReadState,
} from "./activityUnread";
import { planSkipAll, reviewItems, reviewState } from "./reviewModel";

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
/**
 * Safety-net refresh while the window is visible. This used to be the ONLY
 * schedule (60 s), which made Trash + shrink-events about 70% of every request
 * the server saw (#260). The feed now refetches when the vault channel says the
 * listings moved (`activity` frames, and structural `registry` frames — every
 * soft delete is one), when the window regains focus, and when the panel opens;
 * this interval only covers a push lost to a reconnect.
 */
export const REFRESH_INTERVAL_MS = 10 * 60_000;
/**
 * Minimum gap between two PUSH-driven refetches. A busy team's structural churn
 * arrives as several `registry` frames a second; the feed needs to be seconds
 * fresh, not frame-fresh. Trailing: the last push in a burst is always honoured.
 */
export const PUSH_REFRESH_MIN_GAP_MS = 5_000;
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
const NO_SHRINKS: ShrinkEvent[] = [];

function useShrinks(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const onlineRef = useRef(hasSession && syncStatus === "synced");
  onlineRef.current = hasSession && syncStatus === "synced";
  const [items, setItems] = useState<ShrinkEvent[]>(() => (vaultId ? (lastShrinks.get(vaultId) ?? NO_SHRINKS) : NO_SHRINKS));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setItems(vaultId ? (lastShrinks.get(vaultId) ?? NO_SHRINKS) : NO_SHRINKS);
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
  // NEVER a fresh `[]` here: this feeds the rows memo, and a new array on every
  // render re-published the snapshot, which re-rendered App, which re-rendered
  // this host: "Maximum update depth exceeded" on every signed-out/local load.
  return { items: syncEnabled && vaultId ? items : NO_SHRINKS, busy };
}

/** Invitations in this vault that expired unaccepted (#268), on the same
 *  schedule as Trash; the server's `activity` push announces a new one. Last
 *  listing per vault id is kept for offline, like Trash. */
const lastInvitations = new Map<string, InvitationExpiry[]>();
const NO_INVITATIONS: InvitationExpiry[] = [];

function useInvitationExpiries(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  const vaultId = syncManager.registry.vaultId;
  const onlineRef = useRef(hasSession && syncStatus === "synced");
  onlineRef.current = hasSession && syncStatus === "synced";
  const [items, setItems] = useState<InvitationExpiry[]>(() =>
    vaultId ? (lastInvitations.get(vaultId) ?? NO_INVITATIONS) : NO_INVITATIONS,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setItems(vaultId ? (lastInvitations.get(vaultId) ?? NO_INVITATIONS) : NO_INVITATIONS);
  }, [vaultId]);
  useEffect(() => {
    if (!syncEnabled || !vaultId || !onlineRef.current) return;
    let cancelled = false;
    setBusy(true);
    authManager.api.listInvitationExpiries(vaultId).then(
      (list) => {
        if (cancelled) return;
        lastInvitations.set(vaultId, list);
        setItems(list);
        setBusy(false);
      },
      // An older server without the route (404) or a refusal: no Expired rows,
      // and no error line; the rest of the feed is unaffected.
      (e) => {
        if (cancelled) return;
        console.warn("[activity] invitation expiries unavailable", e);
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [syncEnabled, vaultId, nonce]);
  // Never a fresh `[]`: see useShrinks.
  return { items: syncEnabled && vaultId ? items : NO_INVITATIONS, busy };
}

/** Sync pauses (shrink brake holds, #252) on the same schedule as the shrink
 *  events, and refetched the same way: the server's `activity` push fires on
 *  every engage and release. Owners/admins get the whole vault's (with
 *  Release); anyone else only their own. */
const lastBrakes = new Map<string, ShrinkBrakeListing>();
const NO_BRAKES: ShrinkBrakeListing = { items: [], canRelease: false };

function useBrakes(nonce: number) {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const hasSession = useStore((s) => s.session != null);
  const syncStatus = useStore((s) => s.vaultSyncStatus);
  // Our own pause starting or ending is news for this listing too.
  const pauseSince = useStore((s) => s.syncPause?.since ?? null);
  const vaultId = syncManager.registry.vaultId;
  const onlineRef = useRef(hasSession && syncStatus === "synced");
  onlineRef.current = hasSession && syncStatus === "synced";
  const [listing, setListing] = useState<ShrinkBrakeListing>(() =>
    vaultId ? (lastBrakes.get(vaultId) ?? NO_BRAKES) : NO_BRAKES,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setListing(vaultId ? (lastBrakes.get(vaultId) ?? NO_BRAKES) : NO_BRAKES);
  }, [vaultId]);
  useEffect(() => {
    if (!syncEnabled || !vaultId || !onlineRef.current) return;
    let cancelled = false;
    setBusy(true);
    const since = new Date(Date.now() - SHRINK_DAYS * 86_400_000).toISOString();
    authManager.api.listShrinkBrakes(vaultId, since).then(
      (l) => {
        if (cancelled) return;
        lastBrakes.set(vaultId, l);
        setListing(l);
        setBusy(false);
      },
      // An older server without the route (404): no Paused rows, no error line.
      (e) => {
        if (cancelled) return;
        console.warn("[activity] sync pauses unavailable", e);
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
      setBusy(false);
    };
  }, [syncEnabled, vaultId, nonce, pauseSince]);
  return { listing: syncEnabled && vaultId ? listing : NO_BRAKES, busy };
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
const NO_ACCESS: AccessEvent[] = [];

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
  /** Activity → Clear: hide every row so far and stop pending reviews asking. */
  clear: () => void;
  /** Drop one logged Failed row (Retry on a note that already synced). */
  dismissFailure: (key: string) => void;
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
  dismissFailure: () => {},
  clear: () => {},
};

let snapshot: ActivitySnapshot = EMPTY;
const listeners = new Set<() => void>();
function sameSnapshot(a: ActivitySnapshot, b: ActivitySnapshot): boolean {
  return (Object.keys(a) as (keyof ActivitySnapshot)[]).every((k) => Object.is(a[k], b[k]));
}

/** Notify only on a real change: a republish of equal fields is a no-op, so
 *  a subscriber's re-render can never feed back into another publish. */
function publish(next: ActivitySnapshot): void {
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.warn("[activity] listener threw", e);
    }
  }
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Just the unread count, for the toolbar: App re-renders only when the NUMBER
 *  changes, never on a row refresh. */
export function useActivityUnread(): number {
  return useSyncExternalStore(subscribe, () => snapshot.unread, () => 0);
}

/** The toolbar panel toggle's unread pill (renders inside the button). Its own
 *  component, so a throw here is caught by a boundary instead of taking <App>. */
export function ActivityBadge() {
  const unread = useActivityUnread();
  if (unread <= 0) return null;
  return (
    // The number joins the button's accessible name ("Panel 3").
    <span className="panel-btn-badge" title={`${unread} new in Activity`}>
      {badgeText(unread)}
    </span>
  );
}


export function useActivitySnapshot(): ActivitySnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

function reconcileFromLog(e: ActivityLogEntry): ReconcileItem {
  return { kind: e.kind as ReconcileKind, docId: e.docId, path: e.path, newPath: e.newPath, detail: e.detail, at: e.at };
}

function accessFromLog(e: ActivityLogEntry, vaultId: string | null): AccessEvent | null {
  if (e.detail?.startsWith("granted:")) {
    return { kind: "granted", at: e.at, vaultId, count: Number(e.detail.slice(8)) || 0, paths: e.paths };
  }
  if (!e.docId) return null;
  return { kind: "removed", at: e.at, vaultId, docId: e.docId, path: e.path, ...(e.detail === "removed:self" ? { self: true } : {}) };
}

function accessLogEntry(e: AccessEvent): ActivityLogEntry {
  return e.kind === "removed"
    ? { id: `a:r:${e.docId}@${e.at}`, kind: "access", path: e.path, docId: e.docId, detail: e.self ? "removed:self" : "removed", at: e.at }
    : {
        id: `a:g@${e.at}`,
        kind: "access",
        path: "",
        detail: `granted:${e.count}`,
        paths: e.paths?.slice(0, ACTIVITY_LOG_MAX_PATHS),
        at: e.at,
      };
}

/** Renders nothing. Mount once, above the panel. */
export function ActivityHost(): null {
  const { nonce, schedule } = useAutoRefresh();
  const root = useStore((s) => s.vault?.path ?? null);
  const [reconcile, setReconcile] = useState<ReconcileItem[]>(() => reconcileReport.items());
  const trash = useTrash(nonce);
  const { copies, error: copiesError, busy: copiesBusy } = useCopies(nonce);
  const shrinks = useShrinks(nonce);
  const invitations = useInvitationExpiries(nonce);
  const brakes = useBrakes(nonce);
  const selfId = useStore((s) => s.session?.user.id ?? null);
  const failures = useFailures(nonce);
  const pendingDelete = useStore((s) => s.structureNotice?.pendingDelete ?? null);
  const accessEvents = useStore((s) => s.accessEvents ?? NO_ACCESS);
  const vaultSyncStatus = useStore((s) => s.vaultSyncStatus);
  const onActivity = useStore((s) => s.rightPanel?.tab === "activity");
  const vaultId = syncManager.registry.vaultId ?? null;
  const updating = useSlow(trash.busy || copiesBusy || shrinks.busy || invitations.busy || brakes.busy);

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
  const dismissFailure = useCallback((key: string) => forget([key]), [forget]);

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
    // The server's push (#260). A hidden window skips it: becoming visible
    // refetches anyway (below), so nothing pushed meanwhile is missed.
    // Window focus rides the same throttle: alt-tabbing back and forth must not
    // cost a Trash + shrink-events pair each time.
    let lastPush = 0;
    let trailing: number | null = null;
    const throttled = () => {
      if (document.visibilityState !== "visible" || trailing != null) return;
      const wait = lastPush + PUSH_REFRESH_MIN_GAP_MS - Date.now();
      const run = () => {
        trailing = null;
        lastPush = Date.now();
        schedule();
      };
      if (wait <= 0) run();
      else trailing = window.setTimeout(run, wait);
    };
    syncManager.setActivityChangedListener(throttled);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") schedule();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => document.visibilityState === "visible" && schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", throttled);
    return () => {
      syncManager.setActivityChangedListener(undefined);
      if (trailing != null) window.clearTimeout(trailing);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", throttled);
    };
  }, [schedule]);

  // ── Rows ──
  const activeFailures = useMemo(() => new Set(failures.map((f) => f.key)), [failures]);
  useEffect(() => {
    // A logged failure whose note has since synced: drop it, or the row would
    // say Failed beside a green dot for good.
    const stale = staleFailureIds(log, activeFailures, (id) => syncManager.registry.isPushed(id));
    if (stale.length > 0) forget(stale);
  }, [log, activeFailures, forget]);
  const allRows = useMemo(() => {
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
      brakes: { items: brakes.listing.items, canRelease: brakes.listing.canRelease, selfId },
      access,
      failures: failed,
      invitations: invitations.items,
    });
  }, [log, reconcile, trash.listing, copies, pendingDelete, shrinks.items, invitations.items, brakes.listing, selfId, failures, vaultId]);

  // ── Clear ──
  const [clearedAt, setClearedAt] = useState(() => (root ? loadClearedAt(root) : 0));
  useEffect(() => {
    setClearedAt(root ? loadClearedAt(root) : 0);
  }, [root]);
  const rows = useMemo(() => afterClear(allRows, clearedAt), [allRows, clearedAt]);
  const allRowsRef = useRef(allRows);
  allRowsRef.current = allRows;
  const clear = useCallback(() => {
    if (!root) return;
    // Past the newest row too, in case a clock put one slightly ahead of now.
    let at = Date.now();
    for (const r of allRowsRef.current) if (r.at > at) at = r.at;
    saveClearedAt(root, at);
    setClearedAt(at);
    // Pending reviews stop asking (skipped, never deleted), so the toolbar's
    // "Review changes" and the banner's count go too, and the next launch does
    // not seed them again.
    reviewState.set(planSkipAll(reviewItems(reconcileReport.items()), reviewState.get()));
  }, [root]);

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
      clear,
      dismissFailure,
    });
  }, [rows, unread, activeFailures, trash.online, trash.listing, trash.error, copiesError, updating, schedule, clear, dismissFailure]);
  useEffect(() => () => publish(EMPTY), []);
  return null;
}
