import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { config } from "../config.js";
import { type PubSub, vaultTopic } from "./pubsub.js";
import { verifyVaultToken } from "../tokens/vault-token.js";
import { listReadableDocsInVault } from "../permissions/vault-docs.js";
import { loadDocDiff } from "../yjs/persistence.js";
import {
  parseHello,
  parsePresence,
  encodeWsUpdate,
  encodePubsubUpdate,
  encodePubsubAclChanged,
  encodePubsubRegistryChanged,
  encodePubsubMemberJoined,
  encodePubsubPresence,
  encodePubsubPresenceQuery,
  encodePubsubVoice,
  encodeVoiceFrame,
  decodePubsub,
  decodeVoiceFrame,
  VOICE_FRAME,
  VOICE_RATE_BYTES_PER_SEC,
  type ServerControl,
  type PresenceFrame,
} from "./vault-protocol.js";

/**
 * Vault replication channel (spec 05 §3.1) — a **stateless relay**. It never
 * instantiates a Y.Doc: backfill reads Postgres (`loadDocDiff`) and live fanout
 * forwards opaque bytes. Server memory stays bounded by docs being *edited*
 * (Hocuspocus), not docs that exist.
 *
 * One WebSocket per client per vault. On connect the client sends a `hello`
 * with its per-doc state-vector manifest; the server streams only the missing
 * ops for docs the user may read (prioritised, bounded concurrency), then
 * `ready`. After that it's push: every `onChange` publishes to the vault's
 * PubSub topic and the relay forwards it to subscribers whose ACL set contains
 * the doc. Injectable deps keep it unit-testable without a socket.
 *
 * **Outbound backpressure.** A client whose `hello` carries an empty manifest
 * (the desktop's `svCache` is in-memory, so that's every app launch) asks for
 * the FULL state of every readable doc — far more than any link drains while we
 * frame it. The server therefore frames only what the socket has room for:
 * `VaultConnection` keeps NO userland queue, so `ws.bufferedAmount` is the whole
 * per-connection footprint, and every producer (backfill, ACL top-up, resync)
 * parks on that number *before* it reads a doc out of Postgres. Nothing is ever
 * deferred outside the socket, so `ws`'s single per-socket FIFO gives global
 * ordering for free — a control frame can never overtake a data frame queued
 * before it, and `ready` can never overtake the backfill it terminates.
 *
 * **Liveness.** One shared ping/pong sweep per channel (see `startHeartbeat`)
 * reaps peers that vanished without FIN/RST; a blocked connection additionally
 * watches bytes actually leaving its socket and terminates only a peer that
 * moves none at all for `vaultSendStallMs`.
 */
export interface VaultChannelDeps {
  pubsub: PubSub;
  listReadableDocs?: typeof listReadableDocsInVault;
  loadDiff?: typeof loadDocDiff;
  verifyToken?: typeof verifyVaultToken;
  backfillConcurrency?: number;
  /** Per-connection outbound cap in bytes (default `config.vaultSendCapBytes`). */
  sendCapBytes?: number;
  /** Zero-drain window before a blocked connection is terminated (ms). */
  sendStallMs?: number;
  /** Sampling period for a blocked connection (ms). */
  sendPollMs?: number;
  /** Heartbeat period for {@link VaultChannel.startHeartbeat} (ms). */
  heartbeatMs?: number;
  /** Coalescing window for `registry` broadcasts (ms; 0 disables). */
  registryCoalesceMs?: number;
}

/** Default coalescing window for structural-change broadcasts (ms). A reconcile
 *  creates one row per folder/note, each firing `onRegistryChanged`; folding them
 *  into one frame per window is the difference between ~1,100 broadcasts (and
 *  ~1,100 per-subscriber ACL recomputes) and a handful. */
export const REGISTRY_COALESCE_MS = 120;

export class VaultChannel {
  private readonly pubsub: PubSub;
  private readonly listReadableDocs: typeof listReadableDocsInVault;
  private readonly loadDiff: typeof loadDocDiff;
  private readonly verifyToken: typeof verifyVaultToken;
  private readonly concurrency: number;
  private readonly sendCapBytes: number;
  private readonly sendStallMs: number;
  private readonly sendPollMs: number;
  private readonly heartbeatMs: number;
  /** Live connections, so the shared heartbeat has something to sweep. Entries
   *  remove themselves from `cleanup()`, i.e. on close/terminate/failure. */
  private readonly connections = new Set<VaultConnection>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly registryCoalesceMs: number;
  /** Pending structural-change broadcasts, per vault: the timer that will fire
   *  and the set of client origins whose writes are folded into it. */
  private readonly pendingRegistry = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; origins: Set<string>; anonymous: boolean }
  >();

  constructor(deps: VaultChannelDeps) {
    this.pubsub = deps.pubsub;
    this.listReadableDocs = deps.listReadableDocs ?? listReadableDocsInVault;
    this.loadDiff = deps.loadDiff ?? loadDocDiff;
    this.verifyToken = deps.verifyToken ?? verifyVaultToken;
    this.concurrency = deps.backfillConcurrency ?? config.backfillConcurrency;
    this.sendCapBytes = deps.sendCapBytes ?? config.vaultSendCapBytes;
    this.sendStallMs = deps.sendStallMs ?? config.vaultSendStallMs;
    this.sendPollMs = deps.sendPollMs ?? config.vaultSendPollMs;
    this.heartbeatMs = deps.heartbeatMs ?? config.vaultHeartbeatMs;
    this.registryCoalesceMs = deps.registryCoalesceMs ?? REGISTRY_COALESCE_MS;
  }

  /** Fan an incremental doc update out to the vault's subscribers (any instance). */
  async publishDocUpdate(vaultId: string, docId: string, update: Uint8Array): Promise<void> {
    await this.pubsub.publish(vaultTopic(vaultId), encodePubsubUpdate(docId, update));
  }

  /** Signal that shares changed in a vault; subscribers re-evaluate their ACL set. */
  async publishAclChanged(vaultId: string): Promise<void> {
    await this.pubsub.publish(vaultTopic(vaultId), encodePubsubAclChanged());
  }

  /**
   * Signal that the folder/note structure changed in a vault (create/rename/
   * move/delete); subscribers re-pull the registry to update their local tree.
   *
   * Coalesced per vault over `registryCoalesceMs`: a reconcile fires this once
   * per created row, and every broadcast makes every subscriber recompute its
   * readable-doc set. `originId` (the writing client's `x-baalda-origin`) rides
   * along so the author of the change isn't told to re-pull its own writes; a
   * window that mixes several origins — or any change of unknown origin — is
   * broadcast to everyone.
   */
  async publishRegistryChanged(vaultId: string, originId?: string | null): Promise<void> {
    if (this.registryCoalesceMs <= 0) {
      await this.pubsub.publish(
        vaultTopic(vaultId),
        encodePubsubRegistryChanged(originId ? [originId] : []),
      );
      return;
    }
    const pending = this.pendingRegistry.get(vaultId);
    if (pending) {
      // Fold into the window already open — no extra timer, no extra broadcast.
      if (originId) pending.origins.add(originId);
      else pending.anonymous = true;
      return;
    }
    const entry = {
      timer: setTimeout(() => this.flushRegistry(vaultId), this.registryCoalesceMs),
      origins: new Set<string>(originId ? [originId] : []),
      anonymous: !originId,
    };
    entry.timer.unref?.();
    this.pendingRegistry.set(vaultId, entry);
  }

  private flushRegistry(vaultId: string): void {
    const entry = this.pendingRegistry.get(vaultId);
    if (!entry) return;
    this.pendingRegistry.delete(vaultId);
    // Any anonymous contributor means we can't attribute the whole window, so
    // send an empty origin list and let every subscriber re-pull.
    const origins = entry.anonymous ? [] : [...entry.origins];
    void this.pubsub
      .publish(vaultTopic(vaultId), encodePubsubRegistryChanged(origins))
      .catch((err) => console.error("Vault channel registry publish failed:", err));
  }

  /**
   * Publish every still-open coalescing window immediately instead of waiting out
   * its timer. Called when this instance's WebSocketServer closes: the publish
   * goes to the shared pubsub, so subscribers on OTHER instances still learn about
   * a change this one had coalesced when it went down — a rolling deploy would
   * otherwise silently lose it.
   */
  flushPendingRegistry(): void {
    for (const vaultId of [...this.pendingRegistry.keys()]) {
      const entry = this.pendingRegistry.get(vaultId);
      if (entry) clearTimeout(entry.timer);
      this.flushRegistry(vaultId);
    }
  }

  /** Announce that a new member joined the vault (organization) this note
   *  collection belongs to; subscribers refresh their roster and show a join
   *  celebration. (`vaultId` here is the note-collection id.) */
  async publishMemberJoined(vaultId: string, name: string): Promise<void> {
    await this.pubsub.publish(vaultTopic(vaultId), encodePubsubMemberJoined(name));
  }

  /** Wire the channel onto the HTTP server's upgrade at `config.vaultSyncPath`. */
  attachUpgrade(httpServer: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname !== config.vaultSyncPath && pathname !== `${config.vaultSyncPath}/`) {
        return; // not ours — leave it for other upgrade handlers (e.g. /sync)
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
    });
    // One interval for the whole channel; cleared when the server shuts the
    // WebSocketServer down (index.ts `vaultWss.close()`), and unref'd so it can
    // never be the reason the process stays alive.
    const stopHeartbeat = this.startHeartbeat();
    wss.on("close", () => {
      stopHeartbeat();
      // Flush (not drop) the still-open coalescing windows, so a change this
      // instance had folded into one isn't lost when it goes away.
      this.flushPendingRegistry();
    });
    return wss;
  }

  /**
   * Start the shared liveness sweep: each tick pings every connection and
   * terminates any that has neither answered the previous ping nor sent us
   * anything since. A peer that vanished without FIN/RST is therefore reaped
   * after one to two ticks instead of holding its `VaultConnection`, its PubSub
   * subscription — and, because `cleanup()` is what publishes the "gone"
   * presence event, its presence dot in every teammate's sidebar — forever.
   *
   * Idempotent; returns a stop function. `attachUpgrade` calls this for you.
   */
  startHeartbeat(intervalMs: number = this.heartbeatMs): () => void {
    if (!this.heartbeat) {
      const timer = setInterval(() => {
        // Snapshot: a tick may terminate connections, mutating the set.
        for (const conn of [...this.connections]) conn.heartbeatTick();
      }, intervalMs);
      timer.unref?.();
      this.heartbeat = timer;
    }
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Live connection count — the number that grew without bound while ghosts
   *  accumulated (one `VaultConnection` + subscription each). */
  connectionCount(): number {
    return this.connections.size;
  }

  /** Drive one connection through hello -> backfill -> live fanout. */
  handleConnection(ws: WebSocket): void {
    const conn = new VaultConnection(ws, this.pubsub, {
      listReadableDocs: this.listReadableDocs,
      loadDiff: this.loadDiff,
      verifyToken: this.verifyToken,
      concurrency: this.concurrency,
      sendCapBytes: this.sendCapBytes,
      sendStallMs: this.sendStallMs,
      sendPollMs: this.sendPollMs,
      onGone: (c) => this.connections.delete(c),
    });
    this.connections.add(conn);
  }
}

interface ConnDeps {
  listReadableDocs: typeof listReadableDocsInVault;
  loadDiff: typeof loadDocDiff;
  verifyToken: typeof verifyVaultToken;
  concurrency: number;
  sendCapBytes: number;
  sendStallMs: number;
  sendPollMs: number;
  onGone: (conn: VaultConnection) => void;
}

class VaultConnection {
  private userId: string | null = null;
  private vaultId: string | null = null;
  /** This client's self-declared instance id (hello `origin`), used to skip
   *  telling it to re-pull structural changes it made itself. Null ⇒ no
   *  self-exclusion, so it hears about everything (older clients). */
  private clientId: string | null = null;
  /** Feature flags from `hello.caps`. Gates new binary frame types, which older
   *  clients would misparse as doc updates (see {@link HelloFrame.caps}). */
  private caps = new Set<string>();
  private readable = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private helloSeen = false;
  // Set once by cleanup(). `close` fires exactly once, so anything that outlives
  // it (an in-flight hello await) must consult this instead of relying on
  // cleanup() running again — see the subscribe site in onText().
  private closed = false;
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  // This connection's last-announced presence (which note the user is viewing),
  // kept so we can re-broadcast it when a newcomer asks, and clear it on close.
  private myPresence: { docId: string | null; name: string; color: string; status: string } | null =
    null;
  /** A presence frame that arrived before auth finished; replayed right after
   *  the pub/sub subscribe so the announce (and the roster query it triggers)
   *  doesn't wait for the backfill. */
  private pendingPresence: PresenceFrame | null = null;
  private announced = false;
  // ---- inbound voice budget ----
  // Nothing else on this channel is client-*originated* bulk traffic, so voice
  // is the first thing here that needs a rate limit rather than just
  // backpressure: a peer that ignores the intended cadence would otherwise
  // amplify straight into every other member's socket. A plain leaky bucket —
  // credit refills at VOICE_RATE_BYTES_PER_SEC, chunks over budget are dropped.
  private voiceCredit = VOICE_RATE_BYTES_PER_SEC;
  private voiceCreditAt = 0;
  private voiceDropped = 0;

  // ---- outbound accounting (F2) ----
  /** Cumulative bytes handed to `ws.send()`. Monotonic. */
  private sentBytes = 0;
  /** `sentBytes - ws.bufferedAmount` at the last sample: bytes that have
   *  actually LEFT this connection. Monotonic; the only progress signal the
   *  stall check trusts. */
  private drained = 0;
  private lastProgressAt = 0;
  /** Producers parked on capacity, woken in FIFO order by the sampler. */
  private capacityWaiters: Array<() => void> = [];
  /** Runs only while producers are parked — a healthy connection has no timer. */
  private sampler: ReturnType<typeof setInterval> | null = null;
  /** Docs whose live update we withheld and now owe as a full state resend. */
  private readonly pendingResync = new Set<string>();
  /** Docs whose resend is being read from Postgres right now. */
  private readonly resyncing = new Set<string>();
  private resyncDraining = false;
  /** Liveness for the channel's shared heartbeat: any pong or inbound frame
   *  proves the peer is there; each tick clears it before pinging again. */
  private alive = true;
  /** Why this connection was force-closed, for tests and post-mortem logging. */
  lastAbortReason: string | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly pubsub: PubSub,
    private readonly deps: ConnDeps,
  ) {
    // Drop connections that never authenticate (spec 05 §4 idle protection).
    this.helloTimer = setTimeout(() => {
      if (!this.helloSeen) this.fail("hello timeout");
    }, 10_000);

    ws.on("message", (data, isBinary) => {
      this.alive = true; // traffic from the peer is proof of life, like a pong
      if (isBinary) {
        // The only binary a client sends is a push-to-talk voice chunk; anything
        // else on this path is stray and ignored.
        this.onBinary(toBytes(data));
        return;
      }
      void this.onText(data.toString());
    });
    ws.on("pong", () => {
      this.alive = true;
    });
    ws.on("close", () => this.cleanup());
    ws.on("error", (err) => {
      console.error("Vault channel socket error:", err);
      this.cleanup();
    });
  }

  /** One tick of the channel's shared liveness sweep ({@link VaultChannel.startHeartbeat}). */
  heartbeatTick(): void {
    if (this.closed) return;
    if (!this.alive) {
      // Nothing came back since the previous ping: the peer is gone (or wedged
      // beyond any hope of reading). `close()` would only queue a close frame
      // behind whatever is already stuck, so terminate the socket outright.
      this.abort("liveness timeout");
      return;
    }
    this.alive = false;
    try {
      this.ws.ping?.();
    } catch {
      /* socket died between the readyState check and the ping */
    }
  }

  private async onText(text: string): Promise<void> {
    if (this.closed) return; // socket already gone; don't start any I/O for it
    if (this.helloSeen) {
      // Post-hello, the only client message we accept is a presence update.
      const presence = parsePresence(text);
      if (presence) this.handlePresence(presence);
      return;
    }
    const hello = parseHello(text);
    if (!hello) return this.fail("expected hello");
    this.helloSeen = true;
    this.clientId = hello.origin ?? null;
    this.caps = new Set(hello.caps ?? []);
    clearTimeout(this.helloTimer);

    let claims;
    try {
      claims = await this.deps.verifyToken(hello.token);
    } catch {
      return this.fail("invalid or expired vault token");
    }
    this.userId = claims.userId;
    this.vaultId = claims.vaultId;
    if (this.closed) return; // closed while verifying — don't run the ACL query

    try {
      this.readable = await this.deps.listReadableDocs(this.userId, this.vaultId);
    } catch (err) {
      console.error("Vault channel ACL resolve failed:", err);
      return this.fail("acl resolve failed");
    }

    // Subscribe BEFORE backfill so no live update is missed during the drain;
    // Yjs updates are idempotent/commutative, so overlap with the snapshot is
    // harmless (both apply, the client converges).
    //
    // Capture into a local, then re-check liveness: the awaits above (token
    // verify + ACL resolve) are real I/O, so the socket may have closed while we
    // were in them. `close` fires exactly once, so cleanup() has already run and
    // seen `unsubscribe === null` — if we stored the handler now nothing would
    // ever remove it from the PubSub topic, leaking this whole connection (and
    // its readable set) plus an ACL query per future vault event.
    const off = await this.pubsub.subscribe(vaultTopic(this.vaultId), (p) => this.onPubsub(p));
    if (this.closed || this.ws.readyState !== this.ws.OPEN) {
      off();
      return;
    }
    this.unsubscribe = off;

    // Replay the announce that raced the auth I/O — BEFORE the backfill, so the
    // rest of the vault sees this user (and this user gets the re-announce
    // round) seconds before their own download finishes.
    if (this.pendingPresence) {
      const parked = this.pendingPresence;
      this.pendingPresence = null;
      this.handlePresence(parked);
    }

    await this.backfill(hello.manifest, hello.priority ?? []);
    this.send({ t: "ready" });
  }

  /** Binary from the client. Only voice frames are defined; the leading type
   *  byte leaves room for more without another compat break. */
  private onBinary(bytes: Uint8Array): void {
    if (this.closed || bytes.length === 0) return;
    if (bytes[0] === VOICE_FRAME) this.handleVoice(bytes);
  }

  /** A client announced which note it's now viewing. Stamp the authenticated
   *  userId (never trust the client's), fan it out to the vault, and — on the
   *  first announce — ask everyone else to re-announce so this newcomer learns
   *  the current roster (the channel holds no shared presence state). */
  private handlePresence(frame: PresenceFrame): void {
    if (!this.userId || !this.vaultId) {
      // Clients announce right behind `hello` so teammates' sidebars light up
      // during backfill, not after it — which lands the frame here while the
      // token verify / ACL resolve is still in flight. Park it (last one wins)
      // and onText replays it the moment auth completes; dropping it instead
      // is what made presence wait out the whole backfill.
      this.pendingPresence = frame;
      return;
    }
    this.myPresence = {
      docId: frame.docId,
      name: frame.name,
      color: frame.color,
      status: frame.status,
    };
    void this.pubsub.publish(
      vaultTopic(this.vaultId),
      encodePubsubPresence({ userId: this.userId, ...this.myPresence }),
    );
    if (!this.announced) {
      this.announced = true;
      void this.pubsub.publish(vaultTopic(this.vaultId), encodePubsubPresenceQuery());
    }
  }

  /**
   * A push-to-talk chunk from this client. Re-frame it with the speaker stamped
   * from the authenticated token — never from the payload, so a client cannot
   * put words in a teammate's mouth — and fan it out to the vault.
   *
   * Deliberately NOT gated on the per-doc ACL that filters presence: a voice
   * broadcast is addressed to the team, not to a note, so it follows
   * `member-joined` and reaches every member of the vault. Membership is
   * already proven by the vault token, which is the right granularity here.
   *
   * Audio is never written anywhere. If nobody is connected, it evaporates.
   */
  private handleVoice(bytes: Uint8Array): void {
    if (!this.helloSeen || !this.userId || !this.vaultId) return;
    const parsed = decodeVoiceFrame(bytes);
    if (!parsed) return; // malformed or over the per-chunk cap
    if (!this.admitVoice(parsed.audio.length)) return;
    const { header, audio } = parsed;
    const speaker = this.myPresence;
    const out = encodeVoiceFrame(
      {
        s: header.s,
        n: header.n,
        ...(header.f === 1 ? { f: 1 as const } : {}),
        ...(header.fmt ? { fmt: header.fmt } : {}),
        ...(header.sr ? { sr: header.sr } : {}),
        u: this.userId,
        // Name/colour ride the opening chunk only — the receiver caches them for
        // the rest of the transmission, so the other ~10 chunks a second stay lean.
        ...(header.n === 0 && speaker?.name ? { m: speaker.name } : {}),
        ...(header.n === 0 && speaker?.color ? { c: speaker.color } : {}),
      },
      audio,
    );
    void this.pubsub
      .publish(vaultTopic(this.vaultId), encodePubsubVoice(out))
      .catch((err) => console.error("Vault channel voice publish failed:", err));
  }

  /** Leaky-bucket admission for inbound audio. Returns false when this speaker
   *  is over budget, in which case the chunk is dropped rather than queued —
   *  delayed audio is worthless, so shedding beats buffering. */
  private admitVoice(bytes: number): boolean {
    const now = Date.now();
    if (this.voiceCreditAt === 0) {
      this.voiceCreditAt = now;
    } else {
      const elapsed = (now - this.voiceCreditAt) / 1000;
      this.voiceCreditAt = now;
      this.voiceCredit = Math.min(
        VOICE_RATE_BYTES_PER_SEC,
        this.voiceCredit + elapsed * VOICE_RATE_BYTES_PER_SEC,
      );
    }
    if (this.voiceCredit < bytes) {
      // Log once per run of drops, not once per chunk — a spamming client would
      // otherwise turn our own logs into the amplification.
      if (this.voiceDropped === 0) {
        console.warn(
          `Vault channel dropping voice over budget (user=${this.userId ?? "?"} ` +
            `vault=${this.vaultId ?? "?"})`,
        );
      }
      this.voiceDropped++;
      return false;
    }
    this.voiceCredit -= bytes;
    this.voiceDropped = 0;
    return true;
  }

  /** Stream missing ops for every readable doc, priority docs first. */
  private async backfill(manifest: Record<string, string>, priority: string[]): Promise<void> {
    const prioritized = priority.filter((d) => this.readable.has(d));
    const prioritySet = new Set(prioritized);
    const rest = [...this.readable].filter((d) => !prioritySet.has(d));
    const ordered = [...prioritized, ...rest];
    await runPool(ordered, this.deps.concurrency, (docId) =>
      this.sendDocBackfill(docId, manifest[docId]),
    );
  }

  private async sendDocBackfill(docId: string, clientSvB64: string | undefined): Promise<void> {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // Producer-side backpressure. `loadDiff` rebuilds the whole Y.Doc and encodes
    // its state into memory, so parking BEFORE it is what actually bounds the
    // heap: we never materialize a doc we have nowhere to put. Parking here (not
    // after the read) also means no frame is ever held outside the socket, which
    // is what keeps `ws.bufferedAmount` an honest total.
    if (!(await this.awaitSendCapacity())) return;
    // The ACL can be revoked while we're parked — re-check before reading.
    if (!this.readable.has(docId)) return;
    const clientSv = clientSvB64 ? new Uint8Array(Buffer.from(clientSvB64, "base64")) : null;
    let diff;
    try {
      diff = await this.deps.loadDiff(docId, clientSv);
    } catch (err) {
      console.error(`Vault channel backfill failed for ${docId}:`, err);
      return;
    }
    if (!diff || diff.upToDate) return; // nothing new for this client
    this.sendBinary(encodeWsUpdate(docId, diff.update));
  }

  private onPubsub(payload: Uint8Array): void {
    const msg = decodePubsub(payload);
    if (!msg) return;
    if (msg.type === "update") {
      if (this.readable.has(msg.docId)) this.forwardLive(msg.docId, msg.update);
      return;
    }
    if (msg.type === "registry-changed") {
      // The set of folders/notes changed. The ACL set may also have shifted (a
      // new note the user can read, or one revoked), so re-evaluate that too —
      // this drops/back-fills docs.
      //
      // Deliberately NOT self-excluded: a note this client created itself must
      // still enter its readable set, or the background feed would silently drop
      // every teammate edit to that note until the next reconnect. Coalescing
      // (see `publishRegistryChanged`) is what makes this cheap — a 500-note
      // reconcile costs a handful of recomputes, not ~1,100.
      void this.refreshAcl();
      // Self-exclusion applies to the re-pull only. This client already holds the
      // ids the API returned it, so asking it to re-pull its own writes is a
      // wasted round trip (listFolders + listNotes + a full client syncStructure).
      // Skipped only when EVERY origin folded into this window is ours; a window
      // that also carried someone else's change — or an unattributed one — lands.
      if (
        this.clientId !== null &&
        msg.origins.length > 0 &&
        msg.origins.every((o) => o === this.clientId)
      ) {
        return;
      }
      this.send({ t: "registry" });
      return;
    }
    if (msg.type === "member-joined") {
      // Org-wide news, not doc-scoped — forward to every subscriber of this
      // vault so their roster refreshes and the join celebration fires live.
      this.send({ t: "member", name: msg.name });
      return;
    }
    if (msg.type === "presence") {
      // Forward a teammate's viewing state — but only for docs this client may
      // read (ACL-safe). A null docId ("not viewing"/gone) always passes so the
      // client can clear that user from wherever it last showed them.
      const { presence } = msg;
      if (presence.docId === null || this.readable.has(presence.docId)) {
        this.send({ t: "presence", ...presence });
      }
      return;
    }
    if (msg.type === "voice") {
      // Vault-wide, like member-joined: audio is addressed to the team, and
      // vault membership is already proven by the token behind every connection.
      //
      // KNOWN LIMITATION, narrowed but not gone. Member removal now publishes
      // `acl-changed`, so a removed member's readable set empties immediately and
      // every doc is dropped — note CONTENT is no longer TTL-bound.
      //
      // What remains is the vault-WIDE frames, which are deliberately not
      // doc-gated: this one and `member-joined`. The socket itself survives (there
      // is still no `disconnectDoc` equivalent for the vault channel), so a
      // just-removed member can still hear audio and see joins until the socket
      // drops or their vault token expires (`SYNC_TOKEN_TTL_SECONDS`, 600s by
      // default). Closing that needs a `PS_MEMBER_REMOVED` frame carrying a userId
      // each connection compares against its own and self-terminates on; tracked
      // as follow-up work, not solved here.
      //
      // Two gates. Never echo to the speaker — they are hearing themselves live
      // and a loopback would be an echo, not a feature. And only send to clients
      // that advertised `voice`: this is a new BINARY frame, which an older
      // client would push through `decodeUpdateFrame` and apply as a corrupt doc
      // update.
      if (msg.speakerId === this.userId) return;
      if (!this.caps.has("voice")) return;
      // Shed rather than queue when the socket is already at its bound. Late
      // audio is worse than missing audio, and unlike a doc update there is
      // nothing to resync — the chunk is simply gone, which is what "ephemeral"
      // means here.
      if (this.bufferedBytes() >= this.deps.sendCapBytes) return;
      this.sendBinary(msg.frame);
      return;
    }
    if (msg.type === "presence-query") {
      // A newcomer joined — re-announce our current presence so they see us.
      if (this.myPresence && this.userId && this.vaultId) {
        void this.pubsub.publish(
          vaultTopic(this.vaultId),
          encodePubsubPresence({ userId: this.userId, ...this.myPresence }),
        );
      }
      return;
    }
    // acl-changed: re-evaluate; drop revoked docs, backfill newly-granted ones.
    void this.refreshAcl();
  }

  private async refreshAcl(): Promise<void> {
    if (!this.userId || !this.vaultId) return;
    let next: Set<string>;
    try {
      next = await this.deps.listReadableDocs(this.userId, this.vaultId);
    } catch (err) {
      console.error("Vault channel ACL refresh failed:", err);
      return;
    }
    const prev = this.readable;
    this.readable = next;
    for (const docId of prev) {
      if (!next.has(docId)) this.send({ t: "drop", docId }); // access lost
    }
    // The set of readable docs only shifts on add/remove — but a view↔edit change
    // (or a lock) leaves the set intact while flipping the OPEN note's editability.
    // The open note syncs over its own Hocuspocus socket, not this feed, so tell
    // the client to re-mint that doc's sync token; it reconnects read-only/edit to
    // match. Sent on every ACL change (this channel is always-on) so downgrades and
    // unlocks both reach open editors in realtime without a reopen (spec 04 §4).
    this.send({ t: "reauth" });
    const added = [...next].filter((d) => !prev.has(d));
    if (added.length > 0 && this.vaultId) {
      // We can now see docs we couldn't before — ask the vault to re-announce
      // presence so viewers of the newly-readable docs light up for us.
      void this.pubsub.publish(vaultTopic(this.vaultId), encodePubsubPresenceQuery());
    }
    // Newly-readable docs: full backfill (client holds no state vector for them).
    await runPool(added, this.deps.concurrency, (docId) => this.sendDocBackfill(docId, undefined));
  }

  // ---- live fanout under backpressure (F2) --------------------------------

  /**
   * Forward one live update, or fold it into a full-state resend when this
   * connection is at its outbound bound.
   *
   * Withholding the raw op and re-sending the doc's FULL state later is not the
   * same as dropping it: a full state is self-contained, so it subsumes every
   * withheld op for that doc no matter what order things arrived in, and it
   * reaches the client as an ordinary binary update frame — the only inbound
   * shape the desktop implements (`VaultSyncEngine.onMessage` -> `applyUpdate`).
   * Forwarding the raw op instead, once we've withheld an earlier one, would be
   * the unsafe choice: `VaultDocStore.coldApply` applies a cold-tier update in a
   * transient Y.Doc it then destroys, so an op whose causal predecessor is
   * missing is silently discarded rather than parked.
   */
  private forwardLive(docId: string, update: Uint8Array): void {
    if (this.pendingResync.has(docId) || this.resyncing.has(docId)) {
      // A resend for this doc is already owed. Re-mark (a resend now in flight
      // may have read Postgres before this op landed) and forward nothing.
      this.pendingResync.add(docId);
      this.kickResync();
      return;
    }
    if (this.bufferedBytes() >= this.deps.sendCapBytes) {
      this.pendingResync.add(docId);
      this.kickResync();
      return;
    }
    this.sendBinary(encodeWsUpdate(docId, update));
  }

  /** Ensure exactly one resend drain loop is running. */
  private kickResync(): void {
    if (this.resyncDraining || this.closed) return;
    this.resyncDraining = true;
    void this.drainResync().finally(() => {
      this.resyncDraining = false;
      // A doc re-marked between the loop's last check and here would otherwise
      // sit owed forever, so re-arm rather than wait for the next live update.
      if (!this.closed && this.pendingResync.size > 0) this.kickResync();
    });
  }

  private async drainResync(): Promise<void> {
    while (!this.closed && this.pendingResync.size > 0) {
      const docId = this.pendingResync.values().next().value;
      if (docId === undefined) return;
      // Move to `resyncing` (no await between the two, so nothing can observe
      // the doc as unowed) — live updates arriving during the read re-mark it.
      this.pendingResync.delete(docId);
      this.resyncing.add(docId);
      try {
        // No client state vector -> full state. `sendDocBackfill` parks on the
        // cap before it reads Postgres, exactly like the initial backfill.
        await this.sendDocBackfill(docId, undefined);
      } finally {
        this.resyncing.delete(docId);
      }
    }
  }

  // ---- outbound capacity + stall detection (F2) ---------------------------

  /** Bytes this connection is retaining. Every frame we produce is handed
   *  straight to `ws.send()` and nothing waits anywhere else, so the socket
   *  queue IS the whole footprint. Fakes without `bufferedAmount` read as 0. */
  private bufferedBytes(): number {
    const n = this.ws.bufferedAmount;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  }

  /**
   * Park until the socket is back under the cap. Resolves `true` if the caller
   * may proceed, `false` if the connection died while parked. Waiters are woken
   * in FIFO order by a single per-connection sampler, so admissions can't
   * reorder relative to each other; the frames they produce are for distinct
   * docs anyway (the pool visits each doc once, and `resyncing` serialises a
   * doc's resends), so per-doc order is preserved regardless.
   */
  private async awaitSendCapacity(): Promise<boolean> {
    while (!this.closed && this.ws.readyState === this.ws.OPEN) {
      if (this.bufferedBytes() < this.deps.sendCapBytes) return true;
      await new Promise<void>((resolve) => {
        this.capacityWaiters.push(resolve);
        this.startSampler();
      });
    }
    return false;
  }

  private startSampler(): void {
    if (this.sampler) return;
    this.drained = this.sentBytes - this.bufferedBytes();
    this.lastProgressAt = Date.now();
    const timer = setInterval(() => this.sample(), this.deps.sendPollMs);
    timer.unref?.();
    this.sampler = timer;
  }

  private stopSampler(): void {
    if (!this.sampler) return;
    clearInterval(this.sampler);
    this.sampler = null;
  }

  private sample(): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) {
      this.stopSampler();
      this.releaseWaiters();
      return;
    }
    const drained = this.sentBytes - this.bufferedBytes();
    if (drained > this.drained) {
      this.drained = drained;
      this.lastProgressAt = Date.now();
    }
    if (this.bufferedBytes() < this.deps.sendCapBytes) {
      this.releaseWaiters();
      // Woken producers re-check and re-park (restarting the sampler) if they
      // refill the queue; nothing to watch until then.
      if (this.capacityWaiters.length === 0) this.stopSampler();
      return;
    }
    // Still at the bound. The ONLY close criterion is that no byte at all has
    // left the socket for the whole window — a peer draining even a trickle
    // keeps moving `drained` and is paced for as long as it takes.
    if (Date.now() - this.lastProgressAt >= this.deps.sendStallMs) {
      console.warn(
        `Vault channel terminating a non-draining connection (user=${this.userId ?? "?"} ` +
          `vault=${this.vaultId ?? "?"}): ${this.bufferedBytes()} bytes queued, ` +
          `0 bytes drained in ${this.deps.sendStallMs}ms`,
      );
      this.abort("send stall");
    }
  }

  private releaseWaiters(): void {
    if (this.capacityWaiters.length === 0) return;
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Hard teardown for a socket we can no longer talk to. `terminate()` destroys
   * it immediately (a graceful `close()` only queues a close frame behind
   * whatever is already stuck), then we run the normal close path — which is
   * what clears this user's presence and releases the PubSub subscription.
   * `terminate()` emits `close`, so `cleanup()` is reached either way; calling it
   * directly keeps fakes without `terminate` working too.
   */
  private abort(reason: string): void {
    if (this.closed) return;
    this.lastAbortReason = reason;
    try {
      if (typeof this.ws.terminate === "function") this.ws.terminate();
      else this.ws.close();
    } catch {
      /* already gone */
    }
    this.cleanup();
  }

  private send(control: ServerControl): void {
    // Control frames are never withheld: they're tens of bytes and losing one is
    // a correctness bug (a dropped `drop` leaves revoked content live on the
    // client; a dropped `ready` leaves it stuck "connecting"). They may therefore
    // push the socket queue past the cap, by the total size of the control frames
    // issued while it is blocked — bounded in time by the stall check, which
    // terminates a peer that is draining none of them.
    this.write(JSON.stringify(control), false);
  }

  private sendBinary(bytes: Uint8Array): void {
    this.write(bytes, true);
  }

  /**
   * The one place bytes leave this connection. `ws` owns a single outbound FIFO
   * per socket and writes in call order, so handing frames straight over is what
   * preserves global ordering — there is no second queue for a later frame to
   * jump. A frame is indivisible, so a send may take the queue up to `cap +
   * frame`; with `backfillConcurrency` producers admitted together the peak is
   * `cap + concurrency × largest frame` (see `config.vaultSendCapBytes`).
   */
  private write(payload: string | Uint8Array, binary: boolean): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.sentBytes +=
      typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
    this.ws.send(payload, { binary });
  }

  private fail(message: string): void {
    this.send({ t: "err", message });
    this.ws.close();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.closed) {
      // Idempotent, but a late abort()/close() still needs the timers gone.
      this.stopSampler();
      this.releaseWaiters();
      return;
    }
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.stopSampler();
    // Unpark every producer so its `awaitSendCapacity` returns false and the
    // pool unwinds instead of holding this connection's state alive.
    this.releaseWaiters();
    this.pendingResync.clear();
    this.resyncing.clear();
    this.deps.onGone(this);
    // Tell the vault this user is gone so teammates clear their presence dot.
    // Guard on `announced` so we only emit for connections that ever appeared.
    if (this.announced && this.userId && this.vaultId) {
      const { name = "", color = "", status = "" } = this.myPresence ?? {};
      void this.pubsub.publish(
        vaultTopic(this.vaultId),
        encodePubsubPresence({ userId: this.userId, docId: null, name, color, status }),
      );
      this.announced = false;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

/** Normalize whatever `ws` hands a binary message handler (Buffer, ArrayBuffer,
 *  or a fragment array) into one flat Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(0);
}

/** Run `fn` over items with at most `limit` in flight. Errors are swallowed per
 *  item (each fn already logs), so one bad doc never aborts the whole backfill. */
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}
