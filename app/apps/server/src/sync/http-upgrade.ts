import { WebSocketServer } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { Server as HocuspocusServer } from "@hocuspocus/server";
import type { SyncContext } from "./hocuspocus.js";

/**
 * Single-port deployments (Docker/Railway) expose exactly one port, so the
 * Hocuspocus sync WebSocket must also be reachable on the HTTP server, at
 * `/sync`. This hands the upgrade to the SAME Hocuspocus instance used for
 * HOCUSPOCUS_PORT (see sync/hocuspocus.ts createSyncServer) — auth
 * (onAuthenticate), persistence, and disconnectDoc behave identically no
 * matter which port a client connects through.
 *
 * `ws` runs in `noServer` mode: it never binds a port itself, it only
 * completes upgrades handed to it from the Node http.Server's 'upgrade'
 * event. Any path other than /sync is rejected here before Hocuspocus ever
 * sees it.
 */
export function attachSyncUpgrade(
  httpServer: HttpServer,
  sync: HocuspocusServer<SyncContext>,
  // Paths owned by OTHER upgrade handlers on the same server (e.g. the vault
  // replication channel at /vault-sync, spec 05). We leave those alone instead
  // of destroying the socket, so multiple channels can share one http.Server.
  reservedPaths: string[] = [],
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const reserved = new Set(reservedPaths.flatMap((p) => [p, `${p}/`]));

  httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== "/sync" && pathname !== "/sync/") {
      if (!reserved.has(pathname)) socket.destroy(); // truly-unknown path
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // handleConnection only runs onConnect/onAuthenticate and wires up the
      // Document; unlike Hocuspocus's own standalone Server (which pipes its
      // internal transport's message/close events into the returned
      // ClientConnection itself), we own the raw socket here and must
      // forward those events ourselves.
      const connection = sync.hocuspocus.handleConnection(ws, toFetchRequest(request));
      ws.on("message", (data) => connection.handleMessage(toUint8Array(data)));
      ws.on("close", (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
      ws.on("error", (err) => console.error("Sync socket error (/sync):", err));
    });
  });

  return wss;
}

// Hocuspocus 4.x's handleConnection expects a Fetch API Request (it reads
// .headers/.url off it the same way its own standalone listener does), not
// Node's IncomingMessage — bridge the two.
function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://${host}${req.url ?? "/"}`, { headers });
}

// ws's 'message' event hands us a Buffer, ArrayBuffer, or Buffer[] depending
// on framing/fragmentation; the sync protocol is binary-only, so normalize to
// one Uint8Array the way Hocuspocus's own transports do.
type RawData = Buffer | ArrayBuffer | Buffer[];
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
