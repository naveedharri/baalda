import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { config } from "./config.js";
import { createApp } from "./http/app.js";
import { createSyncServer, disconnectDoc } from "./sync/hocuspocus.js";
import { attachSyncUpgrade } from "./sync/http-upgrade.js";
import { createPubSub } from "./sync/pubsub.js";
import { VaultChannel } from "./sync/vault-channel.js";
import { backfillIndex } from "./index/indexer.js";
import { createDocWriter } from "./mcp/doc-writer.js";

/**
 * Entry point. Runs two listeners in one Node process:
 *   - HTTP API (Hono + Better Auth) on PORT (default 3010). The Hocuspocus
 *     sync WebSocket is ALSO reachable here at /sync, via the same shared
 *     instance below — this is what single-port deploys (Docker/Railway) use.
 *   - Hocuspocus WebSocket sync on HOCUSPOCUS_PORT (default 3011), kept
 *     as-is for back-compat with existing desktop builds and local dev.
 * See README "Ports".
 */
async function main() {
  // Vault replication channel (spec 05): pub/sub is in-memory unless REDIS_URL
  // is set, in which case fanout spans instances (HA / rolling deploys).
  const pubsub = await createPubSub(config.redisUrl);
  const vaultChannel = new VaultChannel({ pubsub });

  // Every persisted doc change is fanned out to background vault subscribers.
  const sync = createSyncServer(config.hocuspocusPort, (vaultId, docId, update) => {
    void vaultChannel.publishDocUpdate(vaultId, docId, update);
  });
  await sync.listen();

  const app = createApp({
    disconnectDoc: (vaultId, docId) => disconnectDoc(sync, vaultId, docId),
    // Share create/revoke → subscribers re-evaluate their readable-doc set.
    onAclChanged: (vaultId) => void vaultChannel.publishAclChanged(vaultId),
    // MCP tools write notes through the same sync server, so AI edits persist,
    // re-index, and broadcast to open editors exactly like a human edit.
    docWriter: createDocWriter(sync),
  });

  const httpServer = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`HTTP API listening on http://localhost:${info.port}`);
    console.log(`Hocuspocus sync listening on ws://localhost:${config.hocuspocusPort}`);
    console.log(`Hocuspocus sync also reachable at ws://localhost:${info.port}/sync`);
    console.log(`Vault sync channel at ws://localhost:${info.port}${config.vaultSyncPath}`);
  }) as HttpServer;

  // Same `sync` instance as HOCUSPOCUS_PORT, so auth/persistence/disconnectDoc
  // apply identically regardless of which port a client connects through.
  const syncWss = attachSyncUpgrade(httpServer, sync, [config.vaultSyncPath]);
  // Vault replication channel shares the HTTP port at config.vaultSyncPath. Its
  // upgrade handler ignores non-matching paths, so it coexists with /sync.
  const vaultWss = vaultChannel.attachUpgrade(httpServer);

  // Index any pre-existing notes missing from note_index (best-effort, async).
  backfillIndex()
    .then((n) => n > 0 && console.log(`Indexer: backfilled ${n} note(s).`))
    .catch((err) => console.error("Indexer backfill failed:", err));

  const shutdown = async () => {
    console.log("Shutting down…");
    syncWss.close();
    vaultWss.close();
    await pubsub.close();
    await sync.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
