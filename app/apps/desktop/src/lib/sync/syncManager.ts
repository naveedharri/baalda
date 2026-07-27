// Per-doc network sync (spec 03 §4/§7, 04 §4). Composes a HocuspocusProvider on
// TOP of the bridge's local-first Y.Doc: the same doc is persisted to SQLite by
// the bridge AND synced to the server here. Offline edits accumulate locally and
// merge conflict-free on reconnect via SyncStep1/2 (the provider handles backoff).
//
// Auth: each connection carries a short-lived per-doc JWT minted from the Better
// Auth session (`POST /api/sync-token`). The provider's `token` is a function, so
// every (re)connect re-mints a fresh token; a proactive timer reconnects shortly
// before expiry (Hocuspocus doesn't re-auth mid-connection — spec 03 §7).

import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { ApiClient, ApiError } from "../api";
import { TokenRefreshScheduler } from "./tokenRefresh";

export type SyncStatus =
  | "offline" // no network provider / signed out
  | "connecting" // socket up, initial sync not complete
  | "synced" // read-write, converged with server
  | "read-only" // synced but the grant is view-only
  | "no-access" // server refused a token (403) — not shared with this user
  | "error"; // transient failure (will retry)

export interface DocSyncOptions {
  api: ApiClient;
  doc: Y.Doc;
  docId: string;
  vaultId: string;
  /** Base ws:// URL. Defaults to `deriveWsUrl(api base)` (see its doc). */
  wsUrl?: string;
  onStatus?: (status: SyncStatus) => void;
  /**
   * Fired when the set of *unsynced* local changes opens/closes: `true` the
   * moment a local edit is made (not yet acked by the server), `false` once
   * everything has flushed. Drives the "Saving…" badge state.
   */
  onPending?: (pending: boolean) => void;
  /**
   * Fired each time all local changes have been acknowledged by the server
   * (unsynced count hit 0). This — not the one-time initial "synced" — is the
   * real "last synced just now" signal during an active editing session.
   */
  onFlushed?: () => void;
  /**
   * How long (ms) the "Saving…" state lingers after the last change flushes
   * before easing to "Synced". Smooths the badge so a burst of keystrokes (whose
   * unsynced count bounces 0↔1 between acks) reads as one continuous "Saving…"
   * instead of flickering. Default 700ms.
   */
  settleDelayMs?: number;
  /** Injected in tests (Node lacks a global WebSocket the provider likes). */
  webSocketPolyfill?: unknown;
}

/** Decode a JWT's `exp` (seconds since epoch) without verifying the signature. */
export function jwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? atob(payload)
        : Buffer.from(payload, "base64").toString("binary");
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/** Seconds until a token expires, floored at 0 (uses `nowMs` for testability). */
export function ttlFromToken(token: string, nowMs = Date.now()): number {
  const exp = jwtExpSeconds(token);
  if (exp == null) return 600; // fall back to the server default TTL
  return Math.max(0, exp - Math.floor(nowMs / 1000));
}

/**
 * Derive the sync WebSocket URL from the HTTP base.
 *
 * Two server topologies, two rules:
 *  - Local/self-hosted dev (explicit port 3010, README "Ports" default): the
 *    dedicated Hocuspocus port 3011 is still separate from the HTTP API, so we
 *    just swap scheme http→ws and bump 3010→3011, path untouched. Kept for
 *    back-compat with existing dev setups and older self-hosted servers.
 *  - Everything else — no port (a normal hosted domain) or any other explicit
 *    port (e.g. a PaaS-assigned :8080) — assumes the single-port topology: the
 *    WS upgrade is mounted at `/sync` on the SAME origin/port as the HTTP API.
 *    We swap scheme and append `/sync` after any existing path (preserving a
 *    reverse-proxy sub-path prefix), collapsing double/trailing slashes. This
 *    is what lets the server run behind one domain on PaaS hosts.
 *
 * Unparseable input falls back to the legacy local default.
 */
export function deriveWsUrl(httpBase: string): string {
  try {
    const u = new URL(httpBase);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (u.port === "3010") {
      u.port = "3011";
    } else {
      const prefix = u.pathname.replace(/\/+$/, "");
      u.pathname = `${prefix}/sync`;
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "ws://localhost:3011";
  }
}

export class DocSync {
  readonly provider: HocuspocusProvider;
  readonly awareness: Awareness;

  private readonly api: ApiClient;
  private readonly docId: string;
  private readonly onStatus?: (status: SyncStatus) => void;
  private readonly onPending?: (pending: boolean) => void;
  private readonly onFlushed?: () => void;
  private readonly settleDelayMs: number;
  private readonly refresher: TokenRefreshScheduler;

  private _status: SyncStatus = "connecting";
  private _readOnly = false;
  private _pending = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectPending = false;
  /**
   * Consecutive auth rejections, driving the backoff below. Reset the moment a
   * connection authenticates (onSynced/connected), so a single expiry still
   * reconnects instantly and only a genuinely stuck token backs off.
   */
  private authFailures = 0;
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DocSyncOptions) {
    this.api = opts.api;
    this.docId = opts.docId;
    this.onStatus = opts.onStatus;
    this.onPending = opts.onPending;
    this.onFlushed = opts.onFlushed;
    this.settleDelayMs = opts.settleDelayMs ?? 700;

    const wsUrl = opts.wsUrl ?? deriveWsUrl(this.api.getBaseUrl());
    const name = `vault:${opts.vaultId}/note:${opts.docId}`;

    this.refresher = new TokenRefreshScheduler(() => this.reconnectWithFreshToken());

    this.provider = new HocuspocusProvider({
      url: wsUrl,
      name,
      document: opts.doc,
      // A token *function* → the provider re-mints on every (re)connect.
      token: async () => (await this.mintToken()) ?? "",
      ...(opts.webSocketPolyfill
        ? { WebSocketPolyfill: opts.webSocketPolyfill as typeof WebSocket }
        : {}),
      onAuthenticationFailed: () => {
        // Token rejected/expired. If we still have access, a reconnect re-mints;
        // if the mint itself 403s, mintToken() sets 'no-access' and we stop.
        //
        // This MUST back off. Reconnecting immediately makes rejection
        // self-sustaining whenever the re-mint can't produce a usable token
        // (mintToken() returning null yields the empty-string token below, which
        // the server always rejects): reject → reconnect → reject, as fast as the
        // socket can cycle. That spins the CPU, floods the server log, and — since
        // each lap flips status error→connecting→error — strobes the sync badge.
        if (!this.destroyed && this._status !== "no-access") {
          this.setStatus("error");
          this.scheduleAuthRetry();
        }
      },
      onClose: ({ event }) => {
        // Hocuspocus v4 kicks a doc connection IN-BAND: `closeConnections` on
        // the server detaches the doc and sends a Close *message* while the
        // websocket stays open (one socket can multiplex many docs). No
        // socket-level event fires, so a server-side kick — lock/unlock, share
        // change, revocation — would otherwise be invisible here and the editor
        // would keep its stale grant until the note is reopened. An open socket
        // is what distinguishes the in-band kick from a real disconnect (which
        // the provider's own backoff already handles).
        if (this.destroyed || this._status === "no-access") return;
        const ws = this.provider.configuration.websocketProvider?.webSocket;
        if (event.code === 1000 && ws && ws.readyState === ws.OPEN) {
          this.reconnectWithFreshToken();
        }
      },
      onStatus: ({ status }) => {
        if (this.destroyed) return;
        if (status === "connected") {
          // Connected means the server accepted our token, so the streak is over.
          this.noteAuthSuccess();
          this.setStatus(this._readOnly ? "read-only" : "synced");
        } else if (status === "connecting") {
          // `no-access` is TERMINAL and must survive this. The provider runs its
          // own reconnect loop, and each lap emits "connecting" — which used to
          // overwrite no-access, reopening the guard on every other handler here.
          // A doc we've been refused then retried forever: 403 → no-access →
          // "connecting" clears it → empty token → rejected → repeat, ~4×/second.
          if (this._status === "no-access") return;
          this.setStatus("connecting");
        } else if (status === "disconnected") {
          if (this._status !== "no-access") this.setStatus("offline");
        }
      },
      onSynced: () => {
        if (!this.destroyed && this._status !== "no-access") {
          this.noteAuthSuccess();
          this.setStatus(this._readOnly ? "read-only" : "synced");
        }
      },
      // Fires on every local edit (count→>0) and every server ack (count→…→0).
      // The provider only decrements toward 0 as the server acknowledges each
      // update, so `number === 0` means the latest edit is durably on the
      // server — the true "synced just now" moment (spec 03 §4). While offline
      // the count stays >0 (no acks), so we correctly show "Saving…"/pending.
      onUnsyncedChanges: ({ number }: { number: number }) => {
        if (this.destroyed) return;
        if (number > 0) {
          // An edit is outstanding — show "Saving…" at once and cancel any
          // in-flight settle so a typing burst stays continuous.
          if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
          }
          this.setPending(true);
          return;
        }
        // Everything acked. Debounce the ease to "Synced" so the rapid 0↔1
        // bounce between keystrokes doesn't flicker the badge.
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          if (this.destroyed || this._status === "no-access") return;
          const wasPending = this._pending;
          this.setPending(false);
          // Only stamp "synced just now" on the real pending→settled edge.
          if (wasPending) this.onFlushed?.();
        }, this.settleDelayMs);
      },
    });

    this.awareness = this.provider.awareness as Awareness;
  }

  get status(): SyncStatus {
    return this._status;
  }
  get readOnly(): boolean {
    return this._readOnly;
  }
  get isSynced(): boolean {
    return this.provider.isSynced;
  }

  /** Resolve once the initial server sync completes (or reject on no-access). */
  whenSynced(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.provider.isSynced) return resolve();
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.provider.off("synced", onSynced);
        fn();
      };
      const onSynced = () => finish(resolve);
      this.provider.on("synced", onSynced);
      const timer = setTimeout(() => finish(resolve), timeoutMs); // resolve anyway → offline-first
      // If access was already refused, don't wait the full timeout.
      if (this._status === "no-access") finish(() => reject(new Error("no access")));
    });
  }

  /**
   * Reconnect after an auth rejection, with exponential backoff + jitter.
   *
   * 500ms → 1s → 2s … capped at 30s, jittered 50–100% so many open docs don't
   * retry in lockstep. The first retry is quick because the common cause is a
   * token that expired a moment ago and a fresh mint just works; the cap is what
   * stops a persistently-unusable session (expired login, revoked account) from
   * turning into an unbounded reconnect storm.
   */
  private scheduleAuthRetry(): void {
    if (this.destroyed || this.authRetryTimer) return;
    const backoff = Math.min(30_000, 500 * 2 ** this.authFailures);
    const delay = backoff * (0.5 + 0.5 * Math.random());
    this.authFailures++;
    this.authRetryTimer = setTimeout(() => {
      this.authRetryTimer = null;
      if (this.destroyed || this._status === "no-access") return;
      this.reconnectWithFreshToken();
    }, delay);
  }

  /** A connection authenticated: forget the failure streak. */
  private noteAuthSuccess(): void {
    this.authFailures = 0;
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
  }

  private async mintToken(): Promise<string | null> {
    try {
      const res = await this.api.syncToken(this.docId);
      this._readOnly = res.readOnly;
      // (Re)arm refresh based on the real token TTL.
      this.refresher.schedule(ttlFromToken(res.token));
      // A minted token is NOT a connected socket. Claiming "synced" here (and,
      // via setSyncStatus, stamping lastSyncedAt) painted a green "Synced · just
      // now" before the server had even seen the token — so a token the server
      // then rejected still flashed success first. Read-only is a property of the
      // grant rather than the connection, so it's safe to reflect immediately;
      // "synced" now waits for onStatus/onSynced.
      if (this._status !== "no-access" && res.readOnly) {
        this.setStatus("read-only");
      }
      return res.token;
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        this.setStatus("no-access");
        this.refresher.cancel();
        // Guards alone can't stop this: HocuspocusProvider reconnects on its own
        // schedule, so a refused doc would keep opening sockets (and keep getting
        // rejected) for as long as the note stayed open. Refusal is terminal until
        // something re-opens the note or an ACL change calls refreshAccess(), so
        // take the socket down instead of leaving it to cycle.
        try {
          this.provider.configuration.websocketProvider?.disconnect();
        } catch {
          /* provider already torn down */
        }
        return null;
      }
      // A 401 means the stored session is no longer valid (expired, or the user
      // no longer exists on this server). Re-minting cannot fix that, so treat it
      // as offline and let the backoff stretch out instead of retrying hard.
      this.setStatus(e instanceof ApiError && e.status === 401 ? "offline" : "error");
      return null;
    }
  }

  /**
   * Re-mint this doc's token and reconnect, picking up any permission change
   * (view↔edit, lock/unlock) without a reopen. Called when the vault channel
   * signals an ACL change. Uses the same proven path as the expiry refresher.
   */
  refreshAccess(): void {
    this.reconnectWithFreshToken();
  }

  private reconnectWithFreshToken(): void {
    if (this.destroyed || this.reconnectPending) return;
    const wsp = this.provider.configuration.websocketProvider;
    // v4 gotcha: connect() silently no-ops while the socket status is still
    // "connected" — and disconnect()'s close event only flips it to
    // "disconnected" a tick later. A back-to-back disconnect+connect therefore
    // strands the provider offline forever. Connect only once the close has
    // actually landed (with a timeout fallback in case it never fires).
    this.reconnectPending = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connectNow = () => {
      wsp.off("disconnect", connectNow);
      if (timer) clearTimeout(timer);
      this.reconnectPending = false;
      if (this.destroyed) return;
      try {
        void wsp.connect();
      } catch (e) {
        console.error("[sync] reconnect failed", e);
      }
    };
    if (wsp.status === WebSocketStatus.Disconnected) {
      connectNow();
      return;
    }
    wsp.on("disconnect", connectNow);
    timer = setTimeout(connectNow, 2000);
    try {
      this.provider.disconnect();
    } catch (e) {
      console.error("[sync] disconnect failed", e);
    }
  }

  get pending(): boolean {
    return this._pending;
  }

  private setStatus(s: SyncStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.onStatus?.(s);
  }

  private setPending(p: boolean): void {
    if (this._pending === p) return;
    this._pending = p;
    this.onPending?.(p);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    // A pending auth retry outlives the provider otherwise, reconnecting a doc
    // the user already closed.
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.refresher.cancel();
    try {
      this.provider.destroy();
    } catch {
      /* ignore */
    }
  }
}
