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
  encodeWsUpdate,
  encodePubsubUpdate,
  encodePubsubAclChanged,
  decodePubsub,
  type ServerControl,
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
 */
export interface VaultChannelDeps {
  pubsub: PubSub;
  listReadableDocs?: typeof listReadableDocsInVault;
  loadDiff?: typeof loadDocDiff;
  verifyToken?: typeof verifyVaultToken;
  backfillConcurrency?: number;
}

export class VaultChannel {
  private readonly pubsub: PubSub;
  private readonly listReadableDocs: typeof listReadableDocsInVault;
  private readonly loadDiff: typeof loadDocDiff;
  private readonly verifyToken: typeof verifyVaultToken;
  private readonly concurrency: number;

  constructor(deps: VaultChannelDeps) {
    this.pubsub = deps.pubsub;
    this.listReadableDocs = deps.listReadableDocs ?? listReadableDocsInVault;
    this.loadDiff = deps.loadDiff ?? loadDocDiff;
    this.verifyToken = deps.verifyToken ?? verifyVaultToken;
    this.concurrency = deps.backfillConcurrency ?? config.backfillConcurrency;
  }

  /** Fan an incremental doc update out to the vault's subscribers (any instance). */
  async publishDocUpdate(vaultId: string, docId: string, update: Uint8Array): Promise<void> {
    await this.pubsub.publish(vaultTopic(vaultId), encodePubsubUpdate(docId, update));
  }

  /** Signal that shares changed in a vault; subscribers re-evaluate their ACL set. */
  async publishAclChanged(vaultId: string): Promise<void> {
    await this.pubsub.publish(vaultTopic(vaultId), encodePubsubAclChanged());
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
    return wss;
  }

  /** Drive one connection through hello -> backfill -> live fanout. */
  handleConnection(ws: WebSocket): void {
    new VaultConnection(ws, this.pubsub, {
      listReadableDocs: this.listReadableDocs,
      loadDiff: this.loadDiff,
      verifyToken: this.verifyToken,
      concurrency: this.concurrency,
    });
  }
}

interface ConnDeps {
  listReadableDocs: typeof listReadableDocsInVault;
  loadDiff: typeof loadDocDiff;
  verifyToken: typeof verifyVaultToken;
  concurrency: number;
}

class VaultConnection {
  private userId: string | null = null;
  private vaultId: string | null = null;
  private readable = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private helloSeen = false;
  private readonly helloTimer: ReturnType<typeof setTimeout>;

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
      if (isBinary) return; // clients only send the JSON hello; ignore stray binary
      void this.onText(data.toString());
    });
    ws.on("close", () => this.cleanup());
    ws.on("error", (err) => {
      console.error("Vault channel socket error:", err);
      this.cleanup();
    });
  }

  private async onText(text: string): Promise<void> {
    if (this.helloSeen) return; // hello is the only client->server message
    const hello = parseHello(text);
    if (!hello) return this.fail("expected hello");
    this.helloSeen = true;
    clearTimeout(this.helloTimer);

    let claims;
    try {
      claims = await this.deps.verifyToken(hello.token);
    } catch {
      return this.fail("invalid or expired vault token");
    }
    this.userId = claims.userId;
    this.vaultId = claims.vaultId;

    try {
      this.readable = await this.deps.listReadableDocs(this.userId, this.vaultId);
    } catch (err) {
      console.error("Vault channel ACL resolve failed:", err);
      return this.fail("acl resolve failed");
    }

    // Subscribe BEFORE backfill so no live update is missed during the drain;
    // Yjs updates are idempotent/commutative, so overlap with the snapshot is
    // harmless (both apply, the client converges).
    this.unsubscribe = await this.pubsub.subscribe(vaultTopic(this.vaultId), (p) =>
      this.onPubsub(p),
    );

    await this.backfill(hello.manifest, hello.priority ?? []);
    this.send({ t: "ready" });
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
      if (this.readable.has(msg.docId)) {
        this.sendBinary(encodeWsUpdate(msg.docId, msg.update));
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
    const added = [...next].filter((d) => !prev.has(d));
    // Newly-readable docs: full backfill (client holds no state vector for them).
    await runPool(added, this.deps.concurrency, (docId) => this.sendDocBackfill(docId, undefined));
  }

  private send(control: ServerControl): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(control));
  }

  private sendBinary(bytes: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(bytes, { binary: true });
  }

  private fail(message: string): void {
    this.send({ t: "err", message });
    this.ws.close();
    this.cleanup();
  }

  private cleanup(): void {
    clearTimeout(this.helloTimer);
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
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
