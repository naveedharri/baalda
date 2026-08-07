import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { config } from "./config.js";
import { createApp } from "./http/app.js";
import { createSyncServer, disconnectDoc } from "./sync/hocuspocus.js";
import { attachSyncUpgrade } from "./sync/http-upgrade.js";
import { createPubSub } from "./sync/pubsub.js";
import { VaultChannel } from "./sync/vault-channel.js";
import { setMemberJoinedPublisher } from "./sync/member-events.js";
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

  // Every publish below is fire-and-forget, and every one of them can reject
  // (pub/sub is Redis when REDIS_URL is set). `void promise` does NOT handle a
  // rejection — it only silences the linter — so an un-caught one is an
  // unhandled rejection, which Node 22 treats as fatal: a momentary Redis blip
  // would kill the server. `announceMemberJoined`'s own try/catch doesn't help
  // either; it wraps the synchronous call, which returns immediately.
  //
  // So the `.catch` goes INSIDE the `void`, at every site. A broadcast that
  // doesn't land is a client that refreshes a little later; a crashed process is
  // every client dropping at once.
  const broadcastFailed = (what: string) => (err: unknown) =>
    console.error(`[vault-channel] ${what} publish failed:`, err);

  // Let the HTTP/auth layer announce member joins onto the vault channel, so
  // connected teammates refresh their roster + celebrate without a reload.
  setMemberJoinedPublisher((vaultId, name) => {
    void vaultChannel.publishMemberJoined(vaultId, name).catch(broadcastFailed("member-joined"));
  });

  // Every persisted doc change is fanned out to background vault subscribers.
  const sync = createSyncServer(config.hocuspocusPort, (vaultId, docId, update) => {
    void vaultChannel.publishDocUpdate(vaultId, docId, update).catch(broadcastFailed("doc-update"));
  });
  await sync.listen();

  const app = createApp({
    disconnectDoc: (vaultId, docId) => disconnectDoc(sync, vaultId, docId),
    // Share create/revoke → subscribers re-evaluate their readable-doc set.
    onAclChanged: (vaultId) =>
      void vaultChannel.publishAclChanged(vaultId).catch(broadcastFailed("acl-changed")),
    // Folder/note create/rename/move/delete → subscribers re-pull the registry.
    // Coalesced per vault inside the channel, and skipped for the client whose
    // own write caused it (`originId`).
    onRegistryChanged: (vaultId, originId) =>
      void vaultChannel
        .publishRegistryChanged(vaultId, originId)
        .catch(broadcastFailed("registry-changed")),
    // MCP tools write notes through the same sync server, so AI edits persist,
    // re-index, and broadcast exactly like a human edit — to open editors via
    // Hocuspocus when the doc is live, and to background subscribers via this
    // publisher when it isn't (the detached path never reaches Hocuspocus, so
    // it has to fan out itself).
    //
    // Returned, not `void`ed: `DocUpdatePublisher` accepts a promise so the
    // doc-writer awaits and swallows a rejection on our behalf.
    docWriter: createDocWriter(sync, (vaultId, docId, update) =>
      vaultChannel.publishDocUpdate(vaultId, docId, update),
    ),
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
