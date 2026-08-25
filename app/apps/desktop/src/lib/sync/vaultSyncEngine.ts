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
  /** Injected in tests. Defaults to the global WebSocket. */
  wsFactory?: WsFactory;
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
  private readonly onAclChanged?: () => void;
  private readonly onRegistryChanged?: () => void;
  private readonly onMemberJoined?: (name: string) => void;
  private readonly onPresence?: (peer: VaultPeer) => void;
  private readonly onVoice?: (frame: VoiceFrame) => void;
  private readonly onInboundProgress?: (done: number, total: number) => void;
  private readonly onInboundIdle?: () => void;
  private readonly wsFactory: WsFactory;
  private readonly inboundMaxBytes: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (h: ReturnType<typeof setTimeout>) => void;

  private ws: WebSocketLike | null = null;
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
    this.onAclChanged = opts.onAclChanged;
    this.onRegistryChanged = opts.onRegistryChanged;
    this.onMemberJoined = opts.onMemberJoined;
    this.onPresence = opts.onPresence;
    this.onVoice = opts.onVoice;
    this.onInboundProgress = opts.onInboundProgress;
    this.onInboundIdle = opts.onInboundIdle;
    this.inboundMaxBytes = opts.inboundQueueMaxBytes ?? INBOUND_QUEUE_MAX_BYTES;
    this.wsFactory =
      opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.baseMs = opts.reconnect?.baseMs ?? 500;
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
    if (this.stopped || this.ws) return;
    this.connect();
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
    this.status = s;
    this.onStatus?.(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => void this.onOpen();
    ws.onmessage = (ev) => void this.onMessage(ev.data);
    ws.onclose = () => this.onDisconnect();
    ws.onerror = () => this.onDisconnect();
  }

  private async onOpen(): Promise<void> {
    // Mint the vault token; a 403 means we're not a member — stop retrying.
    let token: string;
    try {
      token = (await this.api.vaultSyncToken(this.vaultId)).token;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        this.stopped = true;
        this.setStatus("no-access");
        this.closeSocket();
        return;
      }
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
    const priority = this.sink.recentDocs();
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
        origin: this.api.getClientId(),
        // Opt in to the frame types this build understands. Without it the
        // server withholds them (see `CLIENT_CAPS`).
        caps: CLIENT_CAPS,
      }),
    );
    this.helloSent = true;
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
        // `ready` routinely arrives AFTER the last backfill frame has already been
        // applied, so this is the edge that settles the download phase. Checking
        // only on drain would strand it: no further frame is coming to trigger one.
        this.maybeSignalIdle();
        this.setStatus("synced");
        // (Re)announce our presence now the channel is live — covers first
        // connect and every reconnect so teammates never see us go stale.
        this.sendPresence();
      } else if (control.t === "drop") {
        this.sink.drop(control.docId);
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
    this.closeSocket();
    this.setStatus("error");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Exponential backoff with 50–100% jitter (spec 05 §4 anti-stampede).
    const backoff = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    const delay = backoff * (0.5 + 0.5 * this.random());
    this.attempt++;
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private closeSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
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
