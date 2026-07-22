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
  encodeHello,
  encodePresence,
  parseServerControl,
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
  /** Injected in tests. Defaults to the global WebSocket. */
  wsFactory?: WsFactory;
  /** Backoff bounds (ms). */
  reconnect?: { baseMs?: number; maxMs?: number };
  /** Injected for deterministic tests. */
  random?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (h: ReturnType<typeof setTimeout>) => void;
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
  private readonly onAclChanged?: () => void;
  private readonly onRegistryChanged?: () => void;
  private readonly onMemberJoined?: (name: string) => void;
  private readonly onPresence?: (peer: VaultPeer) => void;
  private readonly wsFactory: WsFactory;
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
    if (this.ready) this.sendPresence();
  }

  private sendPresence(): void {
    if (!this.ws || !this.localPresence) return;
    this.ws.send(encodePresence(this.localPresence));
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
    this.closeSocket();
    this.setStatus("idle");
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
      manifest = await this.buildManifest();
    } catch {
      manifest = {};
    }
    const priority = this.sink.recentDocs();
    // The socket may have closed while we were minting/building — guard the send.
    if (!this.ws) return;
    this.ws.send(encodeHello({ token, manifest, priority }));
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
    // Binary: an incremental update frame for one doc.
    const bytes = toUint8Array(data);
    if (!bytes) return;
    const frame = decodeUpdateFrame(bytes);
    if (!frame) return;
    await this.sink.applyUpdate(frame.docId, frame.update).catch((err) => {
      console.warn(`[vault-sync] applyUpdate failed for ${frame.docId}`, err);
    });
  }

  private onDisconnect(): void {
    if (this.stopped) return;
    this.ready = false; // must re-announce presence after we reconnect
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
