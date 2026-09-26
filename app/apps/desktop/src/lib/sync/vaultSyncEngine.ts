// Vault Sync Engine (spec 05 §3.3) — the client half of the always-on, vault-wide
// background feed. ONE WebSocket per vault to `/vault-sync`. On connect it mints a
// vault-scoped token and sends a `hello` carrying a per-doc state-vector manifest
// (so the server streams only what's missing) plus a priority list of recently
// touched docs. Inbound binary frames are routed to a `DocUpdateSink` (the bridge
// tiering in Phase D); control frames drive status + drops. Reconnects use
// jittered exponential backoff so a server restart doesn't stampede.
//
// This is what decouples sync from "opening a note": every authorized doc stays
// current on disk regardless of the UI. The engine itself never touches disk or
// CodeMirror — it moves opaque Yjs updates to the sink.

import { ApiClient, ApiError } from "../api";
import { markOnce } from "../perf";
import type { ActivityStatus } from "../prefs";
import {
  bytesToBase64,
  decodeUpdateFrame,
  decodeVoiceFrame,
  encodeHello,
  encodePresence,
  encodeVoiceFrame,
  isVoiceFrame,
  parseServerControl,
  CLIENT_CAPS,
  type VoiceFrame,
  type VoiceHeader,
} from "./vaultProtocol";

/** A teammate's live viewing state, surfaced to the UI for sidebar presence. */
export interface VaultPeer {
  userId: string;
  /** The note they're currently viewing, or null when not on any note. */
  docId: string | null;
  name: string;
  color: string;
  status: ActivityStatus;
}

/** What this client broadcasts about itself over the vault channel. */
export interface LocalPresence {
  docId: string | null;
  name: string;
  color: string;
  status: ActivityStatus;
}

export type VaultSyncStatus =
  | "idle" // not started / stopped
  | "connecting" // socket opening or backfilling
  | "synced" // backfill drained; live
  | "no-access" // token mint 403 — not a member; stop retrying
  | "error"; // transient; will reconnect

/**
 * What the engine reads from and writes to. Implemented by the bridge tiering
 * layer (Phase D); a trivial in-memory version backs the unit tests.
 */
export interface DocUpdateSink {
  /** Optional: resolve once the sink's DURABLE manifest has been loaded. The
   *  engine awaits this before building `hello`, so a relaunch advertises the
   *  state vectors it persisted instead of an empty manifest (which made the
   *  server re-send the full state of every readable doc on every launch). */
  whenReady?(): Promise<void>;
  /** docIds the client already holds state for (populate the manifest). */
  knownDocs(): string[];
  /** Current Yjs state vector for a doc, or null if we hold nothing. */
  stateVector(docId: string): Promise<Uint8Array | null>;
  /** Recently opened/edited docIds to backfill first. */
  recentDocs(): string[];
  /** Apply a remote update to a doc (resident or hydrated-transiently). */
  applyUpdate(docId: string, update: Uint8Array): Promise<void>;
  /** Access lost / doc removed — drop live state (the .md file is untouched). */
  drop(docId: string): void;
}

type WsFactory = (url: string) => WebSocketLike;

/** The slice of the WebSocket API the engine uses (so tests can fake it). */
export interface WebSocketLike {
  binaryType: string;
  /** CONNECTING/OPEN/CLOSING/CLOSED. Optional so test fakes need not model it;
   *  it is only read to say WHY a connection failed, never to decide anything. */
  readonly readyState?: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface VaultSyncEngineOptions {
  api: ApiClient;
  vaultId: string;
  sink: DocUpdateSink;
  /** Defaults to `deriveVaultWsUrl(api base)`. */
  wsUrl?: string;
  onStatus?: (status: VaultSyncStatus) => void;
  /**
   * The vault token mint came back **401**: the server refused the SESSION, not
   * this vault (that is the 403 above, which stops the retry ladder). Fired on
   * every connect attempt that hits it — including the reconnects a `reauth`
   * triggers — and coalesced by the guard on the other end (`sessionGuard.ts`).
   * The engine's own behaviour is unchanged: 401 stays transient and it keeps
   * retrying, because a session check may yet say the token was merely racing a
   * server restart.
   */
  onSessionRejected?: () => void;
  /** Fired when the server signals an ACL change in this vault (`reauth`). The
   *  open note syncs over its own socket, not this feed, so the owner re-mints
   *  that doc's token to pick up a view↔edit / lock change in realtime. */
  onAclChanged?: () => void;
  /** Fired when the folder/note structure changed in this vault (`registry`):
   *  a teammate created/renamed/moved/deleted a folder or note. The client
   *  re-pulls the registry so its local tree reflects the change live. */
  onRegistryChanged?: () => void;
  /** Fired when a new teammate joined the vault (`member`): the client
   *  refreshes its roster and shows a join celebration. */
  onMemberJoined?: (name: string) => void;
  /** Fired for each teammate presence update (`presence`): who is now viewing
   *  which note (docId null = they left / closed the note). The sink aggregates
   *  these into the sidebar roster. */
  onPresence?: (peer: VaultPeer) => void;
  /**
   * One inbound push-to-talk chunk from a teammate. Fired synchronously, ahead
   * of the doc-update queue: audio is only useful while it's current, so it must
   * not sit behind a backfill drain the way a doc update legitimately can.
   *
   * Nothing here is persisted. The engine hands the bytes over and forgets them.
   */
  onVoice?: (frame: VoiceFrame) => void;
  /**
   * Progress of the inbound BACKFILL: `done` applied out of `total` received.
   *
   * Backfill frames only — the server sends at most one per document
   * (`sendDocBackfill`), so this counts DOCUMENTS, which is the only unit worth
   * showing a person. Live frames are excluded on purpose: they are unbounded and
   * self-inflicted. The server does not self-exclude `update` fan-out, so every
   * keystroke in the open note comes straight back here; counting those turned
   * the header into "Syncing 55/55" climbing by one per letter typed, on a
   * five-note vault.
   */
  onInboundProgress?: (done: number, total: number) => void;
  /**
   * The backfill has finished AND every frame of it has been applied.
   *
   * Fired from outside the drain loop, which is the whole point:
   * `inboundIdle()` requires `!draining`, so a completion check made *inside*
   * the loop — where `draining` is true by construction — can never be true. The
   * download phase used to end that way, i.e. never.
   */
  onInboundIdle?: () => void;
  /** A large live access grant should be downloaded through HTTP bootstrap. */
  onBootstrapRequired?: () => void;
  /**
   * The server named the readable docs it holds NO CRDT state for (`ready.empty`).
   *
   * Fired on EVERY `ready`, i.e. every connect and reconnect, with `truncated`
   * set when the server had more than it would name in one frame. This is the
   * authority the content run keys off: a doc listed here needs its markdown
   * pushed no matter what the local `pushed` checkpoint claims.
   */
  onServerEmpty?: (docIds: string[], truncated: boolean) => void;
  /**
   * The server found THIS device ahead on these readable docs (`ready.behind`):
   * our manifest carries ops it has never received. Fired on every `ready`,
   * right before {@link onServerEmpty}, so the content run that `ready` starts
   * already has them queued.
   */
  onServerBehind?: (docIds: string[]) => void;
  /**
   * The server named docs OUR manifest holds that we may no longer read
   * (`ready.revoked`) — a revocation the server STATES rather than one the
   * client infers from a listing that came back short.
   *
   * Fired on every `ready` and BEFORE the status flips to `synced`, which is
   * what makes it useful on a cold launch: the authority it grants is recorded
   * before the reconnect's own registry pull is even armed, so that pull is the
   * one that acts on it. Never fired with an empty list.
   *
   * `truncated` means the server had more than it would name in one frame.
   */
  onServerRevoked?: (docIds: string[], truncated: boolean) => void;
  /**
   * The server named docs we hold that are soft-DELETED (`ready.tombstones`).
   * Fired before {@link onServerRevoked}, whose list never carries these ids.
   * Never fired with an empty list; never fired by an older server.
   */
  onServerTombstones?: (docIds: string[], truncated: boolean) => void;
  /**
   * The server dropped ops this device pushed for `docId` over a READ-ONLY
   * connection (`{ t: "rejected", reason: "read_only" }`).
   */
  onServerRejected?: (docId: string, reason: "read_only") => void;
  /**
   * The server fully covers these docs' hello state vectors (`ready.covered`):
   * each entry pairs the doc with the EXACT vector this connection's hello
   * sent for it. Never fired with an empty list.
   */
  onServerCovered?: (acks: Array<[docId: string, stateVector: string]>) => void;
  /**
   * The server dropped a doc from our readable set mid-session (`drop`).
   *
   * `refreshAcl` sends one of these per lost doc immediately before the `reauth`
   * that announces the change, so the LIVE path names its docs exactly as
   * `ready.revoked` does on connect. Both feed the same named-revocation set,
   * which is what keeps a `reauth` from ever widening an authority instead of
   * describing one.
   *
   * Fired in addition to `sink.drop`, which releases the doc's live state; this
   * one is about what the session is allowed to remove from disk.
   */
  onServerDrop?: (docId: string) => void;
  /**
   * doc ids of the `files` rows (tree binaries) this device holds on disk —
   * the registry's `files` map.
   *
   * Announced in `hello.files`, never in the manifest: a binary has no CRDT, so
   * there is no state vector and nothing to backfill. It is announced at all
   * because `ready.revoked` can only name what we say we hold, and a `.pdf` set
   * to Private must leave this disk exactly as a note does.
   */
  fileDocIds?: () => string[];
  heldNoteIds?: () => string[];
  /** Injected in tests. Defaults to the global WebSocket. */
  wsFactory?: WsFactory;
  /**
   * Start the channel in LIVE-ONLY mode: `hello.mode = "live-only"`, so the
   * server skips its cold backfill and sends only `ready` plus live traffic.
   *
   * Set while the bulk engine owns the download (`sync/bootstrap.ts`). Flipped
   * back with {@link VaultSyncEngine.reconnect} once the bulk phase is done, at
   * which point the manifest is complete and the resulting backfill is ~0.
   */
  liveOnly?: boolean;
  /** Backoff bounds (ms). */
  reconnect?: { baseMs?: number; maxMs?: number };
  /** Queued inbound bytes past which the engine applies backpressure (default
   *  {@link INBOUND_QUEUE_MAX_BYTES}). */
  inboundQueueMaxBytes?: number;
  /** Injected for deterministic tests. */
  random?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Inbound queue bound, in bytes of pending Yjs updates.
 *
 * The server paces what it sends by its own socket buffer, which says nothing
 * about how fast THIS client can absorb it: every frame costs a `NoteBridge.open`
 * (SQLite read + Y.Doc rebuild), a sha256 and an atomic file write, all on the
 * webview's single thread. 8 MB of queued updates is far more than any healthy
 * client accumulates and still a hard ceiling on the heap the queue can pin.
 */
export const INBOUND_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Close codes the vault channel understands, in the 4000-4999 application range.
 *
 * The server used to close every failure with a bare `ws.close()` (1005, "no
 * status") or `terminate()` (1006), which left the client unable to tell a
 * rejected token from a rebooting server — so it blind-retried both. These two
 * codes are the contract that lets a fatal failure stop the ladder immediately.
 * Keep in lockstep with `server/src/sync/vault-channel.ts`.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_PROTOCOL = 4400;

/**
 * Delay before the FIRST reconnect attempt. Not zero — a server that refuses
 * instantly would otherwise spin the event loop — but short enough that a dev
 * server bounce or a dropped wifi frame costs a blink rather than a visible
 * stall on the sync badge.
 */
const IMMEDIATE_RETRY_MS = 50;

/**
 * Rust refusing a call because the vault moved out from under its caller.
 *
 * Matched on the marker string rather than by importing `ipc.isVaultMismatch`,
 * because this engine deliberately depends on nothing that touches disk or Tauri
 * — it runs under vitest in Node. The contract is `VAULT_MISMATCH` in
 * `src-tauri/src/commands.rs`; change one, change both.
 */
function isVaultMismatch(err: unknown): boolean {
  return typeof err === "string"
    ? err.startsWith("vault-mismatch")
    : err instanceof Error && err.message.startsWith("vault-mismatch");
}

/**
 * Derive the vault channel's WebSocket URL. Unlike the per-doc `deriveWsUrl`
 * (which bumps a local :3010 to the dedicated Hocuspocus :3011), the vault
 * channel ALWAYS lives on the HTTP port at `/vault-sync` — same origin, scheme
 * swapped, path appended (preserving any reverse-proxy sub-path prefix).
 */
export function deriveVaultWsUrl(httpBase: string, path = "/vault-sync"): string {
  try {
    const u = new URL(httpBase);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    const prefix = u.pathname.replace(/\/+$/, "");
    u.pathname = `${prefix}${path}`;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "ws://localhost:3010/vault-sync";
  }
}

export class VaultSyncEngine {
  private readonly api: ApiClient;
  private readonly vaultId: string;
  private readonly sink: DocUpdateSink;
  private readonly wsUrl: string;
  private readonly onStatus?: (s: VaultSyncStatus) => void;
  private readonly onSessionRejected?: () => void;
  private readonly onAclChanged?: () => void;
  private readonly onRegistryChanged?: () => void;
  private readonly onMemberJoined?: (name: string) => void;
  private readonly onPresence?: (peer: VaultPeer) => void;
  private readonly onVoice?: (frame: VoiceFrame) => void;
  private readonly onInboundProgress?: (done: number, total: number) => void;
  private readonly onInboundIdle?: () => void;
  private readonly onBootstrapRequired?: () => void;
  private readonly onServerEmpty?: (docIds: string[], truncated: boolean) => void;
  private readonly onServerBehind?: (docIds: string[]) => void;
  private readonly onServerRevoked?: (docIds: string[], truncated: boolean) => void;
  private readonly onServerTombstones?: (docIds: string[], truncated: boolean) => void;
  private readonly onServerRejected?: (docId: string, reason: "read_only") => void;
  private readonly onServerCovered?: (acks: Array<[docId: string, stateVector: string]>) => void;
  /** The manifest this connection's hello sent (docId → base64 state vector). */
  private sentManifest: Record<string, string> = {};
  private readonly onServerDrop?: (docId: string) => void;
  private readonly fileDocIds?: () => string[];
  private readonly heldNoteIds?: () => string[];
  private readonly wsFactory: WsFactory;
  private readonly inboundMaxBytes: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (h: ReturnType<typeof setTimeout>) => void;

  private ws: WebSocketLike | null = null;
  /**
   * The vault token being minted for the CURRENT connect attempt.
   *
   * Started in `connect()` so the mint overlaps the socket handshake, and
   * awaited in `onOpen()`. Cleared on every disconnect: a token is scoped to the
   * attempt that asked for it, and reusing one across a reconnect would re-send
   * credentials the server may have just refused.
   */
  private tokenPromise: Promise<string> | null = null;
  /**
   * Set once the sink's durable manifest has loaded. Until then a connect
   * waits BEFORE opening the socket: the server drops a socket that sends no
   * `hello` within its idle window, and on a big vault's first launch the
   * manifest load (an IPC read of every stored state vector, queued behind
   * startup's other Rust work) can alone outlast it.
   */
  private sinkReady = false;
  /** Bumped by every connect and socket teardown, so a connect still waiting
   *  on the sink abandons itself when a stop/refresh/reconnect overtook it. */
  private connectGen = 0;
  private waitingForSink = false;
  private status: VaultSyncStatus = "idle";
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Our own presence (which note we're viewing). Held so we can (re)announce it
  // the moment the channel is ready — including after a reconnect.
  private localPresence: LocalPresence | null = null;
  private ready = false;
  // True from the moment `hello` is on the wire until the socket drops. Presence
  // frames are valid this early — the server parks one that races its auth I/O —
  // and announcing here instead of on `ready` is what puts this user on
  // teammates' sidebars during the backfill rather than after it.
  private helloSent = false;

  // ---- inbound (download) queue ----
  //
  // `ws.onmessage` used to be fire-and-forget: `void this.onMessage(data)`. Every
  // binary frame therefore started its own `NoteBridge.open` + SQLite load +
  // sha256 + atomic write CONCURRENTLY, on the main thread. A backfill of N docs
  // spawned N of those at once — which is what made the app stop responding on a
  // large vault. Frames now go into this FIFO and are applied by a single drain
  // loop; the queue is bounded by bytes, and overflow closes the socket (real
  // backpressure) rather than growing the heap or dropping an update.
  private readonly inbound: Array<{
    docId: string;
    update: Uint8Array;
    /** Part of a backfill (vs. live fan-out) — only these are counted. */
    counted: boolean;
  }> = [];
  private inboundBytes = 0;
  private draining = false;
  /** BACKFILL frames enqueued / applied — the download progress denominator and
   *  numerator. Monotonic; one frame per document, so these are document counts.
   *  Live frames are never counted (see `onInboundProgress`). */
  private inboundTotal = 0;
  private inboundDone = 0;
  /** Ask for a live-only channel in the next `hello` (see the option). */
  private liveOnly = false;
  /** True from `hello` until the server's `ready`, which terminates the backfill
   *  it follows (server: "`ready` can never overtake the backfill it
   *  terminates"). This flag is the live/backfill boundary. */
  private backfilling = false;
  /** True while the socket is closed *because* the queue overflowed: the drain
   *  loop reconnects once it has caught up. */
  private backpressured = false;

  constructor(opts: VaultSyncEngineOptions) {
    this.api = opts.api;
    this.vaultId = opts.vaultId;
    this.sink = opts.sink;
    this.wsUrl = opts.wsUrl ?? deriveVaultWsUrl(this.api.getBaseUrl());
    this.onStatus = opts.onStatus;
    this.onSessionRejected = opts.onSessionRejected;
    this.onAclChanged = opts.onAclChanged;
    this.onRegistryChanged = opts.onRegistryChanged;
    this.onMemberJoined = opts.onMemberJoined;
    this.onPresence = opts.onPresence;
    this.onVoice = opts.onVoice;
    this.onInboundProgress = opts.onInboundProgress;
    this.onInboundIdle = opts.onInboundIdle;
    this.onBootstrapRequired = opts.onBootstrapRequired;
    this.fileDocIds = opts.fileDocIds;
    this.heldNoteIds = opts.heldNoteIds;
    this.onServerEmpty = opts.onServerEmpty;
    this.onServerBehind = opts.onServerBehind;
    this.onServerRevoked = opts.onServerRevoked;
    this.onServerTombstones = opts.onServerTombstones;
    this.onServerRejected = opts.onServerRejected;
    this.onServerCovered = opts.onServerCovered;
    this.onServerDrop = opts.onServerDrop;
    this.inboundMaxBytes = opts.inboundQueueMaxBytes ?? INBOUND_QUEUE_MAX_BYTES;
    this.wsFactory =
      opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.liveOnly = opts.liveOnly === true;
    this.baseMs = opts.reconnect?.baseMs ?? 150;
    this.maxMs = opts.reconnect?.maxMs ?? 15_000;
    this.random = opts.random ?? Math.random;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  }

  getStatus(): VaultSyncStatus {
    return this.status;
  }

  /**
   * Broadcast which note this client is now viewing (null = none). Stored so it
   * survives reconnects — the engine re-announces on every `ready`. Sent live
   * only once the channel is ready; otherwise it goes out on the next ready.
   */
  setPresence(presence: LocalPresence | null): void {
    this.localPresence = presence;
    if (this.helloSent) this.sendPresence();
  }

  private sendPresence(): void {
    if (!this.ws || !this.localPresence) return;
    this.ws.send(encodePresence(this.localPresence));
  }

  /**
   * Push one push-to-talk chunk to the vault. Returns false when the channel
   * isn't live, so the caller can stop capturing rather than talk into a void.
   *
   * Dropped outright when not ready: audio is worthless late, so there is no
   * queue and no retry. That is the deliberate difference from a doc update,
   * which must survive a disconnect and does.
   */
  sendVoice(header: VoiceHeader, audio: Uint8Array): boolean {
    if (!this.ws || !this.ready) return false;
    this.ws.send(encodeVoiceFrame(header, audio));
    return true;
  }

  /** Open the connection (idempotent). */
  start(): void {
    if (this.stopped || this.ws || this.waitingForSink) return;
    this.connect();
  }

  /**
   * Force a fresh `hello` — drop the socket and let the normal backoff bring it
   * back up.
   *
   * The only way to ask the server a second question: `ready.empty` is capped, so
   * a vault with more empty docs than one frame will name (`emptyTruncated`) needs
   * another handshake to learn the next batch. Reuses the reconnect machinery
   * rather than opening a second socket — one WS per vault is the invariant.
   */
  refresh(): void {
    if (this.stopped) return;
    this.ready = false;
    this.helloSent = false;
    this.backfilling = false; // this window is over; the next hello opens a new one
    this.closeSocket();
    this.setStatus("connecting");
    this.scheduleReconnect();
  }

  /**
   * Change the hello MODE and force a fresh handshake.
   *
   * The one way out of live-only: the bulk phase finishes, the manifest now
   * covers everything it downloaded, and the reconnect's `hello` therefore asks
   * the server for a backfill that is ~0 frames wide — while still collecting
   * this connect's `ready.empty`/`behind`/`revoked`, which is what the session
   * keys the remaining work off.
   *
   * Reuses {@link VaultSyncEngine.refresh} (and therefore the reconnect
   * machinery) rather than opening a second socket: one WS per vault.
   */
  reconnect(opts: { liveOnly?: boolean } = {}): void {
    if (opts.liveOnly !== undefined) this.liveOnly = opts.liveOnly;
    this.refresh();
  }

  /** Is the channel currently asking for a live-only session? (tests) */
  isLiveOnly(): boolean {
    return this.liveOnly;
  }

  /** Tear down permanently; no further reconnects. */
  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Drop anything still queued: these updates belong to the vault we're leaving,
    // and applying them would write its content into whatever vault opens next
    // (the sink's IO is epoch-pinned, so Rust would refuse — but the work itself
    // must not even be attempted).
    this.inbound.length = 0;
    this.inboundBytes = 0;
    this.backpressured = false;
    this.backfilling = false; // this engine will never open another window
    this.closeSocket();
    this.setStatus("idle");
  }

  /** Backfill counters: documents applied / received. `queued` is the whole
   *  inbound queue (backfill and live alike) — that is what "is it drained?"
   *  has to mean. */
  inboundProgress(): { done: number; total: number; queued: number } {
    return { done: this.inboundDone, total: this.inboundTotal, queued: this.inbound.length };
  }

  /** True when every inbound frame received so far has been applied. */
  inboundIdle(): boolean {
    return this.inbound.length === 0 && !this.draining;
  }

  /**
   * The backfill is over and nothing is left to apply — the honest end of the
   * download phase.
   *
   * Strictly stronger than {@link inboundIdle}, which is also true in the middle
   * of a backfill whose next frame is merely still in flight. Ending the phase
   * there would report "Synced" over a vault that is still arriving.
   */
  backfillSettled(): boolean {
    return !this.backfilling && this.inboundIdle();
  }

  /** Fire `onInboundIdle` iff the backfill has genuinely settled. Called from the
   *  two places that can be the last event: the end of a drain, and `ready`. */
  private maybeSignalIdle(): void {
    if (this.stopped || !this.backfillSettled()) return;
    this.onInboundIdle?.();
  }

  private setStatus(s: VaultSyncStatus): void {
    if (this.status === s) return;
    // One line per transition: a reconnect loop is invisible without it, since
    // neither the connect nor the drop otherwise logs anything.
    console.info(
      `[vault-sync] ${this.vaultId.slice(0, 8)} ${this.status} → ${s} (attempt ${this.attempt})`,
    );
    this.status = s;
    this.onStatus?.(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const gen = ++this.connectGen;
    const ready = this.sinkReady ? undefined : this.sink.whenReady?.();
    if (!ready) {
      this.sinkReady = true;
      this.openSocket();
      return;
    }
    // Load the manifest first, THEN open the socket: `hello` must follow the
    // upgrade promptly, and everything `onOpen` still awaits after this is the
    // token mint (already in flight by then) and in-memory reads.
    this.waitingForSink = true;
    void ready
      .catch(() => {
        /* a failed load just means an empty manifest, as before */
      })
      .then(() => {
        this.waitingForSink = false;
        this.sinkReady = true;
        if (this.stopped || gen !== this.connectGen || this.ws) return;
        this.openSocket();
      });
  }

  private openSocket(): void {
    // Mint the vault token NOW, alongside the TCP/TLS/upgrade handshake instead
    // of after it. Nothing about the mint depends on the socket existing, so
    // doing them in sequence (which is what waiting until `onopen` meant) made
    // every connect pay both latencies end to end. `onOpen` awaits this.
    //
    // Attached immediately so a rejection can never surface as an unhandled
    // rejection while the handshake is still in flight; `onOpen` does the real
    // error handling, including the 403 that stops the retry ladder.
    const minting = this.api.vaultSyncToken(this.vaultId).then((r) => r.token);
    minting.catch(() => {
      /* handled in onOpen */
    });
    this.tokenPromise = minting;
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      markOnce("socket-open");
      void this.onOpen();
    };
    ws.onmessage = (ev) => void this.onMessage(ev.data);
    ws.onclose = (ev) => {
      // A close code the server chose is the ONLY signal that distinguishes
      // "your token is bad" from "the server is rebooting". Read it before
      // deciding whether to keep retrying.
      if (this.handleClose(ev)) return;
      this.onDisconnect();
    };
    ws.onerror = () => {
      // The Event carries nothing useful, so log the state we DO have. When the
      // socket never opened at all this is a TCP/TLS/upgrade failure — refused
      // connection, wrong port, or a path the server's upgrade handler destroys
      // — and no close frame is coming to explain it.
      console.warn(
        `[vault-sync] socket error readyState=${ws.readyState ?? "?"} attempt=${this.attempt} url=${this.wsUrl}`,
      );
      this.onDisconnect();
    };
  }

  /**
   * Log a close frame and decide whether it is fatal. Returns true when the
   * engine has stopped and the caller must NOT schedule a reconnect.
   *
   * `4401` is the server saying the vault token was rejected: retrying with the
   * same credentials just burns the ladder, exactly as an HTTP 403 from the mint
   * does. Everything else is treated as transient.
   */
  private handleClose(ev: unknown): boolean {
    const e = ev as { code?: number; reason?: string; wasClean?: boolean } | undefined;
    console.warn(
      `[vault-sync] socket closed code=${e?.code ?? "?"} reason=${JSON.stringify(e?.reason ?? "")} clean=${e?.wasClean ?? "?"} attempt=${this.attempt}`,
    );
    if (e?.code === WS_CLOSE_UNAUTHORIZED) {
      this.stopped = true;
      this.closeSocket();
      this.setStatus("no-access");
      return true;
    }
    return false;
  }

  private async onOpen(): Promise<void> {
    // Mint the vault token; a 403 means we're not a member — stop retrying.
    let token: string;
    try {
      token = await (this.tokenPromise ??
        this.api.vaultSyncToken(this.vaultId).then((r) => r.token));
      markOnce("token-minted");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        this.stopped = true;
        this.setStatus("no-access");
        this.closeSocket();
        return;
      }
      // 401 is the other refusal: the SESSION, not this vault. The channel is
      // often the first thing to notice one that lapsed mid-run — it re-mints on
      // every reconnect, with no open note required — so it must reach the same
      // guard the per-note providers do, or a signed-out app with no note open
      // would keep reconnecting in silence.
      if (err instanceof ApiError && err.status === 401) this.onSessionRejected?.();
      this.onDisconnect(); // transient — reconnect
      return;
    }

    let manifest: Record<string, string>;
    try {
      // Wait for the sink's DURABLE manifest before advertising what we hold. Skip
      // this and every launch sends `{}`, which asks the server for the full state
      // of every readable doc — the bug this whole phase exists to remove.
      await this.sink.whenReady?.();
      manifest = await this.buildManifest();
    } catch {
      manifest = {};
    }
    this.sentManifest = manifest;
    const priority = this.sink.recentDocs();
    // Tree binaries, alongside the manifest's notes. Read here rather than
    // cached: the registry's `files` map moves with every upload, rename and
    // removal, and a stale id would have the server name a revocation for a file
    // that is no longer on this disk at all.
    let files: string[] = [];
    try {
      files = this.fileDocIds?.() ?? [];
    } catch {
      files = [];
    }
    let held: string[] = [];
    try {
      held = this.heldNoteIds?.() ?? [];
    } catch {
      // A vault switch may retire the registry while hello is being prepared.
    }
    // The socket may have closed while we were minting/building — guard the send.
    if (!this.ws) return;
    // `origin` is this app instance's id, matching the `x-baalda-origin` header on
    // our registry writes, so the server won't ask us to re-pull our own changes.
    // Everything the server sends between this `hello` and its `ready` is
    // backfill, and that window is what the download progress measures.
    this.backfilling = true;
    this.ws.send(
      encodeHello({
        token,
        manifest,
        priority,
        // Omitted when empty, so the common frame stays byte-identical to what
        // every shipped server already parses.
        ...(files.length > 0 ? { files } : {}),
        ...(held.length > 0 ? { held } : {}),
        // …and the same for the mode: absent means "backfill me", exactly as
        // every older client and server already behave.
        ...(this.liveOnly ? { mode: "live-only" as const } : {}),
        origin: this.api.getClientId(),
        // Opt in to the frame types this build understands. Without it the
        // server withholds them (see `CLIENT_CAPS`).
        caps: CLIENT_CAPS,
      }),
    );
    this.helloSent = true;
    markOnce("hello-sent");
    // First announce rides right behind the hello. Waiting for `ready` meant a
    // teammate connecting to a big vault stayed invisible — and saw nobody,
    // because the roster re-announce round is triggered by this very frame —
    // until the entire backfill drained. The `ready` re-send below still runs,
    // which also covers an older server that drops this pre-auth frame.
    this.sendPresence();
  }

  private async buildManifest(): Promise<Record<string, string>> {
    const docs = this.sink.knownDocs();
    const entries = await Promise.all(
      docs.map(async (docId) => {
        const sv = await this.sink.stateVector(docId).catch(() => null);
        return sv ? ([docId, bytesToBase64(sv)] as const) : null;
      }),
    );
    const manifest: Record<string, string> = {};
    for (const e of entries) if (e) manifest[e[0]] = e[1];
    return manifest;
  }

  private async onMessage(data: unknown): Promise<void> {
    if (typeof data === "string") {
      const control = parseServerControl(data);
      if (!control) return;
      if (control.t === "ready") {
        this.attempt = 0; // a clean sync resets backoff
        this.ready = true;
        this.backfilling = false;
        // FIRST, and ahead of `setStatus("synced")` below: this is the frame
        // that authorises removing files, and the status flip is what arms the
        // reconnect's registry pull. Recording the authority after arming the
        // pull it is meant to authorise would be one pull too late — which, on a
        // cold launch, is the entire gap this frame exists to close.
        // A deleted doc also leaves the readable set, so a server may name it in
        // both lists. It is a DELETION, never a revocation: tombstones first,
        // and stripped from the revoked list before anything acts on it.
        const tombstoned = new Set(control.tombstones ?? []);
        if (tombstoned.size > 0) {
          this.onServerTombstones?.([...tombstoned], control.tombstonesTruncated === true);
        }
        const revoked = (control.revoked ?? []).filter((d) => !tombstoned.has(d));
        if (revoked.length > 0) {
          this.onServerRevoked?.(revoked, control.revokedTruncated === true);
        }
        // The server holds every op these docs' hello vectors named: record THAT
        // vector (never a fresh one, which may carry ops typed since).
        if (control.covered && control.covered.length > 0) {
          const acks: Array<[string, string]> = [];
          for (const docId of control.covered) {
            if (tombstoned.has(docId)) continue;
            const sv = this.sentManifest[docId];
            if (sv) acks.push([docId, sv]);
          }
          if (acks.length > 0) this.onServerCovered?.(acks);
        }
        this.onServerBehind?.(control.behind ?? []);
        // BEFORE the idle signal: `maybeSignalIdle` is what starts the content
        // run, and a run that starts without this frame's `empty` list would
        // work from the stale one (or none at all on a first connect).
        this.onServerEmpty?.(control.empty ?? [], control.emptyTruncated === true);
        // `ready` routinely arrives AFTER the last backfill frame has already been
        // applied, so this is the edge that settles the download phase. Checking
        // only on drain would strand it: no further frame is coming to trigger one.
        this.maybeSignalIdle();
        // The one mark that answers "how long until the app is actually live?" —
        // `ready` is the only frame that turns the badge green.
        markOnce("channel-ready");
        this.setStatus("synced");
        // (Re)announce our presence now the channel is live — covers first
        // connect and every reconnect so teammates never see us go stale.
        this.sendPresence();
      } else if (control.t === "bootstrap") {
        this.onBootstrapRequired?.();
      } else if (control.t === "revoked") {
        for (const docId of control.docIds) this.sink.drop(docId);
        this.onServerRevoked?.(control.docIds, false);
      } else if (control.t === "rejected") {
        this.onServerRejected?.(control.docId, control.reason);
      } else if (control.t === "drop") {
        this.sink.drop(control.docId);
        // …and tell the session WHICH doc left, so the live revocation path
        // names its docs the way `ready.revoked` does on connect.
        this.onServerDrop?.(control.docId);
      } else if (control.t === "reauth") {
        // ACL changed in this vault — the open note (synced over its own socket)
        // must re-mint its token to flip read-only/edit live. See onAclChanged.
        this.onAclChanged?.();
      } else if (control.t === "registry") {
        // Folder/note structure changed — re-pull the registry + refresh tree.
        this.onRegistryChanged?.();
      } else if (control.t === "member") {
        // A new teammate joined — refresh the roster + celebrate.
        this.onMemberJoined?.(control.name);
      } else if (control.t === "presence") {
        // A teammate's viewing state changed — feed the sidebar roster.
        this.onPresence?.({
          userId: control.userId,
          docId: control.docId,
          name: control.name,
          color: control.color,
          status: control.status as ActivityStatus,
        });
      } else if (control.t === "err") {
        // Server refused us mid-session (e.g. bad token) — reconnect fresh.
        this.onDisconnect();
      }
      return;
    }
    const bytes = toUint8Array(data);
    if (!bytes) return;
    // Voice shares the binary path with doc updates; the leading byte separates
    // them (see `isVoiceFrame`). Delivered straight through rather than queued:
    // a chunk that waits behind a backfill drain is already too late to play,
    // and there is nothing to converge — it's ephemeral either way.
    if (isVoiceFrame(bytes)) {
      const voice = decodeVoiceFrame(bytes);
      // Copy off the socket buffer before handing it on: playback outlives this
      // callback, and a subarray would pin the whole received ArrayBuffer.
      if (voice) this.onVoice?.({ header: voice.header, audio: new Uint8Array(voice.audio) });
      return;
    }
    // Binary: an incremental update frame for one doc. Queue it — never apply it
    // inline (see the `inbound` field comment).
    const frame = decodeUpdateFrame(bytes);
    if (!frame) return;
    this.enqueueInbound(frame);
  }

  // ---- inbound queue -----------------------------------------------------

  private enqueueInbound(frame: { docId: string; update: Uint8Array }): void {
    if (this.stopped) return;
    // Copy out of the socket's buffer: `decodeUpdateFrame` returns a subarray of
    // the received ArrayBuffer, and holding a view keeps the WHOLE frame alive
    // (and, for some transports, lets it be reused underneath us).
    const update = new Uint8Array(frame.update);
    // Counted only if it belongs to the backfill; live fan-out (including the
    // echo of our own edits) must not move a progress bar.
    const counted = this.backfilling;
    this.inbound.push({ docId: frame.docId, update, counted });
    this.inboundBytes += update.byteLength;
    if (counted) this.inboundTotal++;
    if (!this.backpressured && this.inboundBytes > this.inboundMaxBytes) {
      this.applyBackpressure();
    }
    this.kickDrain();
  }

  /**
   * We are further behind than we are willing to buffer. Close the socket so the
   * server stops producing, finish what we have, then reconnect.
   *
   * This is real backpressure rather than dropping: an update whose causal
   * predecessor is missing is silently discarded by a cold apply (the transient
   * Y.Doc is destroyed), so dropping frames would lose content outright.
   * Reconnecting is cheap and lossless precisely because the manifest is now
   * durable — the server resumes from the state vectors we actually hold.
   */
  private applyBackpressure(): void {
    this.backpressured = true;
    console.warn(
      `[vault-sync] inbound queue at ${this.inboundBytes} bytes — pausing the feed to catch up`,
    );
    this.closeSocket();
    this.ready = false;
    this.setStatus("connecting"); // the feed is down but the work is still ours
  }

  private kickDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainInbound()
      // The loop guards each apply, but not the progress callback it invokes
      // afterwards — which reaches all the way into a React store write. A throw
      // there must not become an unhandled rejection that also strands
      // `draining === true` and silently wedges the whole inbound queue.
      .catch((err) => console.warn("[vault-sync] inbound drain failed", err))
      .finally(() => {
        this.draining = false;
        // A frame that arrived between the loop's last check and here would
        // otherwise sit forever.
        if (!this.stopped && this.inbound.length > 0) {
          this.kickDrain();
          return;
        }
        this.maybeSignalIdle();
      });
  }

  /**
   * Apply queued frames ONE AT A TIME.
   *
   * Serial on purpose: two workers pulling from a shared FIFO can hand two
   * updates for the SAME doc to the sink out of order, and the cold tier drops an
   * update whose causal predecessor hasn't landed. Serial is also the honest
   * shape for this work — each apply is a bridge open + file write on the
   * webview's only thread, so width buys peak memory, not throughput.
   */
  private async drainInbound(): Promise<void> {
    while (!this.stopped && this.inbound.length > 0) {
      const frame = this.inbound.shift()!;
      this.inboundBytes = Math.max(0, this.inboundBytes - frame.update.byteLength);
      try {
        await this.sink.applyUpdate(frame.docId, frame.update);
      } catch (err) {
        // A stale vault epoch is not a per-frame failure — it means Rust has
        // swapped vaults underneath this engine, so EVERY remaining frame will
        // fail the same way. Logging and carrying on (what this used to do)
        // dropped a whole backfill one doc at a time, and because a dropped frame
        // never advances the doc's state vector the server re-offered exactly the
        // same ops on the next connect. If the engine outlives its epoch that
        // repeats forever, which is the permanent re-sync loop.
        if (isVaultMismatch(err)) {
          console.warn(
            `[vault-sync] vault epoch is stale — stopping this engine (${this.inbound.length} frames dropped)`,
            err,
          );
          this.stop();
          return;
        }
        console.warn(`[vault-sync] applyUpdate failed for ${frame.docId}`, err);
      }
      if (frame.counted) {
        this.inboundDone++;
        this.onInboundProgress?.(this.inboundDone, this.inboundTotal);
      }
    }
    // Caught up after a pause — resume the feed. The reconnect re-sends `hello`
    // with the state vectors we just advanced, so nothing is re-delivered.
    if (this.backpressured && !this.stopped) {
      this.backpressured = false;
      this.scheduleReconnect();
    }
  }

  private onDisconnect(): void {
    if (this.stopped) return;
    this.ready = false; // must re-announce presence after we reconnect
    this.helloSent = false;
    // The backfill window closed with the socket: no further frame of it is
    // coming until the next `hello` opens a new one. Leaving it open would make
    // `backfillSettled()` permanently false on a flaky link, and everything that
    // waits for the download to settle (the content run) would wait forever.
    this.backfilling = false;
    this.closeSocket();
    this.setStatus("error");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Exponential backoff with 50–100% jitter (spec 05 §4 anti-stampede).
    //
    // The FIRST retry is near-immediate on purpose. By far the most common cause
    // of a drop is a server that is restarting and will be listening again in
    // well under a second; the old 500ms base spent ~3.5s across three laps
    // before the client found that out, and the user watches every millisecond of
    // it on the badge. Jitter from attempt 1 onward still covers the stampede
    // case the backoff exists for.
    const backoff =
      this.attempt === 0
        ? IMMEDIATE_RETRY_MS
        : Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    const delay = backoff * (0.5 + 0.5 * this.random());
    this.attempt++;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private closeSocket(): void {
    this.tokenPromise = null;
    this.connectGen++; // a connect still waiting on the sink must not open now
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onerror = null;
    // `onclose` stays attached, deliberately. `onerror` fires with no detail, and
    // it reaches us FIRST — so nulling the close handler here (as this used to)
    // threw away the code/reason frame that was still in flight, which is why
    // every failure in the log read as a bare "socket error" with no cause.
    // It must not re-enter `onDisconnect`: whoever called us owns the reconnect.
    ws.onclose = (ev) => {
      const e = ev as { code?: number; reason?: string } | undefined;
      if (e?.code === undefined) return; // nothing to add beyond what we logged
      console.warn(
        `[vault-sync] socket closed (after detach) code=${e.code} reason=${JSON.stringify(e.reason ?? "")}`,
      );
    };
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }
}

/** Normalize a binary WS payload (ArrayBuffer / ArrayBufferView) to Uint8Array. */
function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}
