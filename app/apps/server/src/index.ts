import { noteLastSeenForVault } from "./members/last-seen.js";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { config } from "./config.js";
import { createApp } from "./http/app.js";
import {
  createSyncServer,
  disconnectDoc,
  disconnectUserInVault,
  evictDoc,
} from "./sync/hocuspocus.js";
import { attachSyncUpgrade } from "./sync/http-upgrade.js";
import { createPubSub } from "./sync/pubsub.js";
import { VaultChannel } from "./sync/vault-channel.js";
import { setMemberJoinedPublisher } from "./sync/member-events.js";
import { backfillIndex } from "./index/indexer.js";
import { startBlobGc, stopBlobGc } from "./blobs/gc.js";
import { startTrashPurge, stopTrashPurge } from "./trash/scheduler.js";
import { setTrashActivityPublisher } from "./trash/activity.js";
import { startInvitationSweep, stopInvitationSweep } from "./invitations/scheduler.js";
import { setInvitationActivityPublisher } from "./invitations/sweep.js";
import { pool } from "./db/pool.js";
import { invalidateReadableCache } from "./permissions/readable-cache.js";
import { createDocWriter } from "./mcp/doc-writer.js";
import { createVersionCapture, isFirstContent, type VersionCapture } from "./versions/capture.js";
import {
  BrakeGrowthCoalescer,
  isShrinkHeld,
  setShrinkBrakeGrowHook,
  setShrinkBrakeHook,
  setShrinkBrakeReleaseHook,
  setShrinkHook,
  shrinkBrake,
} from "./versions/shrink-guard.js";
import { recordBrakeEngaged, updateBrakeCount } from "./versions/brake-events.js";
import { createReleaseWatch, releaseWatchConfig } from "./sync/release-watch.js";
import {
  loadTopUpWindow,
  maybeDailyCheckpoint,
  topUpCheckpoint,
} from "./versions/checkpoints.js";

/**
 * Entry point. Runs two listeners in one Node process:
 *   - HTTP API (Hono + Better Auth) on PORT (default 3010). The Hocuspocus
 *     sync WebSocket is ALSO reachable here at /sync, via the same shared
 *     instance below — this is what single-port deploys (Docker/Railway) use.
 *   - Hocuspocus WebSocket sync on HOCUSPOCUS_PORT (default 3011), kept
 *     as-is for back-compat with existing desktop builds and local dev.
 * See README "Ports".
 */
/**
 * Last line of defence for the whole process.
 *
 * Node 22 exits on an unhandled rejection, and this server has hooks it does not
 * own the call sites of — Hocuspocus invokes `onChange` unawaited and uncaught,
 * so one rejected query there used to end the process and drop every connected
 * client. Each call site still handles its own errors (see `onChange`); this
 * catches the ones nobody anticipated rather than trading a degraded request for
 * a total outage.
 *
 * `uncaughtException` is the same bargain and the more dangerous one — the
 * process continues with unknown state — but for a relay whose durable state is
 * in Postgres, a logged exception beats every open socket dying at once. A
 * supervisor restart is still the right answer to a *repeating* one, which is
 * why these are loud.
 */
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandled promise rejection (keeping the process alive):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[process] uncaught exception (keeping the process alive):", err);
  });
}

async function main() {
  installProcessGuards();
  // Vault replication channel (spec 05): pub/sub is in-memory unless REDIS_URL
  // is set, in which case fanout spans instances (HA / rolling deploys).
  const pubsub = await createPubSub(config.redisUrl);
  const vaultChannel = new VaultChannel({
    pubsub,
    // A client (re)connecting during a shrink-brake hold is told why (#252).
    brakeState: (userId, vaultId) => shrinkBrake.holdOf(userId, vaultId),
    noteLastSeen: noteLastSeenForVault,
  });

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
  // Soft delete / restore / purge → open Activity feeds refetch Trash (#260).
  setTrashActivityPublisher((vaultId) => {
    void vaultChannel.publishActivityChanged(vaultId).catch(broadcastFailed("activity-changed"));
  });

  // An invitation expired unaccepted → the inviter's and the admins' Activity
  // feeds refetch (#268). Notices are per org; the channel is per collection.
  setInvitationActivityPublisher((organizationId) => {
    void pool
      .query<{ id: string }>("SELECT id FROM vaults WHERE organization_id = $1", [organizationId])
      .then(({ rows }) => Promise.all(rows.map((r) => vaultChannel.publishActivityChanged(r.id))))
      .catch(broadcastFailed("activity-changed"));
  });

  // Version capture is created below (it needs the doc writer, which needs the
  // sync server, which needs this hook) — hence the late binding. Every edit,
  // however it arrived, ends up in exactly one place.
  let versionCapture: VersionCapture | null = null;
  const noteEdited = (
    vaultId: string,
    docId: string,
    userId: string | null,
    source?: string | null,
  ) => versionCapture?.touch(vaultId, docId, userId, source);

  // Every persisted doc change is fanned out to background vault subscribers.
  const sync = createSyncServer(
    config.hocuspocusPort,
    (vaultId, docId, update) => {
      void vaultChannel
        .publishDocUpdate(vaultId, docId, update)
        .catch(broadcastFailed("doc-update"));
    },
    noteEdited,
    // A read-only socket's dropped edit becomes a `rejected` frame for its user.
    (vaultId, docId, userId) => {
      void vaultChannel.publishRejected(vaultId, userId, docId).catch(broadcastFailed("rejected"));
    },
  );
  await sync.listen();

  // Both structural and ACL changes drop this instance's display-only readable
  // sets for the vault first (#261, `permissions/readable-cache.ts`).
  const onRegistryChanged = (vaultId: string, originId: string | null) => {
    invalidateReadableCache(vaultId);
    void vaultChannel
      .publishRegistryChanged(vaultId, originId)
      .catch(broadcastFailed("registry-changed"));
  };

  // The detached write path never reaches Hocuspocus, so it reports edits here.
  const docWriter = createDocWriter(
    sync,
    (vaultId, docId, update) => vaultChannel.publishDocUpdate(vaultId, docId, update),
    noteEdited,
  );

  // A single update that wipes most of a note keeps the text it replaced (#200).
  // …and every open Activity feed in the vault refetches once it is stored
  // (#260), instead of polling for it.
  setShrinkHook((vaultId, docId, previousText) => {
    void (versionCapture?.preShrink(vaultId, docId, previousText) ?? Promise.resolve())
      .then(() => vaultChannel.publishActivityChanged(vaultId))
      .catch(broadcastFailed("activity-changed"));
  });
  // A BURST of them from one user in one vault engages the brake (#252): kick
  // that user's live sockets there so they reconnect read-only for the hold,
  // tell their app why (a `brake` frame, never `rejected`), and record it for
  // the vault's owners/admins, whose Activity refetches.
  //
  // When the hold ends — it lapses, or an owner/admin releases it — the user's
  // sockets are kicked again so they reconnect WRITABLE, and their app hears
  // `brake { held: false }`. Without that the read-only re-admission outlived
  // the hold until something else happened to reconnect them.
  const lapseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const brakeKey = (vaultId: string, userId: string) => `${vaultId}\u0000${userId}`;
  const brakeLifted = (vaultId: string, userId: string) => {
    const closed = disconnectUserInVault(sync, vaultId, userId);
    if (closed > 0) {
      console.info(`[versions] shrink brake lifted: reconnecting ${closed} connection(s) in vault ${vaultId}`);
    }
  };
  // The recorded event of each live hold, so its count can be corrected as
  // in-flight shrinks keep arriving after it engaged (#275).
  const brakeEventIds = new Map<string, Promise<string | null>>();
  const brakeGrowth = new BrakeGrowthCoalescer(1_000, (vaultId, userId) => {
    const hold = shrinkBrake.holdOf(userId, vaultId);
    const eventId = brakeEventIds.get(brakeKey(vaultId, userId));
    if (!hold || !eventId) return; // lapsed or released meanwhile
    const count = hold.count;
    void vaultChannel
      .publishBrake(vaultId, userId, { held: true, until: hold.until, count })
      .catch(broadcastFailed("brake"));
    void eventId
      .then((id) => (id ? updateBrakeCount(id, count) : false))
      .then((changed) => (changed ? vaultChannel.publishActivityChanged(vaultId) : undefined))
      .catch((err) => console.error("[versions] shrink brake count update failed:", err));
  });
  setShrinkBrakeGrowHook((vaultId, userId) => brakeGrowth.grew(vaultId, userId));
  setShrinkBrakeHook((vaultId, userId, hold) => {
    const closed = disconnectUserInVault(sync, vaultId, userId);
    console.warn(`[versions] shrink brake: closed ${closed} live connection(s) in vault ${vaultId}`);
    void vaultChannel
      .publishBrake(vaultId, userId, { held: true, until: hold.until, count: hold.count })
      .catch(broadcastFailed("brake"));
    const key = brakeKey(vaultId, userId);
    const recorded = recordBrakeEngaged(vaultId, userId, hold.count, new Date(hold.until)).then(
      (id) => {
        void vaultChannel.publishActivityChanged(vaultId).catch(broadcastFailed("activity-changed"));
        return id;
      },
      (err) => {
        console.error("[versions] shrink brake record failed:", err);
        return null;
      },
    );
    brakeEventIds.set(key, recorded);
    clearTimeout(lapseTimers.get(key));
    const timer = setTimeout(() => {
      lapseTimers.delete(key);
      if (isShrinkHeld(userId, vaultId)) return; // re-engaged meanwhile: its own timer
      brakeEventIds.delete(key);
      brakeGrowth.cancel(vaultId, userId);
      brakeLifted(vaultId, userId);
      void vaultChannel.publishBrake(vaultId, userId, { held: false }).catch(broadcastFailed("brake"));
      void vaultChannel.publishActivityChanged(vaultId).catch(broadcastFailed("activity-changed"));
    }, Math.max(0, hold.until - Date.now()) + 50);
    timer.unref?.();
    lapseTimers.set(key, timer);
  });
  // Release (owner/admin, `http/routes/shrink-brake.ts`): every instance drops
  // its own hold and re-admits that user's sockets writable — the hold is
  // in-memory per process, so the release travels over pub/sub (in-memory by
  // default, Redis when REDIS_URL spans instances).
  const BRAKE_RELEASE_TOPIC = "shrink-brake:release";
  await pubsub.subscribe(BRAKE_RELEASE_TOPIC, (payload) => {
    try {
      const { vaultId, userId } = JSON.parse(new TextDecoder().decode(payload)) as {
        vaultId?: unknown;
        userId?: unknown;
      };
      if (typeof vaultId !== "string" || typeof userId !== "string") return;
      shrinkBrake.release(userId, vaultId);
      const key = brakeKey(vaultId, userId);
      clearTimeout(lapseTimers.get(key));
      lapseTimers.delete(key);
      brakeEventIds.delete(key);
      brakeGrowth.cancel(vaultId, userId);
      brakeLifted(vaultId, userId);
    } catch (err) {
      console.error("[versions] shrink brake release message failed:", err);
    }
  });
  setShrinkBrakeReleaseHook((vaultId, userId) => {
    void pubsub
      .publish(BRAKE_RELEASE_TOPIC, new TextEncoder().encode(JSON.stringify({ vaultId, userId })))
      .catch(broadcastFailed("brake-release"));
    void vaultChannel.publishBrake(vaultId, userId, { held: false }).catch(broadcastFailed("brake"));
    void vaultChannel.publishActivityChanged(vaultId).catch(broadcastFailed("activity-changed"));
  });

  versionCapture = createVersionCapture({
    docWriter,
    // Version capture's only broadcast is the "last edited by" stamp, which
    // moves no row and grants nothing — so it goes out as a meta-only frame,
    // not a structural `registry-changed` that made every subscriber recompute
    // its readable set and re-pull the whole registry per stamped doc (#262).
    onRegistryChanged: (vaultId) =>
      void vaultChannel.publishMetaChanged(vaultId).catch(broadcastFailed("meta-changed")),
    idleMs: config.versionIdleMs,
    // Activity-triggered daily checkpoint — no scheduler, and the freshness
    // test runs under a per-vault advisory lock so instances don't stampede.
    dailyCheckpoint: (vaultId) => maybeDailyCheckpoint({ vaultId, docWriter }),
    // A doc's first content (any route) never triggers the daily checkpoint,
    // and tops up the newest one if it stored that doc structure-only.
    firstContent: (docId) => isFirstContent(docId),
    checkpointTopUp: {
      window: (vaultId) => loadTopUpWindow(pool, vaultId),
      apply: (vaultId, checkpointId, docIds) =>
        topUpCheckpoint(pool, docWriter, vaultId, checkpointId, docIds),
    },
  });

  const app = createApp({
    disconnectDoc: (vaultId, docId) => disconnectDoc(sync, vaultId, docId),
    evictDoc: (vaultId, docId) => evictDoc(sync, vaultId, docId),
    // Share create/revoke → subscribers re-evaluate their readable-doc set.
    onAclChanged: (vaultId) => {
      invalidateReadableCache(vaultId);
      void vaultChannel.publishAclChanged(vaultId).catch(broadcastFailed("acl-changed"));
    },
    // Folder/note create/rename/move/delete → subscribers re-pull the registry.
    // Coalesced per vault inside the channel, and skipped for the client whose
    // own write caused it (`originId`).
    onRegistryChanged,
    // MCP tools write notes through the same sync server, so AI edits persist,
    // re-index, and broadcast exactly like a human edit — to open editors via
    // Hocuspocus when the doc is live, and to background subscribers via this
    // publisher when it isn't (the detached path never reaches Hocuspocus, so
    // it has to fan out itself).
    //
    // Returned, not `void`ed: `DocUpdatePublisher` accepts a promise so the
    // doc-writer awaits and swallows a rejection on our behalf.
    docWriter,
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

  // New desktop release → hint connected apps to check now (#269). Off with
  // RELEASE_MANIFEST_URL=off or RELEASE_POLL_MINUTES=0; an offline host just
  // never sends the hint.
  const releaseCfg = releaseWatchConfig();
  const releaseWatch = releaseCfg
    ? createReleaseWatch({
        ...releaseCfg,
        onNewVersion: (version) => {
          const told = vaultChannel.broadcastVersionAvailable(version);
          console.info(`[release-watch] hinted ${told} connection(s)`);
        },
      })
    : null;

  // Index any pre-existing notes missing from note_index (best-effort, async).
  backfillIndex()
    .then((n) => n > 0 && console.log(`Indexer: backfilled ${n} note(s).`))
    .catch((err) => console.error("Indexer backfill failed:", err));

  // Attachment lifecycle. Three sweeps on one `unref`ed timer, each serialized
  // across instances by its own advisory lock:
  //   · abandoned uploads — a `pending` blob row holds its content's dedupe
  //     slot, so leaving them would make a later upload of the same bytes adopt
  //     an upload that never finished;
  //   · the deletion queue — objects whose row a vault cascade or an org delete
  //     already removed without knowing an object store exists;
  //   · unreferenced attachments, only when BLOB_GC_ENABLED says so.
  startBlobGc();
  // Trash retention: notes past `purge_after` lose their CRDT, versions and row.
  startTrashPurge();
  // Invitation reminders (one email a day before expiry, only when email is
  // configured) and one Activity notice per invitation that expired (#268).
  startInvitationSweep();

  const shutdown = async () => {
    console.log("Shutting down…");
    versionCapture?.stop();
    stopBlobGc();
    stopTrashPurge();
    stopInvitationSweep();
    syncWss.close();
    releaseWatch?.stop();
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
