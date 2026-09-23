// Doc-session coordinator: ties the local-first bridge (Y.Doc + disk) to the
// network provider, enforcing the startup-ordering rule (spec 03 §5) and owning
// presence for the currently-open note.
//
// Flow when signed in with an active, reconciled vault:
//   1. Open the bridge WITHOUT seeding (deferred).
//   2. Connect the provider and wait for the initial server sync.
//   3. Seed from local markdown only if the doc is still empty (orphan).
//   4. Bind the editor to the provider's awareness; read-only if the grant is view.
// When signed out / offline / unmapped, it falls back to a local Awareness and
// the bridge's normal seed-from-file (pure local-first).

import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { NoteBridge } from "../bridge";
import { bridgeManager, createTauriBridgeIO, sha256Hex } from "../bridge/adapter";
import { isServerTooOld, type NoteLastEdited, type SessionInfo } from "../api";
import * as ipc from "../ipc";
import { markOnce } from "../perf";
import { api, authManager } from "../auth/authManager";
import { colorForUser, presenceUser } from "../presence/color";
import { viewingDocId } from "../presence/viewingDocId";
import type { ActivityStatus } from "../prefs";
import { toast } from "../toast";
import { AttachmentSync, routesToAttachmentSync } from "./attachments";
import { BinaryDeleteQueue } from "./binaryDeletes";
import { BootstrapRunner } from "./bootstrap";
import {
  DocBatchPusher,
  type DocBatchPushResult,
  type DocPushWork,
} from "./docBatchPush";
import { ContentUploader, type UploadFailure } from "./contentUpload";
import { collectCrdtGarbage } from "./crdtGc";
import {
  IPC_CONCURRENCY,
  REGISTRY_CONCURRENCY,
  runPool,
  useBulkPath,
} from "./pool";
import { SyncProgressReporter } from "./progress";
import { decideSeed } from "./startup";
import { SessionRejectionGuard } from "./sessionGuard";
import { DocSync, type SyncStatus } from "./syncManager";
import { VaultRegistry, type InboundHost, type RegistryFailure } from "./registry";
import { VaultDocStore, createIpcManifestStore } from "./vaultDocStore";
import {
  vaultScopes,
  type DocSyncState,
  type SyncProgress,
  type SyncProgressPhase,
  type VaultScope,
} from "./vaultScope";
import { SyncLog } from "./syncLog";
import type { SyncLogEntry, SyncLogLevel } from "../health/types";
import {
  VaultSyncEngine,
  type VaultPeer,
  type VaultSyncStatus,
} from "./vaultSyncEngine";
import type { VoiceFrame } from "./vaultProtocol";
import { CAPTURE_FORMAT, startCapture } from "../voice/capture";
import { VoicePlayer } from "../voice/playback";
import { VoiceRoster, type VoiceSpeaker } from "../voice/roster";

export type { VoiceSpeaker };

/** Basename of a vault-relative path (for the upload's x-file-name hint). */
function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

/** Human-readable cause, for a failure the UI will show. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coalescing window for the {relPath → docId} mirror pushed to the UI.
 *
 * The registry fires its map listener once per adopted/created note, so a
 * 500-note reconcile fires it 500 times; each publish rebuilds a 500-key object
 * and re-renders the sidebar. Same budget as `SyncProgressReporter` (~10 store
 * writes/second) for the same reason.
 */
const REGISTRY_MAP_PUBLISH_MS = 100;

/**
 * Coalescing window for the presence re-announce a registry map change earns.
 *
 * The map listener fires once per adopted/created note, and resolving the open
 * note's id can rebuild the registry's case-folded index on a miss — doing that
 * per note would be quadratic over a big reconcile. One timer per burst keeps it
 * to a handful of lookups, and the re-announce itself only goes on the wire when
 * the RESOLVED id actually changed.
 */
const PRESENCE_REPUSH_MS = 150;

/**
 * Quiet window before pushing locally-changed (externally-written) notes. Long
 * enough that an AI writing a batch of files coalesces into one run; short
 * enough that a single saved file is on the server within ~a second.
 */
const LOCAL_CHANGE_DEBOUNCE_MS = 800;
/** Re-check interval while a bulk run holds the uploader slot. */
const LOCAL_CHANGE_RETRY_MS = 2_000;
/**
 * Grace window before a disk-observed delete is propagated to the server.
 *
 * A vanished `.md` is not yet a delete. Three ordinary things look exactly like
 * one for a moment: an editor that saves by unlinking and rewriting, a rename
 * (which arrives as an unpaired `removed` + `modified` in the same batch), and a
 * `git checkout` that is about to put the file back. All three resolve in
 * milliseconds, so a window measured in seconds turns them into no-ops — while
 * still being far below the point where a user would notice their delete
 * "taking a while" to reach a teammate.
 */
const DISK_DELETE_GRACE_MS = 2_500;
/**
 * Cap on how many notes ONE grace window may delete on the server: a fifth of
 * the vault, never fewer than five.
 *
 * The failure this exists for is not a user deleting notes — it is the vault
 * folder going away underneath us: an unmounted volume, a Dropbox/iCloud
 * eviction, `git checkout` of a branch without that folder, a sync client
 * mid-repair. Those arrive as hundreds of removals in one batch, and every one
 * of them looks individually legitimate. Past the cap the whole batch is
 * abandoned — nothing is propagated, and the refusal is reported — because "the
 * disk just lost a fifth of the vault" is never a delete a person meant.
 */
function diskDeleteCap(mappedCount: number): number {
  return Math.max(5, Math.ceil(mappedCount * 0.2));
}
/** Timestamped folder name for a genuine unsendable-edit recovery copy. */
function trashStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
/**
 * How long the download phase may wait for the vault channel's `ready` before
 * the run stops reporting "Syncing…" and admits the channel is unreachable.
 * Generous: a cold 5k-note backfill legitimately takes a while, but its frames
 * flip the engine to `synced`-in-progress long before this elapses; only a
 * socket that never opens gets here.
 */
const CHANNEL_WATCHDOG_MS = 30_000;

/**
 * Past this many bytes, a note's file is "not empty" without reading it.
 *
 * 1 KiB: the question `settleServerEmpty` asks is whether a file is blank or
 * whitespace-only, and a kilobyte of pure whitespace is not a thing a vault
 * contains. See {@link SyncManager.fileIsEmpty}.
 */
const EMPTY_PROBE_MAX_BYTES = 1024;

/**
 * Longest a burst of `registry`/`reauth` frames may push the debounced pull back.
 *
 * The 250ms debounce coalesces, but on its own it also STARVES: every frame
 * cleared and re-armed the timer, and the server coalesces its own structural
 * broadcasts into ~8 windows a second (see `REGISTRY_COALESCE_MS`), so a delete
 * drain or a bulk register kept the pull permanently 250ms away and it ran only
 * once the storm stopped. Past this cap the armed timer is left to fire, so a
 * burst of N frames is exactly one pull — promptly.
 */
const REGISTRY_PULL_MAX_WAIT_MS = 1_000;

/**
 * How long the server's `acl-changed` frame keeps a pull authorised to remove
 * files wholesale (see {@link SyncManager.revocationAuthority}).
 *
 * Not "the very next pull": the pull is debounced and coalesced, a burst of
 * frames folds into one, and the pass that finally reads the new listing may be
 * two or three triggers downstream of the one that announced the change. A
 * window is what survives that without having to thread a reason through the
 * coalescing. A minute is far longer than the 250ms debounce needs and far
 * shorter than the gap between two unrelated permission changes.
 */
const ACL_AUTHORITY_WINDOW_MS = 60_000;

/**
 * Does an `acl-changed` frame stamped at `aclChangedAt` still authorise a
 * wholesale removal at `now`? `0` means no frame has ever arrived for this
 * vault.
 *
 * Exported only so the window itself can be pinned by a test; the decision
 * belongs to {@link SyncManager.revocationAuthority}, which pairs it with
 * liveness. A negative age (a clock that moved backwards) is not freshness.
 */
export function aclSignalIsFresh(aclChangedAt: number, now: number): boolean {
  if (aclChangedAt === 0) return false;
  const age = now - aclChangedAt;
  return age >= 0 && age <= ACL_AUTHORITY_WINDOW_MS;
}

/**
 * Why a registry pull was asked for. Named rather than inferred from a stack
 * frame: the debounced pull is the one place in the sync layer where several
 * unrelated triggers converge, so "which one is firing over and over" is the
 * first question a loop raises — and a transformed stack frame answers it in
 * line numbers nobody can read.
 *
 *  - `channel-synced`     the vault channel reached `synced` (every (re)connect)
 *  - `registry-frame`     the server's `registry` control frame — a real structural change
 *  - `reauth`             the server's `reauth` frame (ACL moved; the readable SET may have too)
 *  - `acl-revoked`        the server NAMED docs we hold that we may no longer read (`ready.revoked`)
 *  - `watcher`            a local batch held an unmapped path or a `tree` event
 *  - `disk-delete-drain`  the delete drain deferred a batch's pull until it had decided
 *  - `register-failed`    a note opened unregistered, so nothing of it reaches the server yet
 *  - `revert`             a checkpoint revert re-pathed/restored rows server-side
 */
export type RegistryPullReason =
  | "channel-synced"
  | "registry-frame"
  | "reauth"
  | "acl-revoked"
  | "watcher"
  | "disk-delete-drain"
  | "register-failed"
  | "revert";

export interface OpenedDoc {
  awareness: Awareness;
  sync: DocSync | null;
  readOnly: boolean;
  status: SyncStatus;
}

/** The vault a sync session is being enabled for. */
export interface VaultTarget {
  /** Better Auth organization id (the user-facing vault). */
  orgId: string;
  /** Display name — used when a brand-new server note collection is created. */
  name: string;
  /** Absolute local folder bound to this vault. */
  path: string;
  /** Rust `vault_epoch` this folder was opened under (`ipc.VaultInfo.epoch`). */
  epoch: number | null;
  /** True only when the vault was JUST created by the user — permits the
   *  reconcile to write first-run starter content into an empty vault.
   *  Enabling sync on an adopted/joined/reopened vault never seeds. */
  seedIfEmpty?: boolean;
}

/**
 * Should the open note's provider state reach its sidebar badge?
 *
 * Pure so the rule is pinned by a test rather than by a socket. `confirmed` is
 * `registry.isPushed(docId)` — the durable "the server has this note's content"
 * checkpoint. See {@link SyncManager.reportOpenDocState} for why a confirmed
 * doc's badge must not follow the provider down.
 */
export function shouldReportOpenDocState(state: DocSyncState, confirmed: boolean): boolean {
  return state === "synced" || !confirmed;
}

/**
 * The open note's statuses that speak for the WHOLE app, not just that note.
 *
 * Each is something the vault channel has no way to express and the user has to
 * know: a view-only grant, a doc the server refused or no longer has, one over
 * the size cap. Everything outside this set ("connecting", "offline", "synced")
 * is one note's socket doing ordinary work and belongs on its own row — see
 * `effectiveStatus`.
 */
/** How long a drop out of a settled state must persist before it is painted. */
const STATUS_HOLD_MS = 400;

/** The states worth protecting from a blink — see `emitStatus`. */
const STATUS_IS_GOOD: ReadonlySet<SyncStatus> = new Set<SyncStatus>(["synced", "read-only"]);

const DOC_STATUS_OWNS_BADGE: ReadonlySet<SyncStatus> = new Set<SyncStatus>([
  "read-only",
  "no-access",
  "deleted",
  "too-large",
]);

export class SyncManager implements InboundHost {
  readonly registry = new VaultRegistry(api);

  constructor() {
    // The registry owns the only {relPath → docId} map there is, and the sidebar
    // needs it to badge a row (every sync fact is keyed by docId). Mirror it out
    // reactively — coalesced — instead of letting the UI read it imperatively
    // during render, which never re-rendered when the mapping changed.
    this.registry.setMapListener(() => {
      this.scheduleRegistryMapPublish();
      // The open note's server doc_id may only now exist. Presence is announced
      // by PATH-resolution at send time, so this is the edge that gets a frame
      // out without the user having to switch notes (#125).
      this.schedulePresenceRepush();
    });
    // Who last edited each note, refreshed by the same registry pull. Not
    // coalesced like the map above: it fires once per pull, not once per note.
    this.registry.setNoteMetaListener((meta) => this.publishNoteMeta(meta));
    // Item colors are a vault-wide fact and ride the same pull (see
    // `VaultRegistry.publishColors`).
    this.registry.setColorListener((colors) => this.publishColors(colors));
    // Every structural refusal, as it happens, in the vault's timeline. The
    // accumulated list (`registry.failures()`) answers "what is broken"; this
    // answers "when, and after what" — which is the half the Health page needs
    // to explain a failure rather than just count it.
    this.registry.setFailureListener((f) => this.logRegistryFailure(f));
    // Inbound reconciliation mutates files the editor and the background doc store
    // may be holding, so it has to be able to make them let go first.
    this.registry.setInboundHost(this);
  }

  private current: DocSync | null = null;
  /** docId of the open networked note (null when none) — the key its per-doc sync
   *  state is reported under. Keyed by docId, never by path. */
  private currentDocId: string | null = null;
  private currentLocalAwareness: Awareness | null = null;
  /** Docs already reported as "you edited this but cannot send it" — one trash
   *  copy and one failure line per doc per session, however often it is
   *  reopened (see `keepUnsendableOpenEdit`). */
  private readonly unsendableReported = new Set<string>();
  /**
   * Docs whose current 0-byte file was created by registry materialization and
   * could not yet be filled from local CRDT state. This is session provenance,
   * not an empty-file heuristic: a subsequent real watcher edit clears it.
   */
  private readonly unhydratedPlaceholders = new Set<string>();
  private enabled = false;
  /**
   * The registry has been primed from `.context/config.json`: this device
   * already knows every mapped note's doc_id, so opening one can connect a
   * provider (pull-before-seed) while the structural reconcile is still running.
   *
   * Deliberately NOT `enabled`. That flag also gates the watcher pipeline
   * (`handleLocalFilesChanged`), the debounced registry pull
   * (`handleRegistryChanged`) and attachments — none of which may run alongside
   * a reconcile: `pull()` is serialized through `pullChain` but `reconcile()` is
   * not, so two `syncStructure` passes would mutate the path maps and the shared
   * progress reporter at once (the "Syncing 585/164" class of bug).
   */
  private primed = false;
  private presence: { id: string; name: string } | null = null;
  /** The local user's chosen activity status, broadcast via awareness. */
  private status: ActivityStatus = "online";
  private onStatus?: (status: SyncStatus) => void;
  private onSessionRejected?: () => void;
  /**
   * The one place a 401 at token mint is turned into a verdict about the
   * SESSION. Every mint path below reports into it — the open note's provider,
   * the bulk uploader's per-doc providers, the vault channel — and it re-checks
   * the session before anything acts, at most once per episode. See
   * `sessionGuard.ts` for why a single 401 is never enough.
   */
  private readonly sessionGuard = new SessionRejectionGuard({
    probe: () => authManager.revalidateSession(),
    onSessionGone: () => this.onSessionRejected?.(),
  });
  private onPending?: (pending: boolean) => void;
  private onFlushed?: () => void;
  private onRegistryChanged?: () => void;
  private onAclChangedListener?: () => void;
  private onNotePathChanged?: (docId: string, from: string, to: string) => void;
  private onNoteRemoved?: (
    docId: string,
    path: string,
    trashedTo: string | null,
    reason: "deleted" | "revoked",
  ) => void;
  private onMemberJoined?: (name: string) => void;
  /** Mirrors the registry's {relPath → docId} map to the UI (coalesced). */
  private onRegistryMap?: (map: Record<string, string>) => void;
  /** Mirrors the registry's {docId → last-edit} stamps to the UI. */
  private onNoteMeta?: (meta: Record<string, NoteLastEdited>) => void;
  /** Mirrors the vault's shared {relPath → color id} map to the UI. */
  private onColors?: (colors: Record<string, string>) => void;
  private mapPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private registryPullTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the currently-armed pull's burst started (see
   *  {@link REGISTRY_PULL_MAX_WAIT_MS}); 0 when no pull is armed. */
  private registryPullBurstAt = 0;
  private attachments: AttachmentSync | null = null;
  /** Disk deletes for BINARIES — the blob mirror's own `drainDiskDeletes`
   *  (`binaryDeletes.ts`). Built and torn down beside the mirror it guards. */
  private binaryDeletes: BinaryDeleteQueue | null = null;
  /** The vault generation everything below belongs to; null while disabled. */
  private scope: VaultScope | null = null;

  // Vault-wide background sync (spec 05): the engine (one WS to /vault-sync)
  // feeds the store, which keeps every authorized doc current on disk without
  // opening it. Present only while sync is enabled.
  private docStore: VaultDocStore | null = null;
  private vaultEngine: VaultSyncEngine | null = null;
  /**
   * The collection id {@link vaultEngine} was started for.
   *
   * `startVaultEngine` is called TWICE per enable — once during the prime window
   * and once after the reconcile (see `enable`) — so it needs to recognise a
   * channel it already owns. Restarting a live one would discard precisely the
   * head start the early call exists to buy.
   */
  private vaultEngineId: string | null = null;
  /** The last status actually handed to the UI, so `emitStatus` can tell a real
   *  change from a repaint and know what it is protecting. */
  private emittedStatus: SyncStatus | null = null;
  private statusHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private onVaultStatus?: (status: VaultSyncStatus) => void;

  // ---- the vault's sync timeline (Health page) ----------------------------
  //
  // Everything below already existed as `console.info` lines nobody outside a
  // dev build can read. The log is the same facts, in sentences, kept in a
  // bounded ring so the page can answer "what happened before this note stopped
  // syncing" without a terminal.
  //
  // ONE instance for the manager's lifetime, CLEARED per vault rather than
  // re-created: a subscriber (the Health hook) holds an unsubscribe from
  // whatever instance it saw, and swapping the object under it would leave it
  // listening to a log nothing writes to. A line about the vault you left
  // explains nothing about the one you are looking at, so teardown empties it.
  private readonly log = new SyncLog();
  /**
   * The bulk-run phase the log has already reported.
   *
   * The progress mirror emits ~10×/second while a run moves; only its PHASE
   * transitions are events. Without this the timeline would be one line per
   * emission, which is a progress bar rendered as prose.
   */
  private loggedPhase: SyncProgressPhase | null = null;

  // ---- push-to-talk voice ----
  //
  // Entirely ephemeral: the player holds only what is scheduled to play in the
  // next second or so, and `voiceNames` is a display cache keyed by speaker.
  // Nothing here is written to disk, the CRDT, or the index.
  private readonly voiceRoster = new VoiceRoster((id) => colorForUser(id));
  private onVoiceSpeakers?: (speaking: VoiceSpeaker[]) => void;
  private readonly voicePlayer = new VoicePlayer({
    onSpeakingChange: (userId, speaking) => {
      if (this.voiceRoster.setSpeaking(userId, speaking)) this.emitVoiceSpeakers();
    },
  });

  // ---- bulk sync run (phase 2) ----
  //
  // One run per vault scope: register structure → push content → drain the
  // inbound backfill → report a terminal phase. Everything here is allocated in
  // `enable` and released in `teardown`, so a run can never outlive its vault.
  /** Throttled progress mirror for the store (`syncProgress`/`docSyncState`). */
  private cleanupProgress: SyncProgressReporter | null = null;
  private progress: SyncProgressReporter | null = null;
  private onSyncProgress?: (progress: SyncProgress | null) => void;
  private onDocState?: (patch: Record<string, DocSyncState | null>) => void;
  /** Whole-map mirror of the attachment mirror's per-file state
   *  (`store.fileSyncState`), keyed by path. */
  private onFileState?: (states: Record<string, DocSyncState>) => void;
  /** Explicit server verdict that this vault's attachments stay local. */
  private onAttachmentEntitlement?: (blocked: boolean) => void;
  /** The content upload for the current scope, while one is running. */
  private uploader: ContentUploader | null = null;
  /**
   * True while the BULK engine owns the vault's content: the bootstrap download
   * and the batched push, in that order.
   *
   * It is what keeps the two engines from running at once. The vault channel is
   * live-only during this window, so its `ready` lands with a settled (empty)
   * backfill and would otherwise start the per-doc content run over the very
   * docs the bulk push is about to send — two writers per doc, and the doubling
   * risk that comes with them. The bulk phase re-enters `startContentRunIfNeeded`
   * itself when it finishes, for whatever it deliberately left behind.
   */
  private bulkPhase = false;
  /** The bulk download/push for the current scope, so teardown can cancel them. */
  private bootstrapRunner: BootstrapRunner | null = null;
  private batchPusher: DocBatchPusher | null = null;
  /**
   * A batched content push is in flight.
   *
   * The twin of `uploader.isRunning()`: every guard that asks "is a content run
   * happening?" has to get the same answer whichever path the run took, or a
   * `ready` frame arriving mid-batch starts a second run over the same docs.
   */
  private batchPushing = false;
  /**
   * Notes the bulk engine could not get through, this scope, by docId.
   *
   * `completeRun` reads it beside `uploader.failedDocs()`: a bootstrap page that
   * refused a doc, or a batch item the server denied, is exactly as much "this
   * vault is not fully synced" as a failed per-doc push, and stamping `done`
   * over it would be the lie every counter here exists to prevent.
   */
  private bulkFailures = new Map<string, UploadFailure>();
  /**
   * The server does not have the bulk sync engine (404 on one of its routes).
   *
   * Terminal for the session and deliberately NOT a silent fallback to the
   * per-note path: that path is what takes 22 minutes on a 5,000-note vault, and
   * "it worked, slowly, forever" is not a diagnosis anyone can act on. The
   * structure reconcile and the vault channel still run, so the vault is
   * populated and never empty — only the content phase reports the error.
   */
  private serverTooOld = false;
  /**
   * Did we start the current vault channel in LIVE-ONLY mode?
   *
   * Tracked here rather than read back off the engine because it is OUR
   * decision (the doc count at the moment the channel was started), and because
   * the answer has to survive a `stopVaultEngine`/`startVaultEngine` pair. It is
   * what decides whether the bulk phase owes the channel a reconnect — and, when
   * the reconcile turns out to disagree with the prime window about the vault's
   * size, whether one is owed immediately.
   */
  private vaultEngineLiveOnly = false;
  /** Locally-changed MAPPED notes awaiting a content push (docId → relPath):
   *  the watcher saw an external writer (an AI, another editor) change their
   *  .md on disk. Drained by {@link runLocalChangePush}, debounced so a burst
   *  (an AI writing many files) coalesces into one run. */
  private localChanges = new Map<string, string>();
  private localChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Disk deletes seen by the watcher, awaiting {@link DISK_DELETE_GRACE_MS}
   * (docId → the path that vanished). Drained by {@link drainDiskDeletes}.
   *
   * Nothing here is committed to: an entry is cancelled by a `modified` event
   * for the same path (an atomic save, a rename-back), by the file simply being
   * there again at drain time, and by pairing with a rename.
   */
  private pendingDiskDeletes = new Map<string, { relPath: string; seenAt: number }>();
  /** Reverse index of {@link pendingDiskDeletes}: the watcher cancels by PATH. */
  private pendingDeleteByPath = new Map<string, string>();
  private diskDeleteTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Unmapped paths that appeared while a delete was pending — the other half of
   * a possible rename (`relPath → seenAt`).
   *
   * `notify` exposes no rename pairing (measured: two `Modify(Name(Any))`
   * events, one per path, nothing linking them), so the pair is reconstructed by
   * content hash at drain time. Until then the new path is only a candidate.
   */
  private renameCandidates = new Map<string, number>();
  /** A batch asked for a registry pull but also queued a disk delete, so the
   *  pull waits for the drain: pulling first would register the new half of a
   *  rename as a brand-new note (a fresh doc_id, forked history, lost backlinks)
   *  seconds before the drain could recognise the rename. */
  private pullAfterDiskDeletes = false;
  /**
   * When this session became LIVE: the vault channel has reached `synced` AND a
   * structure pull has completed. Null until then, and on teardown.
   *
   * Only a live session may propagate a disk delete. A file missing at the FIRST
   * reconcile is a different animal — an unmounted drive, a fresh clone, a
   * `.context/` restored from backup — and those re-materialize (with content,
   * see {@link materializeContent}) rather than deleting a team's notes.
   */
  private liveSince: number | null = null;
  private channelSynced = false;
  private pulledOnce = false;
  /**
   * When the server last told us THIS vault's access rules moved (`acl-changed`
   * → the `reauth` frame). 0 = never, or a different vault.
   *
   * The only thing that makes a shrunken readable set worth acting on. See
   * {@link revocationAuthority}.
   */
  private aclChangedAt = 0;
  /**
   * Every doc the server has NAMED as no longer readable in this vault session:
   * the `ready.revoked` list from each connect, UNIONED with the live `drop`
   * frames that accompany a `reauth`.
   *
   * Where {@link aclChangedAt} only says "access moved", this says WHICH docs
   * moved — and the cap lifts for those docs only.
   *
   * It is a union and it never expires, on purpose. An announcement that names
   * nothing (a lock toggle, a view↔edit flip, a share granted to a third person
   * — all of which send `reauth` to every connected client) must never be able
   * to WIDEN an authority that was correctly narrow. Clearing it on such an
   * event is what would let an unrelated permission change plus one transient
   * short listing take a whole vault off disk.
   *
   * It shrinks in exactly one way: when the access-check round trip contradicts
   * an entry ({@link revocationRefused}), which is the server's own resolver
   * saying the doc is readable after all.
   */
  private serverRevoked = new Set<string>();
  /** Docs holding local-only ops from an out-of-band merge (a resident bridge
   *  or a cold apply ingested an external edit). For these, "file == doc" does
   *  NOT mean "nothing to send", so the push must connect regardless. Cleared
   *  per doc when a push confirms it, wholesale on teardown. */
  private divergedDocs = new Set<string>();
  /**
   * docIds the SERVER says it holds no CRDT state for (`ready.empty`), replaced
   * on every vault-channel `ready`.
   *
   * The authority on what still needs uploading. `registry.isPushed` is a local
   * optimisation and can be wrong in the one direction that matters — claiming a
   * note the server never received (613 of them in prod) — so the run's work list
   * is "not confirmed locally OR named here", and these go first.
   */
  private serverEmpty = new Set<string>();
  /** The server truncated `ready.empty`: more empty docs exist than one frame
   *  names, so another `hello` is owed once this run drains them. */
  private serverEmptyTruncated = false;
  /**
   * docIds the SERVER says this device is AHEAD on (`ready.behind`): our
   * manifest carries ops it has never received. Replaced on every `ready`.
   *
   * The second authority the run keys off, for the opposite failure of
   * `serverEmpty`: the server HAS content, but not all of ours. `pushed` cannot
   * see this either — an edit typed offline and never flushed, a push cut short
   * by a failed mint — so the doc sat "synced" with local-only bytes while every
   * connect re-delivered a 2-byte empty diff for it (the "40 notes syncing on
   * every reload"). Named docs are queued exactly like `serverEmpty` ones; the
   * per-doc socket's sync then carries the missing ops up.
   */
  private serverBehind = new Set<string>();
  /**
   * Docs named by `ready.empty` whose LOCAL file is empty too — nothing anywhere.
   *
   * `ready.empty` is the authority on what the server lacks, but it cannot know
   * that this device has nothing to give: a 0-byte `.md` is a legitimate note (an
   * index stub, a placeholder someone meant to fill in). Pushing one seeds no
   * text, the server keeps holding nothing, and the NEXT connect names it again —
   * so a vault with 307 empty files "re-synced 307 notes" on every reload and
   * every vault switch, a token mint and a WebSocket apiece, for nothing. These
   * are settled here instead: marked pushed, badged synced, never queued. A
   * watcher event for the file drops it from this set so real bytes still push.
   */
  private emptyEverywhere = new Set<string>();
  /** The in-flight disk probe behind {@link handleServerEmpty}, if any. The
   *  content run waits for it, so a run never starts from a half-filtered list. */
  private emptyProbe: Promise<void> | null = null;
  /**
   * Docs the uploader gave up on PERMANENTLY (over the size ceiling): re-queuing
   * them on every `ready` would only re-fail them. They stay unsynced — and the
   * run stays `error` — until the file changes, which is when the watcher lets
   * them back in. Keyed by docId like everything else here.
   */
  private permanentFailures = new Map<string, UploadFailure>();
  /** Doc failures invalidated after that local incarnation was removed. This
   * also hides rows retained by an already-finished uploader object. */
  private invalidatedFailures = new Set<string>();
  /** True while the run is reporting the vault channel's inbound queue. */
  private downloadPhase = false;
  /**
   * The channel watchdog. The content run waits for the vault channel's `ready`
   * (download before upload), so a channel that never connects — WS blocked by a
   * proxy, server down — would otherwise leave the pill on "Syncing…" forever.
   * When this fires with no `ready` in sight, the run is stamped `error` so the
   * pill reads "Retrying…"; the next `ready` clears the stall and resumes.
   */
  private channelWatchdog: ReturnType<typeof setTimeout> | null = null;
  private channelStalled = false;
  private lastInboundDone = 0;
  private lastInboundTotal = 0;
  /**
   * Files the blob mirror has announced and not yet settled — the byte half of
   * the same counter the note backfill drives (see {@link handleBinaryDownloads}).
   *
   * Also a gate on the terminal phase: a vault is not "done" while a 50 MB
   * `.docx` is still coming down, and the wave's last settle is what re-enters
   * {@link startContentRunIfNeeded} to stamp it.
   */
  private binaryDownloads = 0;
  /** True while the progress phase belongs to a binary wave rather than to a
   *  note run — i.e. this manager stamped `downloading` for the mirror. */
  private binaryDownloadPhase = false;
  /** Resolves when the current bulk run finishes (tests). */
  private bulkRun: Promise<void> | null = null;
  private bulkDownloadPending = false;

  // The UI shows ONE connection indicator, but two things can drive it: the
  // open note's provider (authoritative for that doc, incl. read-only grants)
  // and the always-on vault channel (connects the instant a vault opens,
  // before any note). We track both and emit the effective status so switching
  // vaults lights up presence immediately — not only once a note is opened.
  /** Latest per-note provider status; null when no networked note is open. */
  private docStatus: SyncStatus | null = null;
  /** Latest vault-channel status (the always-on background feed). */
  private vaultStatus: VaultSyncStatus = "idle";

  // Vault-wide presence: which teammate is viewing which note. Keyed by userId
  // (last-write-wins across a user's devices), fed by the engine's presence
  // frames, surfaced to the sidebar. `viewingDocId` is our own current note.
  private vaultPresence = new Map<string, VaultPeer>();
  /**
   * The note THIS client is looking at, held as a PATH (plus the local index id
   * that proves a note is open) rather than as a resolved doc id.
   *
   * The id used to be resolved once, in `store.openNoteByPath`, and replayed
   * from then on — so a note opened while the post-join reconcile was still
   * running announced whatever was true in that instant (nothing, or a local
   * id) for the rest of the session, and the owner never saw the joiner
   * (#125). Resolution now happens at SEND time, in `pushLocalPresence`.
   */
  private viewing: { path: string; localId: string | null } | null = null;
  /** The docId the last presence frame carried, so a registry map change only
   *  re-announces when the RESOLVED id actually moved. */
  private announcedDocId: string | null = null;
  /** Paths already complained about (see `warnUnmapped`) — once each, per vault. */
  private warnedUnmapped = new Set<string>();
  private presenceRepushTimer: ReturnType<typeof setTimeout> | null = null;
  private onVaultPresence?: (peers: VaultPeer[]) => void;

  /** UI subscribes here to render the connection indicator. */
  setStatusListener(cb: ((status: SyncStatus) => void) | undefined): void {
    this.onStatus = cb;
  }

  /**
   * The store subscribes here to learn that the server has REFUSED this app's
   * session — checked, not guessed (see {@link sessionGuard}).
   *
   * Fires at most once per session: the handler flips `authStatus` to
   * `signed-out` and tears sync down, which is what finally makes a session that
   * lapsed mid-run look different from being offline (#145). Until it does, a
   * 401 at mint is indistinguishable from a dropped connection — the app keeps
   * accepting edits that go nowhere, and only the NEXT launch notices.
   */
  setSessionRejectedListener(cb: (() => void) | undefined): void {
    this.onSessionRejected = cb;
  }

  /** A token mint (a note's or the vault channel's) came back 401. */
  private noteSessionRejected(): void {
    void this.sessionGuard.reject();
  }

  // ---- sync timeline ------------------------------------------------------

  /**
   * This vault's recent sync events, oldest first — the Health page's
   * timeline. A copy, so a React snapshot held across a later event is stable.
   */
  syncLog(): SyncLogEntry[] {
    return this.log.entries();
  }

  /** Subscribe to sync-log changes. Returns the unsubscribe. */
  onSyncLog(cb: () => void): () => void {
    return this.log.subscribe(cb);
  }

  /**
   * Record one line of the timeline.
   *
   * Every message here is read by a person who did not write this code, so it
   * says what happened to their notes — never what happened to a data
   * structure. No state vectors, no CRDTs, no hello manifests.
   */
  private note(
    level: SyncLogLevel,
    event: string,
    message: string,
    where?: { docId?: string | null; path?: string | null },
  ): void {
    this.log.push({
      level,
      event,
      message,
      docId: where?.docId ?? null,
      path: where?.path ?? null,
    });
  }

  /** The server this vault talks to, for a message a user can recognise.
   *  Defensive: the timeline is never worth throwing for. */
  private serverHost(): string {
    try {
      const url = authManager.getServerUrl();
      return new URL(url).host || url;
    } catch {
      return "the server";
    }
  }

  /**
   * One status transition, as the user would describe it.
   *
   * Called from {@link publishStatus} — the single place a status actually
   * reaches the UI — so the timeline and the pill can never disagree. The
   * in-between states the pill deliberately swallows (`connecting`, and the
   * blink `emitStatus` holds back) are not events and are not recorded.
   */
  private logStatus(s: SyncStatus): void {
    // With no vault there is no timeline to write to. `disable()` deliberately
    // re-emits the status AFTER teardown (so a note-less disable still drops to
    // offline), and that line describes the vault we just left — logging it
    // would put one stale entry into a log we had just emptied.
    if (!this.scope) return;
    switch (s) {
      case "synced":
        this.note("info", "connect", `Connected to ${this.serverHost()}`);
        return;
      case "offline":
        this.note("warn", "offline", "Connection lost — reconnecting");
        return;
      case "read-only":
        this.note(
          "info",
          "read-only",
          "You have view-only access here — your edits stay on this device",
        );
        return;
      case "no-access":
        this.note("error", "no-access", this.vaultStatus === "no-access"
          ? "The server refused access to this vault"
          : "The server refused access to the open note");
        return;
      case "deleted":
        this.note("warn", "deleted", "The open note no longer exists on the server");
        return;
      case "too-large":
        this.note("error", "too-large", "The open note is too large for the server to accept");
        return;
      case "error":
        this.note("warn", "error", "The server could not be reached — retrying");
        return;
      default:
        // "connecting" — a handshake in progress is not news.
        return;
    }
  }

  /**
   * The bulk run's lifecycle, from the phase the progress mirror is emitting.
   *
   * Taps the mirror rather than each call site because the phases already
   * converge there: the registry, the download watchdog, the uploader and
   * `completeRun` all write through one reporter, so one tap cannot miss a
   * transition and cannot invent one.
   */
  private logRunPhase(p: SyncProgress | null): void {
    const phase = p?.phase ?? null;
    if (phase === this.loggedPhase) return;
    const prev = this.loggedPhase;
    this.loggedPhase = phase;
    if (phase == null || phase === "idle") return;
    if (phase === "removing") {
      this.note("info", "run-start", "Updating access — checking local copies");
      return;
    }
    if (phase === "registering" || phase === "uploading" || phase === "downloading") {
      // One start per run, not one per phase: a run walks registering →
      // downloading → uploading and all three are the same wave of work.
      if (prev === "registering" || prev === "uploading" || prev === "downloading") return;
      this.note("info", "run-start", "Checking every note against the server");
      return;
    }
    if (phase === "done") {
      const confirmed = p ? Math.max(0, p.done - p.failed) : 0;
      this.note("info", "run-done", `Sync finished — ${confirmed} notes confirmed`);
      return;
    }
    // "error" — the run ended without getting everything through.
    const failed = p?.failed ?? 0;
    if (failed > 0) {
      this.note("error", "run-failed", `Sync finished with ${failed} notes not synced`);
    } else {
      this.note(
        "error",
        "run-failed",
        "Sync could not finish — the app never reached the server",
      );
    }
  }

  /** One note the content push could not get to the server. */
  private logUploadFailure(f: UploadFailure): void {
    this.invalidatedFailures.delete(f.docId);
    this.note(
      "error",
      // A permanent refusal is a different fact from a failed attempt: nothing
      // retries it, so the page offers a different remedy.
      f.kind === "too-large"
        ? "too-large"
        : f.kind === "no-write-access"
          ? "no-write-access"
          : "push-failed",
      `${f.relPath} — ${f.reason}`,
      { docId: f.docId, path: f.relPath },
    );
  }

  /** One folder/note the registry could not create, move or remove. */
  private logRegistryFailure(f: RegistryFailure): void {
    this.note(
      "error",
      "register-failed",
      `${f.path} — ${f.reason}${f.code ? ` (${f.code})` : ""}`,
      { docId: f.docId, path: f.path },
    );
  }

  /**
   * UI subscribes here for the current vault's bulk-sync progress
   * (`store.setSyncProgress`). Emitted at most ~10×/second; `null` means no run
   * is in flight for the open vault.
   *
   * The sync layer never imports the store — it pushes through listeners, exactly
   * like `setStatusListener`/`setRegistryListener`.
   */
  setSyncProgressListener(cb: ((progress: SyncProgress | null) => void) | undefined): void {
    this.onSyncProgress = cb;
  }

  /**
   * UI subscribes here for per-document sync state transitions
   * (`store.patchDocSyncState`). Batched: one patch per progress emission, keyed
   * by docId — never by path.
   */
  setDocStateListener(
    cb: ((patch: Record<string, DocSyncState | null>) => void) | undefined,
  ): void {
    this.onDocState = cb;
  }

  /**
   * UI subscribes here for the sync state of the vault's FILES — the binaries
   * that ride the attachment mirror instead of the CRDT (`store.fileSyncState`).
   *
   * The whole map each time, keyed by vault-relative path — never by docId: a
   * blob's identity is its bytes, and its `files` row may have been refused.
   */
  setFileStateListener(
    cb: ((states: Record<string, DocSyncState>) => void) | undefined,
  ): void {
    this.onFileState = cb;
  }

  setAttachmentEntitlementListener(cb: ((blocked: boolean) => void) | undefined): void {
    this.onAttachmentEntitlement = cb;
  }

  /** Map the vault channel's status onto the app-wide SyncStatus vocabulary.
   *  The vault channel has no per-note "read-only" notion — that only applies
   *  once a view-only note is open, and then the note's provider takes over. */
  private vaultStatusAsSync(): SyncStatus {
    switch (this.vaultStatus) {
      case "synced":
        return "synced";
      case "connecting":
        return "connecting";
      case "no-access":
        return "no-access";
      case "error":
        return "error";
      default:
        return "offline"; // "idle"
    }
  }

  /**
   * Push the effective status to the UI.
   *
   * The vault channel is the app's connection; ONE note's provider is not. The
   * open note used to own this indicator outright, which meant every note you
   * opened repainted the vault-wide pill "connecting" while its provider did its
   * own handshake — the app reported itself as re-syncing on every single file
   * open, and a provider bounce (a token re-mint, a reauth) strobed the pill on
   * a vault that had never actually disconnected.
   *
   * So the note only speaks for the whole app when it has something to say that
   * the channel cannot express: permissions and per-doc terminal failures. Its
   * ordinary connect churn stays on the note's own sidebar row, where
   * `reportOpenDocState` already puts it.
   */
  private emitStatus(): void {
    const next = this.effectiveStatus();
    if (next === this.emittedStatus) return;
    // Settling INTO a good state is always immediate — nobody wants green held
    // back. Only the drop OUT of one waits, and only briefly: a reconnect that
    // resolves inside the window never reaches the UI at all, which is what turns
    // a token re-mint or a server blip from a visible strobe into nothing. The
    // status is still correct the moment it matters; it is simply not repainted
    // for a blink that is already over.
    const leavingGood =
      (this.emittedStatus === "synced" || this.emittedStatus === "read-only") &&
      !STATUS_IS_GOOD.has(next);
    if (!leavingGood) {
      this.clearStatusHold();
      this.publishStatus(next);
      return;
    }
    if (this.statusHoldTimer) return; // a hold is already running
    this.statusHoldTimer = setTimeout(() => {
      this.statusHoldTimer = null;
      const settled = this.effectiveStatus();
      if (settled !== this.emittedStatus) this.publishStatus(settled);
    }, STATUS_HOLD_MS);
  }

  private publishStatus(s: SyncStatus): void {
    this.emittedStatus = s;
    this.logStatus(s);
    this.onStatus?.(s);
  }

  private clearStatusHold(): void {
    if (!this.statusHoldTimer) return;
    clearTimeout(this.statusHoldTimer);
    this.statusHoldTimer = null;
  }

  private effectiveStatus(): SyncStatus {
    const vault = this.vaultStatusAsSync();
    if (!this.current) return vault;
    const doc = this.docStatus ?? this.current.status;
    // Permissions and terminal per-doc failures must reach the pill: nothing
    // else in the UI tells the user this note is view-only, gone, or too big.
    if (DOC_STATUS_OWNS_BADGE.has(doc)) return doc;
    // Otherwise a healthy channel means the app IS connected, whatever this one
    // note's socket is doing. Only when the channel itself is unhealthy does the
    // note's view of the world add anything.
    return vault === "synced" ? "synced" : doc;
  }

  /** Record the open note's provider status and re-emit the effective status.
   *  Also mirrors it into the open note's per-doc sync state, so the sidebar badge
   *  for the note you're editing stays as honest as the bulk run's badges. */
  private handleDocStatus(s: SyncStatus): void {
    this.docStatus = s;
    this.emitStatus();
    const docId = this.currentDocId;
    if (docId) {
      const state: DocSyncState =
        s === "synced" || s === "read-only"
          ? "synced"
          : s === "no-access" || s === "deleted" || s === "too-large" || s === "error"
            ? "error"
            : "syncing";
      this.reportOpenDocState(docId, state);
    }
  }

  /**
   * Mirror the OPEN note's provider state into the sidebar badge — but never
   * downgrade a note whose content the server already has.
   *
   * `DocSyncState` answers "is this note safe on the server?" (see
   * `DOC_SYNC_TITLES`), not "is a socket handshaking right now". Opening a note
   * spins up its own provider, which reports `connecting` for a few hundred
   * milliseconds; mapping that to `syncing` knocked exactly one doc out of
   * `synced`, and a folder rolls up as `synced` only when EVERY note under it is.
   * So clicking a file inside a settled green folder made it flash "83%" — which
   * reads as "my data isn't safe" and is precisely the opposite of the truth.
   *
   * For a confirmed doc the only honest badge is `synced`: a dropped socket or a
   * revoked grant changes what you can DO with the note, not whether the server
   * has it. Those belong to the vault-level indicator ("Retrying…", "No access"),
   * which reports them already. An unconfirmed doc still reports everything —
   * there, `syncing` and `error` are the truth.
   */
  private reportOpenDocState(docId: string, state: DocSyncState): void {
    if (!this.progress) return;
    if (!shouldReportOpenDocState(state, this.registry.isPushed(docId))) return;
    this.progress.doc(docId, state);
  }

  /**
   * UI subscribes here for the live save/sync activity of the open note:
   * `onPending(true)` the instant a local edit is made, `onFlushed()` once the
   * server has acked everything. Drives "Saving…" → "Synced · just now".
   */
  setActivityListeners(cbs: {
    onPending?: (pending: boolean) => void;
    onFlushed?: () => void;
  }): void {
    this.onPending = cbs.onPending;
    this.onFlushed = cbs.onFlushed;
  }

  /**
   * UI subscribes here to refresh the sidebar tree after the registry catches up
   * to a teammate's structural change (folder/note create/rename/move/delete).
   */
  setRegistryListener(cb: (() => void) | undefined): void {
    this.onRegistryChanged = cb;
  }

  /**
   * UI subscribes here to refresh its lock/share overlay when a teammate
   * changes the vault's ACL (lock/unlock, grant/revoke). Kept separate from the
   * registry listener because a pure share change often leaves the listing
   * untouched, so the registry pull would never poke that one.
   */
  setAclListener(cb: (() => void) | undefined): void {
    this.onAclChangedListener = cb;
  }

  /**
   * UI subscribes here for the open vault's {relPath → docId} index
   * (`store.docIdByPath`) — the bridge between rows, which the sidebar knows by
   * path, and sync state, which is keyed by docId. Emitted at most ~10×/second;
   * an empty object means "no vault is synced" (sync off, or teardown).
   *
   * Fires immediately with the current map so a late subscriber isn't blind until
   * the next change.
   */
  setRegistryMapListener(cb: ((map: Record<string, string>) => void) | undefined): void {
    this.onRegistryMap = cb;
    if (cb) this.publishRegistryMap();
  }

  async downloadMissingFiles(paths: readonly string[], epoch: number): Promise<void> {
    const scope = this.scope;
    if (!scope?.isCurrent() || scope.vaultEpoch !== epoch || !this.attachments) {
      throw new Error("Connect this vault to the server before downloading files.");
    }
    await this.attachments.downloadMissing(paths);
  }

  /** Vault Health's Retry for files on this computer the server lacks. */
  async retryLocalFiles(paths: readonly string[], epoch: number): Promise<void> {
    const scope = this.scope;
    if (!scope?.isCurrent() || scope.vaultEpoch !== epoch || !this.attachments) {
      throw new Error("Connect this vault to the server before retrying files.");
    }
    await this.attachments.retryFiles(paths);
  }

  async removeMissingServerFile(path: string, epoch: number): Promise<void> {
    const scope = this.scope;
    if (!scope?.isCurrent() || scope.vaultEpoch !== epoch) throw new Error("The open vault changed.");
    const id = this.registry.getFileId(path);
    if (!id) throw new Error("This file is no longer in the accessible server inventory. Check again.");
    if (!this.attachments) throw new Error("Connect this vault before removing a server file.");
    await this.attachments.removeMissingFile(path, id);
    if (!scope.isCurrent()) return;
    this.registry.forgetFileId(path);
    this.attachments?.forgetFile(path);
    await this.registry.pull();
    if (scope.isCurrent()) this.onRegistryChanged?.();
  }

  /** Billing refresh confirmed a plan change; let the binary mirror ask again. */
  recheckAttachmentEntitlement(): void {
    this.attachments?.resetEntitlement();
    this.attachments?.scheduleReconcile();
  }

  /** Ask the server again without clearing an existing refusal. Billing
   * refreshes use this to learn a policy change in a running client; a blocked
   * mirror remains blocked until a confirmed Pro transition resets it. */
  checkAttachmentEntitlement(): void {
    this.attachments?.scheduleReconcile();
  }

  /** Coalesce a burst of per-note mapping changes into one publish. */
  private scheduleRegistryMapPublish(): void {
    if (!this.onRegistryMap || this.mapPublishTimer) return;
    this.mapPublishTimer = setTimeout(
      () => this.publishRegistryMap(),
      REGISTRY_MAP_PUBLISH_MS,
    );
  }

  /**
   * Push the registry's path→docId index out now.
   *
   * Publishes an EMPTY map unless a live, current scope owns the registry: this
   * class is a process singleton, so a coalesced publish can land after a vault
   * switch, and the registry it reads would then describe the vault we left. An
   * empty map is the honest answer there — the store also clears the field on
   * every switch (`vaultScopedSyncReset`), which is the second line of defence.
   */
  private publishRegistryMap(): void {
    if (this.mapPublishTimer) {
      clearTimeout(this.mapPublishTimer);
      this.mapPublishTimer = null;
    }
    const cb = this.onRegistryMap;
    if (!cb) return;
    const map: Record<string, string> = {};
    // Gated on the SCOPE, not on `enabled`: the scope exists from the first line
    // of `enable()`, so notes badge progressively as the reconcile maps them —
    // `enabled` only flips once the whole (multi-minute) reconcile is done.
    if (this.scope?.isCurrent()) {
      for (const { docId, relPath } of this.registry.mappedNotes()) map[relPath] = docId;
    }
    cb(map);
  }

  /**
   * UI subscribes here for the open vault's {docId → last-edit} stamps
   * (`store.noteLastEdited`) — who last changed each note's *content*, and when.
   *
   * Refreshed by the registry pull, which the server already triggers when it
   * stamps an edit, so the sidebar's "edited by" tags converge on the existing
   * `registry-changed` round trip rather than a channel of their own.
   */
  setNoteMetaListener(cb: ((meta: Record<string, NoteLastEdited>) => void) | undefined): void {
    this.onNoteMeta = cb;
  }

  /**
   * Push per-note last-edit stamps out. Same scope gate as
   * {@link publishRegistryMap}: a pull that lands after a vault switch describes
   * the vault we left, and an empty map is the honest answer there.
   */
  private publishNoteMeta(meta: Record<string, NoteLastEdited>): void {
    this.onNoteMeta?.(this.scope?.isCurrent() ? meta : {});
  }

  /**
   * UI subscribes here for the vault's shared item colors, keyed by
   * vault-relative path (`store.itemColors`).
   */
  setColorListener(cb: ((colors: Record<string, string>) => void) | undefined): void {
    this.onColors = cb;
  }

  /** Same scope gate as {@link publishNoteMeta}. */
  private publishColors(colors: Record<string, string>): void {
    if (this.scope?.isCurrent()) this.onColors?.(colors);
  }

  /**
   * Persist an item color to the server so every member sees it. Silently does
   * nothing on a local (unsynced) vault — the store has already written the
   * local copy, which is the whole behaviour there.
   */
  async setItemColor(relPath: string, colorId: string | null): Promise<void> {
    if (!this.enabled) return;
    await this.registry.setColor(relPath, colorId);
  }

  /**
   * UI subscribes here to react when a new teammate joins the vault: refresh
   * the roster (so the member list updates without a reload) and celebrate.
   */
  setMemberJoinedListener(cb: ((name: string) => void) | undefined): void {
    this.onMemberJoined = cb;
  }

  /**
   * A `registry` signal arrived from the vault channel. Debounce a re-pull (a
   * burst of changes — e.g. a folder move rewriting many rows — coalesces into
   * one), then tell the UI to refresh the tree.
   *
   * This 250ms timer is the one that corrupted vaults: it outlived a vault
   * switch, then pulled with vault A's `serverVaultId` against vault B's tree.
   * It is now both cleared by `disable()` and scope-guarded (the timer captures
   * the scope it was armed under and drops if that scope is no longer current).
   *
   * Public like `handleAttachmentChanged` — both are "an external signal for this
   * vault arrived"; the vault engine wires this one in `startVaultEngine`.
   */
  handleRegistryChanged(reason: RegistryPullReason): void {
    // Which trigger asked for this pull. A pull that keeps re-arming itself is
    // invisible without this line — the badge just blinks "Syncing" — and the
    // NAME is the whole value: `reauth` vs `registry-frame` is what separated
    // "the server told us the structure moved" from "the server told us to
    // re-mint a token, and we pulled anyway" in #93.
    console.info(`[sync] registry pull requested (${reason})`);
    // A signal that arrives once sync is down (or for the vault we just left) must
    // not even ARM the timer — an armed timer is the thing that outlived the switch
    // in the first place. Requiring a live, current scope is strictly stronger than
    // checking `isCurrent()` on a possibly-null one.
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    const now = Date.now();
    if (this.registryPullTimer) {
      // Already armed. Re-arming is the coalescing, but only up to a point: past
      // REGISTRY_PULL_MAX_WAIT_MS the frames are a storm, not a burst, and
      // pushing the pull back again would starve it for the storm's duration.
      // Leave the armed timer alone and let this frame ride the pull it will run.
      if (now - this.registryPullBurstAt >= REGISTRY_PULL_MAX_WAIT_MS) return;
      clearTimeout(this.registryPullTimer);
    } else {
      this.registryPullBurstAt = now;
    }
    this.registryPullTimer = setTimeout(() => {
      this.registryPullTimer = null;
      this.registryPullBurstAt = 0;
      if (!scope.isCurrent()) return;
      void this.registry
        .pull()
        .then((changed) => {
          if (!scope.isCurrent()) return;
          // A completed structure pull is half of "this session is live" (the
          // other half is the channel reaching `synced`). Until both hold, a
          // missing file is a disk that isn't ready, not a delete.
          this.pulledOnce = true;
          this.markLive();
          // Only poke the sidebar when the pull actually changed something it
          // can see. A refresh replaces the tree's row objects, which reads as
          // a flicker under the pointer — needless on the common "nothing new"
          // pull (e.g. the catch-up pull every reconnect now makes).
          if (changed) {
            this.onRegistryChanged?.();
            // The structure moved, so the set of BINARIES this device should
            // hold may have moved with it — a teammate's new `.docx`, a file
            // that came back into a folder we can read. The blob mirror has no
            // pull of its own to ride on and was driven by local disk events
            // alone, so a server-side arrival waited for an unrelated watcher
            // event or an app restart. Debounced (400ms) and coalesced with
            // whatever the watcher already armed.
            this.attachments?.scheduleReconcile();
          }
          this.settleAfterPull(scope);
        })
        .catch((e) => console.warn("[sync] registry pull failed", e));
    }, 250);
  }

  /** True while a debounced registry pull is still armed (teardown assertions). */
  hasPendingRegistryPull(): boolean {
    return this.registryPullTimer != null;
  }

  /** True while the blob mirror has a debounced pass armed — the binary half of
   *  {@link hasPendingRegistryPull} (teardown assertions / tests). */
  hasPendingAttachmentReconcile(): boolean {
    return this.attachments?.hasPendingReconcile() ?? false;
  }

  /**
   * Promote the session to LIVE once the vault channel is `synced` AND a
   * structure pull has completed — the point from which a watcher event is
   * genuinely news rather than the app catching up with the disk.
   *
   * One-way: a later disconnect does not un-live the session. A delete observed
   * while the channel is down simply fails to reach the server and is recorded
   * as a failure, which is the same treatment every other write gets.
   */
  private markLive(): void {
    if (this.liveSince != null) return;
    if (!this.channelSynced || !this.pulledOnce) return;
    this.liveSince = Date.now();
  }

  /** True once a disk delete would be propagated (tests / diagnostics). */
  isLive(): boolean {
    return this.liveSince != null;
  }

  /**
   * May THIS pass remove files wholesale because they left the readable set?
   *
   * Inbound asks before it lifts its revocation caps (`InboundInput.authoritative`).
   * Two conditions, and both are needed:
   *
   *  - the session is LIVE — vault channel `synced` plus a completed structure
   *    pull — so "absent from the listing" cannot still mean "this device hasn't
   *    caught up yet"; and
   *  - the server itself announced an access change in the last
   *    {@link ACL_AUTHORITY_WINDOW_MS} (`acl-changed` → `reauth`), so the empty
   *    listing is the *answer to something that happened* rather than a listing
   *    that merely came back small.
   *
   * The second condition is what keeps a server-side regression from being
   * destructive. Without it, one bad deploy of the readable-set filter would
   * make every routine pull — and there is one on every reconnect — delete every
   * member's local copies. A change nobody announced is not a revocation; it
   * stays under the ordinary 50% cap and is reported as a refusal instead.
   */
  revocationAuthority(): boolean {
    return this.isLive() && aclSignalIsFresh(this.aclChangedAt, Date.now());
  }

  /**
   * WHICH docs this pass may remove past the revocation cap: every doc the
   * server has NAMED in this vault session, whether on a `ready.revoked` list or
   * as a live `drop`. `null` only when it has never named any — an older server,
   * where `reauth` keeps the wholesale lift it always had.
   *
   * A non-null set makes the pass STRICTER, and the strictness is real but
   * modest: `ready.revoked` and the listing absences both come from the SAME
   * server function (`listReadableDocsInVault`), so this is one resolver read
   * twice, at different moments over different transports. It catches a
   * transient or racy short answer on one of them. It does NOT catch a bug
   * inside that function, which would produce both readings together.
   *
   * The answer that could genuinely disagree is `effectivePermission`, and the
   * registry asks it — `POST /api/vaults/:id/access-check` — before it deletes
   * anything the cap lift saved. See `InboundPlan.needsAccessCheck`.
   *
   * Docs the server did NOT name are not exempted from removal; they simply stay
   * under the ordinary 50% cap, which the small residue of a real revocation
   * fits under comfortably.
   *
   * A TRUNCATED `ready.revoked` still contributes its 2000 ids and still
   * narrows: the residue rides the ordinary cap and the next connect names the
   * next batch, so a very large revocation converges over a few connects instead
   * of taking one uncorroborated swing at the whole disk. The largest vaults
   * would otherwise have been the ones with no cross-check at all.
   */
  authoritativeRevoked(): ReadonlySet<string> | null {
    return this.serverRevoked.size === 0 ? null : this.serverRevoked;
  }

  /**
   * The server's resolver contradicted these removals, so forget we were ever
   * told they were revoked. Without this the same ids would be re-offered on
   * every later authoritative pass, each one paying for a round trip to be told
   * the same thing.
   */
  revocationRefused(docIds: string[]): void {
    for (const docId of docIds) this.serverRevoked.delete(docId);
  }

  /**
   * The inbound plan is about to remove a revoked TREE BINARY from disk.
   *
   * Claims the watcher echo for the delete queue, which otherwise reads "gone
   * from disk, present on the server" as the user deleting the file and answers
   * with `DELETE /api/files/:id` — destroying the owner's copy of something they
   * only stopped sharing. See `BinaryDeleteQueue.suppressNext`.
   */
  suppressBinaryDelete(relPath: string): void {
    this.binaryDeletes?.suppressNext(relPath);
  }

  /**
   * A revoked tree binary has left this disk.
   *
   * The binary half of {@link noteRemoved}: no doc to drop, no CRDT rows to
   * clear (a binary never entered the pipeline that would hold any), so all that
   * is owed is the sidebar — the row's dot goes now, and the mirror re-reads
   * both listings so nothing tries to download the file back. `registry`
   * already forgot the `files` id, which is what takes it out of the next
   * `hello` and stops the server naming it revoked forever.
   */
  fileRemoved(docId: string, path: string, trashedTo: string | null): void {
    this.attachments?.forgetFile(path);
    this.attachments?.scheduleReconcile();
    this.note(
      "warn",
      "revoked",
      trashedTo
        ? `Access to ${path} was removed — a copy is in .context/trash`
        : `Access to ${path} was removed — it was taken off this device`,
      { docId, path },
    );
  }

  /** The signed-in user, used to scope legacy authorship metadata. */
  localUserId(): string | null {
    return this.presence?.id ?? null;
  }

  /**
   * One `drop` frame: the server took this doc out of our readable set while we
   * were connected.
   *
   * Recorded as a NAMED revocation, exactly like a `ready.revoked` entry. It is
   * what makes the live path as narrow as the cold one: the `reauth` that
   * follows announces "access moved" without saying about what, and on its own
   * it would have to lift the cap for everything.
   *
   * No pull is requested here — the `reauth` right behind these frames asks for
   * one, and a burst of drops must not each arm their own.
   */
  handleServerDrop(docId: string, scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    this.serverRevoked.add(docId);
  }

  /**
   * The `reauth` frame: the server says access in this vault moved.
   *
   * That statement is what authorises the pull below to act on a loss of access
   * — a listing that shrinks with no such frame behind it is treated as a glitch
   * and stays under the ordinary cap (see {@link revocationAuthority}).
   *
   * What it deliberately does NOT do is clear {@link serverRevoked}. `reauth`
   * goes to every connected client on every ACL change in the vault, including
   * ones that change nothing for this user — a lock toggled on a note they
   * cannot see, a share granted to someone else — and it names nothing. Clearing
   * would let one of those turn a correctly narrow three-note authority into a
   * whole-vault one for the next minute, which is the opposite of what an
   * announcement about something else should do. The docs a live change actually
   * took away arrive as `drop` frames just ahead of this one, and those name
   * themselves ({@link handleServerDrop}).
   */
  handleServerReauth(scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    this.aclChangedAt = Date.now();
    this.note("info", "reauth", "Permissions changed — re-checking access");
    // Two things follow from "the ACL moved". The open note re-mints its token so
    // a view<->edit flip lands live...
    this.current?.refreshAccess();
    // ...and the registry gets re-pulled, because the readable SET may have
    // changed too. That pull is what removes a note this user just lost access to
    // from their disk, and without it the removal would wait for the next
    // structural change or an app restart - long enough to look like the
    // revocation hadn't worked.
    this.handleRegistryChanged("reauth");
    // ...and the BINARIES are re-diffed against the server. This is the file
    // half of that same pull, and it has to be asked for separately: the pull
    // plans notes (`planInbound` materializes one the moment access returns),
    // while a `.pdf`/`.docx` comes back only through the blob mirror, which
    // nothing but a local disk event ever scheduled. Without this line a
    // re-granted file sat missing until some unrelated binary changed on disk
    // or the app was restarted, while a re-granted note was back in seconds.
    this.attachments?.scheduleReconcile();
    // ...and the UI's lock overlay refreshes, so the NEXT open of a just-locked
    // note starts read-only from its first frame.
    this.onAclChangedListener?.();
  }

  /**
   * The vault channel's `ready` named docs we hold that we may no longer read.
   *
   * Two effects, and the first is the point of the whole frame: it stamps the
   * ACL-authority clock, so the registry pull that follows is allowed to act on
   * a wholesale loss of access. Unlike the live `reauth` frame this one arrives
   * on EVERY connect, which is what covers a revocation made while this app was
   * closed — until now those files stayed on disk until some unrelated access
   * change happened to announce itself.
   *
   * The second is the pull itself. The channel's own `synced` transition already
   * asks for one, but that is armed AFTER this callback, and asking again costs
   * nothing: `handleRegistryChanged` debounces and both requests fold into the
   * same pass.
   *
   * Public like `handleRegistryChanged` and `handleAttachmentChanged` — all three
   * are "an external signal for this vault arrived", and the vault engine wires
   * this one in `startVaultEngine`. `scope` is the one that engine was started
   * under, deliberately rather than `this.scope`: a frame from a socket left over
   * from the previous vault must not stamp the new vault's authority.
   *
   * `truncated` changes nothing about how the list is used — the 2000 ids it did
   * carry still narrow the pass, and the residue rides the ordinary cap until a
   * later connect names it. Treating truncation as a reason to lift the cap
   * wholesale would have left the biggest revocations as the only ones with no
   * cross-check at all.
   */
  handleServerRevoked(docIds: string[], truncated: boolean, scope: VaultScope): void {
    if (!scope.isCurrent() || docIds.length === 0) return;
    this.aclChangedAt = Date.now();
    // Unioned, never replaced: a later connect's list is bounded by whatever is
    // still in the manifest, and a doc already removed from disk has left it.
    // Replacing would quietly widen the authority back out for the rest.
    for (const docId of docIds) this.serverRevoked.add(docId);
    console.info(
      `[sync] server revoked ${docIds.length} doc(s) we hold${truncated ? " (truncated)" : ""}`,
    );
    this.note(
      "warn",
      "revoked",
      // "item", not "note": the list carries tree binaries too now, and a PDF
      // reported as a note is the kind of small lie that costs a support round.
      `Access to ${docIds.length} ${docIds.length === 1 ? "item" : "items"} was removed`,
    );
    this.handleRegistryChanged("acl-revoked");
    // The cold-start ACL signal, so the binary half is re-diffed on a launch
    // whose `ready` carries an access change — the same reason the live `reauth`
    // asks for one. A pass here also re-publishes the file dots against what the
    // server will actually serve us now.
    this.attachments?.scheduleReconcile();
  }

  /**
   * One watcher `files-changed` BATCH, including the open note's own events
   * (App routes those into its bridge as well, and the uploader's suppressed-doc
   * guard keeps the open note out of the content-push queue).
   *
   * This is what makes an external writer a first-class editor: people open the
   * vault folder in an AI tool (Claude, Cursor, a script) that creates and edits
   * `.md` files directly on disk. Before this hook, those files reached the
   * server only when a human opened each note — or at the next sign-in's full
   * reconcile, which is why "sign out and back in" appeared to find unsynced
   * files. Now:
   *
   *  - a path the registry doesn't map (a NEW note), or any structural change
   *    (`tree`: folders, non-md note files) → the same debounced registry pull a
   *    teammate's change triggers, which registers it and — via `settleAfterPull`
   *    — uploads its content;
   *  - a change to a note we DO map → a debounced content push that diff-merges
   *    the file into the note's CRDT and sends it (`runLocalChangePush`);
   *  - a removal of a mapped, confirmed note in a LIVE session → a real server
   *    delete, after a {@link DISK_DELETE_GRACE_MS} grace window and under a
   *    blast-radius cap (`drainDiskDeletes`). Deleting a note in Finder, or with
   *    `rm`, or by telling an AI to tidy the vault, now means what it says.
   *    Everything that merely LOOKS like a delete for a moment — an editor's
   *    unlink-and-rewrite save, a rename, `git checkout` churn, an unmounted
   *    volume — is filtered inside that window instead.
   */
  handleLocalFilesChanged(
    changes: ReadonlyArray<{
      path: string;
      kind: "modified" | "removed" | "tree";
      /** The indexer found the file's sha256 equal to the index's — the bytes did
       *  not move (`ipc.FileChanged.unchanged`). Bookkeeping still runs; the push
       *  does not. Never set on `removed`/`tree`. */
      unchanged?: boolean;
    }>,
  ): void {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    // Binaries are the blob mirror's business and nothing of this path's.
    // `App.tsx` already routes them to `handleAttachmentChanged`; this is the
    // same rule stated where the damage would be done, because everything below
    // reads an unmapped file as "a note nobody registered yet" — which is how a
    // `.docx` in a folder used to earn a registry pull per watcher event, and
    // would earn a `notes` row the moment anything downstream stopped checking.
    changes = changes.filter((c) => !routesToAttachmentSync(c.path));
    if (changes.length === 0) return;
    // ONE registry pull for the whole batch, however many items ask for it. The
    // watcher already debounces into batches, and an AI writing 200 new files
    // used to re-enter `handleRegistryChanged` 200 times per batch — 200 timer
    // teardowns for the single pull that was always going to happen.
    let pullRegistry = false;
    let queuedDelete = false;
    // REMOVALS FIRST, in their own pass. The watcher sorts a batch by path, so
    // whether a rename's `removed` half arrives before its `modified` half is
    // pure alphabetical luck ("New.md" sorts before "Old.md") — and the second
    // pass below decides what a `modified` means by asking whether a delete is
    // pending. Deciding that against half a batch is how an external rename
    // would randomly propagate as a delete plus a brand-new note.
    for (const { path: relPath, kind } of changes) {
      if (kind !== "removed") continue;
      if (this.queueDiskDelete(scope, relPath)) queuedDelete = true;
    }
    for (const { path: relPath, kind, unchanged } of changes) {
      if (kind === "removed") continue; // handled above
      if (kind === "tree") {
        // Folders are NOT handled here, deliberately.
        //
        // `notify` is configured for file-level events, so removing a folder full
        // of notes reports the notes themselves and each one arrives as its own
        // `removed` above — which is also the only way the blast-radius cap can
        // see how much actually disappeared. Driving deletes off the folder event
        // instead would mean expanding a directory into "every note under this
        // prefix", i.e. deciding to delete notes no event ever mentioned.
        //
        // The case that reports ONLY the directory is a folder rename/move, where
        // the children never vanish at all. Nothing is deleted there; the pull
        // below reconciles the paths, and anything it re-materializes now comes
        // back WITH its content. Both outcomes are the safe direction.
        //
        // …unless the directory is one the pull itself just created or removed.
        // That echo is not an external change, and treating it as one is how a
        // pull that (wrongly) created a folder its successor removed became a
        // self-sustaining loop: every pass's own disk write requested the next
        // pass, ~1.5 s apart, for days (#98). The plan bug is fixed too, but no
        // planner asymmetry may ever be able to chain pulls through us again.
        if (this.registry.consumeMaterialized(relPath)) continue;
        pullRegistry = true;
        continue;
      }
      // Our own materialized placeholder echoing back. NOT an external edit:
      // pushing it is how a 0-byte file came to be merged into a populated doc
      // as a delete-all (#93). Only an unchanged event may spend the claim as
      // an echo. If a user edits before that echo is delivered (or the watcher
      // coalesces both writes), `unchanged: false` is real new data and must
      // clear placeholder provenance and enter the normal upload path.
      const materializedEcho = this.registry.consumeMaterialized(relPath);
      if (materializedEcho && unchanged === true) continue;
      // New bytes at a path with a delete pending: the second half of an atomic
      // save, or a rename-back. The delete is off — this single line is what
      // makes third-party editors safe.
      this.cancelDiskDelete(relPath);
      const mapping = this.registry.getMapping(relPath);
      if (!mapping) {
        // Possibly the arrival half of a rename whose departure half is pending.
        // Recorded either way; `drainDiskDeletes` decides by content hash.
        if (this.pendingDiskDeletes.size > 0) {
          this.renameCandidates.set(relPath, Date.now());
          queuedDelete = true; // hold the pull until the drain has decided
        }
        pullRegistry = true;
        continue;
      }
      // Belt and braces with the uploader's own `skip`: the open note's editor
      // session owns its provider, and its bridge already ingests watcher events.
      if (this.docStore?.suppressedDoc() === mapping.docId) continue;
      // Same bytes as the index already held, so there is nothing new to send
      // (#155). Everything ABOVE this line still ran, and each of those lines is
      // kept deliberately:
      //  - `consumeMaterialized`: the one-echo-per-materialized-path contract is
      //    spent by the event, not by what the event turned out to contain — a
      //    placeholder's echo IS an unchanged `modified`, and leaving the claim
      //    unspent would make the note's FIRST real edit look like an echo;
      //  - `cancelDiskDelete`: an editor that saves by unlinking and rewriting
      //    identical bytes (a revert, a `git checkout` back to HEAD) still owes
      //    its pending delete a cancellation — the delete is real, the rewrite
      //    is what proves the file is still there;
      //  - the unmapped branch: a file nobody maps still has to be REGISTERED,
      //    however old its bytes are. "Unchanged" says the index knew them, not
      //    that the server does.
      // What an unchanged entry must never do is queue an upload: no verdict to
      // clear, no drain to arm, no resident doc to re-ingest, and no log line —
      // an idle vault emitting these by the hundred used to read as work.
      if (unchanged) continue;
      // The file has new bytes, so two verdicts about its OLD bytes are void: an
      // empty placeholder may now hold text, and an oversized file may have been
      // trimmed under the ceiling. Both get a fresh push.
      this.emptyEverywhere.delete(mapping.docId);
      this.unhydratedPlaceholders.delete(mapping.docId);
      this.registry.clearUnhydratedPlaceholder?.(mapping.docId);
      this.permanentFailures.delete(mapping.docId);
      this.invalidatedFailures.delete(mapping.docId);
      this.localChanges.set(mapping.docId, relPath);
      this.note("info", "push-queued", "Changed on disk while closed — checking it against the server", {
        docId: mapping.docId,
        path: relPath,
      });
      this.armLocalChangeDrain(scope, LOCAL_CHANGE_DEBOUNCE_MS);
      // A doc resident in the hot tier has a LIVE bridge, and its next egest (a
      // remote update landing) would overwrite the file's new bytes before the
      // drain runs — merge them into the doc NOW. A genuine merge goes into the
      // diverged set: the drain's own ingest will then find file == doc, and only
      // this marker tells it the doc still holds unsent ops.
      const resident = this.docStore?.peekResident(mapping.docId);
      if (resident) {
        void resident
          .ingestNow()
          .then((changed) => {
            if (changed && scope.isCurrent()) this.divergedDocs.add(mapping.docId);
          })
          .catch((e) => console.warn("[sync] resident ingest failed", e));
      }
    }
    if (pullRegistry) {
      // A pull that runs BEFORE the drain would register the new half of a
      // rename as a brand-new note — a second doc_id for the same file, and a
      // 0-byte ghost materialized back at the old path. The drain re-arms it.
      if (queuedDelete) this.pullAfterDiskDeletes = true;
      else this.handleRegistryChanged("watcher");
    }
  }

  /**
   * A `.md` vanished. Queue it as a candidate delete, and say whether we did.
   *
   * Four gates, each of which is a way to destroy something that must not be
   * destroyed:
   *  - unmapped ⇒ the server has no note to delete;
   *  - not `isPushed` ⇒ this device never confirmed the content upstream, so the
   *    only copy of that work may be local (the same rule the inbound trash
   *    executor applies before it takes a file away);
   *  - not live ⇒ startup, where a missing file means "the disk isn't ready",
   *    not "the user deleted it" (see {@link liveSince});
   *  - no session/scope ⇒ nothing to propagate to.
   */
  private queueDiskDelete(scope: VaultScope, relPath: string): boolean {
    if (this.liveSince == null) return false;
    const mapping = this.registry.getMapping(relPath);
    if (!mapping) return false;
    if (!this.registry.isPushed(mapping.docId)) {
      console.info(
        `[sync] ${relPath} was deleted on disk but its content was never confirmed on the server — not propagating`,
      );
      return false;
    }
    this.pendingDiskDeletes.set(mapping.docId, { relPath, seenAt: Date.now() });
    this.pendingDeleteByPath.set(relPath, mapping.docId);
    this.armDiskDeleteDrain(scope, DISK_DELETE_GRACE_MS);
    return true;
  }

  /** The file is back at `relPath` — drop any delete pending for it. */
  private cancelDiskDelete(relPath: string): void {
    const docId = this.pendingDeleteByPath.get(relPath);
    if (docId === undefined) return;
    this.pendingDeleteByPath.delete(relPath);
    this.pendingDiskDeletes.delete(docId);
  }

  private armDiskDeleteDrain(scope: VaultScope, delayMs: number): void {
    if (this.diskDeleteTimer) clearTimeout(this.diskDeleteTimer);
    this.diskDeleteTimer = setTimeout(() => {
      this.diskDeleteTimer = null;
      if (!scope.isCurrent()) return;
      void this.drainDiskDeletes(scope).catch((e) =>
        console.warn("[sync] disk delete drain failed", e),
      );
    }, delayMs);
  }

  /**
   * Propagate the disk deletes that survived their grace window.
   *
   * Ordered so that nothing irreversible happens before everything reversible:
   *
   *   1. re-verify on DISK. The watcher's report is seconds old; anything that
   *      put the file back (a save, a checkout, a re-create) wins.
   *   2. cap the blast radius (see {@link diskDeleteCap}) — as early as the
   *      numbers allow, which is BEFORE any per-note work. A batch that cannot
   *      fit under the cap however the renames pair off is abandoned here, so an
   *      unmounted volume costs one pooled existence check and nothing else.
   *   3. pair renames. A pending delete whose text hashes equal to an unmapped
   *      file that appeared in the same window IS that file: the mapping moves
   *      (`registry.renamePath` + `ipc.rebindNoteId`) and no delete happens, so
   *      the doc_id — and with it the note's history and its backlinks —
   *      survives a rename done outside the app. Then the cap again, on what the
   *      pairing actually left.
   *   4. tell the server — `registry.deletePath`, or `registry.deletePaths` once
   *      the batch is worth a request of its own (see
   *      {@link SyncManager.propagateDiskDeletes}). Either way it is the SAME
   *      soft delete the sidebar's delete makes (the row, doc_id and Yjs state
   *      survive) and the same broadcast, so every teammate's device removes its
   *      own copy through the existing inbound path. Never `ipc.deletePath`: the
   *      file is already gone, and the registry bookkeeping this does is what
   *      stops the next pull materializing the path back as a ghost.
   */
  private async drainDiskDeletes(scope: VaultScope): Promise<void> {
    if (!this.enabled || !scope.isCurrent()) return;
    const pending = [...this.pendingDiskDeletes].map(([docId, e]) => ({
      docId,
      relPath: e.relPath,
    }));
    this.pendingDiskDeletes.clear();
    this.pendingDeleteByPath.clear();
    const candidates = [...this.renameCandidates.keys()];
    this.renameCandidates.clear();
    try {
      if (pending.length === 0) return;

      // 1. Still gone? Pooled: on a bulk delete this is N IPC calls, and they
      //    are independent questions about independent paths.
      const stillGone: Array<{ docId: string; relPath: string } | null> = new Array(
        pending.length,
      ).fill(null);
      await runPool(
        pending,
        async (item, index) => {
          let missing = false;
          try {
            missing = !(await ipc.noteExists(item.relPath, scope.vaultEpoch));
          } catch {
            missing = false; // couldn't ask ⇒ never assume a delete
          }
          if (missing) stillGone[index] = item;
        },
        // Order is preserved by the index, not by the pool: the drain's
        // reporting (and the rename pairing below) reads in watcher order.
        { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => !scope.isCurrent() },
      );
      if (!scope.isCurrent()) return;
      const gone = stillGone.filter((x): x is { docId: string; relPath: string } => x != null);
      if (gone.length === 0) return;

      // 2. Blast radius FIRST (see {@link diskDeleteCap}) — but ONLY for a
      //    window that carries no rename candidates at all.
      //
      //    The late check (after step 3) is the real one. This early twin exists
      //    for the worst shape in the whole drain: an unmounted volume used to
      //    pay for N CRDT hydrations (a `load_yjs_state` IPC, a full decode and a
      //    demote apiece) and N `get_note_meta` calls, and THEN the batch was
      //    refused — maximum cost, zero result. An unmount, a `rm -rf` or a
      //    `git clean` produces pure disappearance and NOTHING new on disk, so
      //    `unpaired.size === 0` is exactly that shape and the perf win is intact.
      //
      //    It must NOT fire when a rename could be in play. `drainDiskDeletes`
      //    has already destructively drained `renameCandidates` at the top, so
      //    returning here would throw those candidates away for good: the renamed
      //    files would sit at new paths with no mapping while the registry still
      //    maps the old ones, and the next pull would re-materialize 150 ghosts
      //    at the old paths AND register the new paths as brand-new doc_ids —
      //    the 2026-08-25 fork shape, reached from an ordinary branch switch.
      //    A window WITH candidates therefore always falls through to step 3, so
      //    every pairing gets its `registry.renamePath` + `ipc.rebindNoteId` and
      //    keeps its doc_id, and only what the pairing actually left is judged.
      //    (That also keeps the refusal's count honest — see
      //    {@link SyncManager.refuseBulkDiskDelete}: it never reports a note that
      //    was moved, not deleted.)
      const cap = diskDeleteCap(this.registry.mappedNotes().length);
      const unpaired = new Set(candidates);
      if (unpaired.size === 0 && gone.length > cap) {
        this.refuseBulkDiskDelete(gone, cap);
        return;
      }

      // 3. Renames. Each candidate pairs with at most one pending delete.
      const deletes: Array<{ docId: string; relPath: string }> = [];
      if (unpaired.size === 0) {
        // Nothing appeared in this window, so nothing can pair. The source file
        // is already gone and its text is not retained elsewhere.
        deletes.push(...gone);
      } else {
        // The index rows for everything that appeared, in ONE pooled pass rather
        // than a nested serial loop per pending delete (`matchRename` used to
        // re-ask for every candidate, for every deleted note).
        const metas = await this.candidateMetas(unpaired, scope);
        if (!scope.isCurrent()) return;
        for (const item of gone) {
          const text = await this.docText(item.docId, item.relPath);
          if (!scope.isCurrent()) return;
          const renamedTo =
            text == null ? null : await this.matchRename(text, item.relPath, unpaired, metas, scope);
          if (!scope.isCurrent()) return;
          if (renamedTo) {
            unpaired.delete(renamedTo);
            await this.applyDiskRename(item.docId, item.relPath, renamedTo, scope);
            if (!scope.isCurrent()) return;
            continue;
          }
          deletes.push({ docId: item.docId, relPath: item.relPath });
        }
      }
      if (deletes.length === 0) return;

      // …and the same cap again on what the pairing actually left, which is the
      // check this has always made.
      if (deletes.length > cap) {
        this.refuseBulkDiskDelete(deletes, cap);
        return;
      }

      // 4. The user already removed these files from disk. Propagate that final
      //    choice without manufacturing another retained copy.
      const propagated = await this.propagateDiskDeletes(deletes, scope);
      if (!scope.isCurrent()) return;
      for (const d of propagated) {
        this.note(
          "info",
          "disk-delete",
          `${d.relPath} was deleted on this device — removed from the server for everyone`,
          { docId: d.docId, path: d.relPath },
        );
        // The OPEN note keeps its bridge deliberately. The editor is still
        // mounted (the banner offers to close it), and destroying the Y.Doc
        // under CodeMirror throws on the next keystroke — which is why the
        // inbound trash path closes the note in the store FIRST. If the user
        // does type into a note they deleted from disk, the egest recreates the
        // file and the next pull registers it as a new note: a resurrection they
        // asked for, with no ghost and nothing lost.
        //
        // Its network PROVIDER is a different matter and must go. The server has
        // just tombstoned this doc, so `POST /api/sync-token` answers 404 for it
        // from now on (`sync-token.ts` filters `deleted_at IS NULL`); the mint
        // fails, the provider's token function falls back to `""`, and the server
        // rejects every connect — a reject/reconnect cycle that outlived the note
        // for as long as it stayed open, flooding the server log with
        // `[onAuthenticate] rejected … (token length 0)` and strobing the sync
        // badge, which follows the open note's provider. `closeCurrent` takes down
        // the DocSync and its awareness only; the bridge, the editor and the
        // banner are untouched.
        if (this.currentDocId === d.docId) this.closeCurrent();
        //
        // Its badge, its queue entries and its empty-doc verdicts all describe a
        // note that no longer exists here.
        this.localChanges.delete(d.docId);
        this.divergedDocs.delete(d.docId);
        this.serverEmpty.delete(d.docId);
        this.serverBehind.delete(d.docId);
        this.emptyEverywhere.delete(d.docId);
        this.permanentFailures.delete(d.docId);
        this.progress?.forgetDoc(d.docId);
      }
      this.progress?.flush();
      await this.registry.flushCheckpoint();
    } finally {
      // Whatever happened above, a batch that asked for a pull gets one now.
      if (this.pullAfterDiskDeletes && scope.isCurrent()) {
        this.pullAfterDiskDeletes = false;
        this.handleRegistryChanged("disk-delete-drain");
      }
    }
  }

  /**
   * The doc's current text, from whichever bridge already owns it.
   *
   * Never opens a SECOND bridge for a doc that has one: two bridges on one
   * doc_id both persist, both egest, and their histories merge into doubled
   * text. Falls back to a transient promote (hydrating from the local CRDT log)
   * for a doc nothing holds, and to null when there is no store at all.
   */
  /**
   * Step 4 of the drain: remove from the SERVER the notes already deleted from
   * disk, and answer with the ones that actually went.
   *
   * One request per {@link BATCH_MAX_NOTES} chunk once the batch is worth it
   * ({@link useBulkPath}, 25) — a 500-note `git clean` was 500 serial DELETEs,
   * each re-resolving the permission algebra and each broadcasting a
   * `registry-changed` every peer re-pulled on. Below the threshold the per-note
   * call stays: the saving is sub-second there and a rarely-exercised safety
   * path IS the bug.
   *
   * Both paths make the SAME call the sidebar's Delete makes (a soft delete —
   * never `ipc.deletePath`, the file is already gone) and refuse in the same
   * way: a note the server would not remove keeps its mapping, so the next pull
   * re-materializes it WITH its content rather than leaving a ghost.
   */
  private async propagateDiskDeletes(
    deleted: ReadonlyArray<{ docId: string; relPath: string }>,
    scope: VaultScope,
  ): Promise<Array<{ docId: string; relPath: string }>> {
    const propagated: Array<{ docId: string; relPath: string }> = [];
    if (deleted.length === 0) return propagated;
    const refused = (d: { docId: string; relPath: string }, reason: string, code: string | null) =>
      this.registry.recordFailure({
        kind: "inbound",
        path: d.relPath,
        docId: d.docId,
        reason: `deleted on disk, but the server refused to remove it (${reason})`,
        code,
      });

    if (useBulkPath(deleted.length)) {
      let outcomes;
      try {
        outcomes = await this.registry.deletePaths(deleted.map((d) => d.relPath));
      } catch (e) {
        // `deletePaths` reports per path and does not throw, so this is the
        // registry itself failing. Report every note: none of them went.
        for (const d of deleted) refused(d, reasonOf(e), null);
        return propagated;
      }
      if (!scope.isCurrent()) return propagated;
      const byPath = new Map(outcomes.map((o) => [o.path, o]));
      for (const d of deleted) {
        const out = byPath.get(d.relPath);
        if (out?.status === "deleted") {
          propagated.push(d);
          continue;
        }
        refused(d, out?.reason ?? "the server did not answer for this note", out?.code ?? null);
      }
      return propagated;
    }

    await runPool(
      deleted,
      async (d) => {
        if (!scope.isCurrent()) return;
        try {
          await this.registry.deletePath(d.relPath);
        } catch (e) {
          // Offline, or the server refused (no edit grant). The mapping is
          // untouched, so a later pull re-materializes the file WITH its
          // content — the delete simply did not happen, which is the honest
          // outcome.
          refused(d, reasonOf(e), null);
          return;
        }
        if (!scope.isCurrent()) return;
        propagated.push(d);
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => !scope.isCurrent() },
    );
    return propagated;
  }

  /**
   * Abandon a whole window of disk deletes and say so, loudly and per note.
   *
   * The WHOLE batch, never a prefix: "the disk just lost a fifth of the vault"
   * is never a delete a person meant, and propagating the first `cap` of them
   * would be the same accident with a smaller blast radius. Shared by the two
   * places that can reach the verdict — the cheap bound taken before any per-note
   * work, and the exact count once renames have been paired off.
   */
  private refuseBulkDiskDelete(
    items: ReadonlyArray<{ docId: string; relPath: string }>,
    cap: number,
  ): void {
    console.warn(
      `[sync] ${items.length} notes disappeared from disk at once (cap ${cap}) — not removed from the server`,
      items.map((d) => d.relPath).slice(0, 10),
    );
    toast(
      `${items.length} notes disappeared from disk at once — they were NOT removed from the server. ` +
        `If the folder was unmounted or checked out, reopening the vault restores them.`,
      "error",
    );
    this.note(
      "warn",
      "bulk-delete-refused",
      `${items.length} notes vanished from this folder at once — they were left on the server ` +
        `in case the folder was unmounted or checked out`,
    );
    for (const d of items) {
      this.registry.recordFailure({
        kind: "inbound",
        path: d.relPath,
        docId: d.docId,
        reason:
          `${items.length} notes vanished from disk in one window (cap ${cap}) — ` +
          `left on the server deliberately`,
        code: null,
      });
    }
  }

  /**
   * The index rows for every file that appeared in this window, in one pooled
   * pass.
   *
   * `matchRename` asks about the SAME candidate set for every deleted note, so
   * reading them once turns an N×M serial IPC loop into M parallel reads. A row
   * that cannot be read is recorded as `null` (the caller's basename fallback),
   * never skipped, so the map answers for every candidate.
   */
  private async candidateMetas(
    candidates: ReadonlySet<string>,
    scope: VaultScope,
  ): Promise<Map<string, Awaited<ReturnType<typeof ipc.getNoteMeta>>>> {
    const metas = new Map<string, Awaited<ReturnType<typeof ipc.getNoteMeta>>>();
    await runPool(
      [...candidates],
      async (candidate) => {
        try {
          metas.set(candidate, await ipc.getNoteMeta(candidate));
        } catch {
          metas.set(candidate, null);
        }
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => !scope.isCurrent() },
    );
    return metas;
  }

  private async docText(docId: string, relPath: string): Promise<string | null> {
    const open = bridgeManager.currentBridge();
    if (open && open.docId === docId) return open.serialize();
    const store = this.docStore;
    if (!store) return null;
    const resident = store.peekResident(docId);
    if (resident) return resident.serialize();
    try {
      const bridge = await store.promote(docId, relPath, {
        seedFromFile: false, // the file is gone; the CRDT is all there is
        markRecent: false,
        pin: true,
      });
      try {
        return bridge.serialize();
      } finally {
        await store.demote(docId);
      }
    } catch (e) {
      console.warn(`[sync] couldn't read the doc behind ${relPath}`, e);
      return null;
    }
  }

  /**
   * Which candidate path (if any) holds exactly this text?
   *
   * By content hash, against the sha256 the Rust index already computed when it
   * indexed the new file — the watcher indexes a batch BEFORE it emits the event
   * that got us here, so the row is there. A file over the index's size cap
   * stores no hash; those fall back to basename equality, which paired with "a
   * note of the same name vanished in this very window" is decisive enough for
   * the only alternative on offer (delete it and register a twin).
   */
  private async matchRename(
    text: string,
    from: string,
    candidates: Set<string>,
    metas: ReadonlyMap<string, Awaited<ReturnType<typeof ipc.getNoteMeta>>>,
    scope: VaultScope,
  ): Promise<string | null> {
    if (candidates.size === 0) return null;
    const wanted = await sha256Hex(text);
    if (!scope.isCurrent()) return null;
    let byName: string | null = null;
    for (const candidate of candidates) {
      const meta = metas.get(candidate) ?? null;
      if (meta?.sha256) {
        if (meta.sha256 === wanted) return candidate;
        continue;
      }
      // No hash stored (oversized file): basename equality is the only signal.
      if (baseName(candidate) === baseName(from)) byName = candidate;
    }
    return byName;
  }

  /**
   * A rename done outside the app: move the mapping instead of deleting a note.
   *
   * Both halves matter. `registry.renamePath` moves the SERVER row (and the
   * local path map) by doc_id, and `ipc.rebindNoteId` puts that doc_id back on
   * the index row the watcher minted a fresh uuid for. Without the second, the
   * same file carries one identity in `.context/config.json` and another in
   * `index.sqlite`, and the next pass registers it a second time.
   */
  private async applyDiskRename(
    docId: string,
    from: string,
    to: string,
    scope: VaultScope,
  ): Promise<void> {
    console.info(`[sync] ${from} → ${to} (renamed on disk; keeping doc ${docId})`);
    try {
      await this.registry.renamePath(from, to);
    } catch (e) {
      console.warn(`[sync] couldn't move the mapping ${from} → ${to}`, e);
      return;
    }
    if (!scope.isCurrent()) return;
    try {
      await ipc.rebindNoteId(to, docId, scope.vaultEpoch);
    } catch (e) {
      if (!ipc.isVaultMismatch(e)) console.warn(`[sync] couldn't rebind ${to} to ${docId}`, e);
    }
    if (!scope.isCurrent()) return;
    // The file at the new path may hold edits made in the same breath as the
    // rename, and the note's row moved, so both surfaces need telling.
    this.localChanges.set(docId, to);
    this.note("info", "push-queued", "Renamed on disk — re-sending it under the new name", {
      docId,
      path: to,
    });
    this.armLocalChangeDrain(scope, LOCAL_CHANGE_DEBOUNCE_MS);
    this.onNotePathChanged?.(docId, from, to);
  }

  /** Single-event form of {@link handleLocalFilesChanged}, for call sites that
   *  see one change at a time. */
  handleLocalFileChanged(
    relPath: string,
    kind: "modified" | "removed" | "tree",
    unchanged = false,
  ): void {
    this.handleLocalFilesChanged([{ path: relPath, kind, unchanged }]);
  }

  private armLocalChangeDrain(scope: VaultScope, delayMs: number): void {
    if (this.localChangeTimer) clearTimeout(this.localChangeTimer);
    this.localChangeTimer = setTimeout(() => {
      this.localChangeTimer = null;
      if (!scope.isCurrent()) return;
      // A bulk run (enable's backfill, or a settle pass) is single-writer on the
      // uploader slot AND may be about to push these very docs. Wait it out; the
      // queue survives, so nothing is dropped.
      if (this.contentRunInFlight()) {
        this.armLocalChangeDrain(scope, LOCAL_CHANGE_RETRY_MS);
        return;
      }
      void this.runLocalChangePush(scope).catch((e) =>
        console.warn("[sync] local change push failed", e),
      );
    }, delayMs);
  }

  /**
   * Push the queued locally-changed notes: same engine as the bulk backfill, but
   * `force` (these docs are already "pushed" — that checkpoint says nothing
   * about the new bytes) and `ingestFromFile` (the change lives in the file, not
   * the doc). The uploader's echo guard keeps this cheap: a file write that was
   * our own background egest merges to "no change" and never opens a socket.
   */
  private async runLocalChangePush(scope: VaultScope): Promise<void> {
    const vaultId = this.registry.vaultId;
    const store = this.docStore;
    const progress = this.progress;
    if (!vaultId || !store || !progress) {
      // The queue survives this guard (it is only cleared below), but nothing
      // re-armed the timer — so a drain that fired before the vault engine
      // existed parked its notes for good. Retry, exactly like the
      // uploader-busy branch in `armLocalChangeDrain`.
      if (this.localChanges.size > 0 && scope.isCurrent()) {
        this.armLocalChangeDrain(scope, LOCAL_CHANGE_RETRY_MS);
      }
      return;
    }
    const notes = [...this.localChanges].map(([docId, relPath]) => ({ docId, relPath }));
    this.localChanges.clear();
    if (notes.length === 0) return;

    // This run emptied `localChanges` up front, so every note it did not manage
    // to confirm is now owned by nobody: a doc that is already `isPushed` is not
    // in the bulk run's work list either, so it would sit there until the next
    // watcher event for that same file. Put the batch back before abandoning the
    // run and let the next drain retry it — a note whose bytes DID land ingests
    // to "no change" and costs no socket, so the retry is cheap (#104).
    const requeue = (subset: ReadonlyArray<{ docId: string; relPath: string }> = notes): void => {
      if (!scope.isCurrent()) return;
      for (const n of subset) {
        if (!this.localChanges.has(n.docId)) this.localChanges.set(n.docId, n.relPath);
      }
      this.armLocalChangeDrain(scope, LOCAL_CHANGE_RETRY_MS);
    };

    // ── Above the threshold this drain batches too ───────────────────────────
    //
    // An AI (or a `cp -r`) writing hundreds of `.md` into a running vault
    // arrives here, and one socket per note is the same 3.7 notes/second the
    // batch engine was built to kill. The ingest that makes this path different
    // from the backfill — the new text is in the FILE, not in the doc — moves
    // into the pusher, where it stays split-brain safe by running only on a doc
    // that already has content (`docBatchPush.ts`). Everything else is the same
    // batch: no token mint, no handshake, one request per 200 notes.
    let pending: Array<{ docId: string; relPath: string }> = notes;
    if (!this.serverTooOld && useBulkPath(notes.length)) {
      const result = await this.runDocBatchPush(
        scope,
        vaultId,
        store,
        notes.map((n) => ({
          docId: n.docId,
          relPath: n.relPath,
          serverEmpty: this.serverEmpty.has(n.docId),
          ingestFromFile: true,
          // "Nothing to send" for this drain means: the ingest found the file
          // and the doc already equal AND the server holds that state. A doc the
          // server named empty or behind, or one holding ops an out-of-band
          // merge folded in (`divergedDocs`), is none of those — its state goes
          // up even when the file changed nothing, which is what `mustConnect`
          // buys on the per-doc path.
          settledIfUnchanged:
            this.registry.isPushed(n.docId) &&
            !this.serverEmpty.has(n.docId) &&
            !this.serverBehind.has(n.docId) &&
            !this.divergedDocs.has(n.docId),
        })),
      );
      if (result == null) return requeue();
      if (isServerTooOld(result.transportError)) {
        // Terminal for the session, like every other bulk route (design §3.7).
        // Not requeued: the next drain would take the same 404.
        this.reportServerTooOld(scope);
        return;
      }
      if (result.cancelled) return requeue();

      // A transport failure fails EVERY item of its chunk — up to
      // `BATCH_MAX_DOCS` (100) notes on one 502 from a restarting server. Those
      // docs are `isPushed`, so they are not in `contentWorkList` either, and
      // their freshly-ingested text would sit in the local CRDT until a future
      // reconnect's `ready.behind` noticed it — hours on a healthy socket. The
      // old per-doc path retried within seconds because the update sat in the
      // provider's buffer, so put the retryable ones back in the queue and let
      // the debounced drain take them again. A note whose bytes DID land ingests
      // to "no change" and costs nothing, so an over-broad requeue is cheap.
      // Permanent failures (`too_large`) keep `recordBulkFailure` alone:
      // retrying them re-reports the same refusal forever. A denied batch item
      // is a leftover, not a failure: the per-doc pull still has to determine
      // whether there is any unsendable local edit at all.
      const retryable = result.failures.filter((f) => !f.permanent);
      if (retryable.length > 0) {
        requeue(retryable.map((f) => ({ docId: f.docId, relPath: f.relPath })));
      }

      pending = this.batchLeftovers(result, notes);
      if (pending.length === 0) {
        this.completeRun(scope);
        return;
      }
    }

    const uploader: ContentUploader = new ContentUploader({
      vaultId,
      notes: pending,
      deps: {
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, {
            seedFromFile: false, // pull-before-seed, exactly like the bulk run
            markRecent: true, // an externally-edited note is genuinely recent
            pin: true,
          }),
        release: (docId) => store.demote(docId),
        connect: ({ docId, vaultId: collectionId, doc }) =>
          new DocSync({
            api,
            doc,
            docId,
            vaultId: collectionId,
            // A run connects one provider per note, so a lapsed session refuses
            // a mint for every doc in the vault in seconds. The guard coalesces
            // that burst into ONE session check.
            onSessionRejected: () => this.noteSessionRejected(),
          }),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
        writeTrashCopy: (relPath, stamp, content) =>
          ipc.writeTrashCopy(relPath, stamp, content, scope.vaultEpoch),
      },
      isPushed: (docId) => this.registry.isPushed(docId),
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
        this.divergedDocs.delete(docId); // its local-only ops are now on the server
        this.serverBehind.delete(docId);
      },
      skip: (docId) => store.suppressedDoc() === docId,
      force: true,
      ingestFromFile: true,
      mustConnect: (docId) => this.divergedDocs.has(docId),
      isUnhydratedPlaceholder: (docId, _relPath, fileText) =>
        fileText.length === 0 &&
        (this.unhydratedPlaceholders.has(docId) ||
          this.registry.isUnhydratedPlaceholder?.(docId)),
      progress,
      // Most local-change runs are our own egest echoing back; the pill only
      // says "Syncing" once a note actually needs the server.
      lazyPhase: true,
      onFailure: (f) => this.logUploadFailure(f),
      shouldStop: (): boolean => !scope.isCurrent() || this.uploader !== uploader,
    });
    this.uploader = uploader;

    const result = await uploader.run();
    if (!scope.isCurrent() || this.uploader !== uploader) return requeue(pending);
    this.recordPermanentFailures(uploader);
    await this.registry.flushCheckpoint();
    if (!scope.isCurrent() || this.uploader !== uploader) return requeue(pending);
    if (result.cancelled) return requeue(pending);
    this.completeRun(scope);
  }

  // ---- InboundHost: letting go of a doc before its path moves --------------
  //
  // The registry is about to rename or remove a file. Anything still holding the
  // OLD path would egest to it afterwards and recreate the file — and because the
  // watcher already dropped that path from the index, the recreated file is indexed
  // under a FRESH doc_id, so the note comes back AND forks into a second server
  // row. There are three independent writers to stop, and missing any one of them
  // leaves that door open.

  async releaseDoc(docId: string): Promise<void> {
    // 1. The open editor. Kill the network provider FIRST so no further remote
    //    update can arrive and re-arm an egest, then flush + destroy the bridge.
    //    The flush writes any pending bytes to the OLD path, which is what we
    //    want: for a rename they then travel with the file; for a confirmed
    //    removal the subsequent delete takes the final bytes. Nothing is written
    //    back AFTER the move/removal.
    if (this.currentDocId === docId) {
      this.closeCurrent();
      await bridgeManager.closeCurrent();
    }
    // 2 & 3. The background hot bridge and any in-flight cold apply.
    await this.docStore?.release(docId);
  }

  notePathChanged(docId: string, from: string, to: string): void {
    this.onNotePathChanged?.(docId, from, to);
  }

  /**
   * Fill a freshly materialized placeholder from THIS DEVICE's local CRDT.
   *
   * The reported case for #93 needs no network at all: the note's text is
   * already in `.context/index.sqlite` (`yjs_updates` / `yjs_snapshot`), because
   * this device is the one that wrote it. `loadYjsState` is the cheap "do we hold
   * this doc" question; when the answer is no — a genuinely fresh device — we
   * leave the 0-byte placeholder and let the existing lazy paths (open, or the
   * vault channel's backfill) hydrate it.
   *
   * `promote` → write → `demote` is the same three-step the content uploader and
   * the cold-apply path already use, so no new way of touching a doc is invented
   * here. The write goes through the bridge rather than `ipc.writeNote` so the
   * echo hash is set: the watcher event for this write is then recognised as our
   * own and no content push is queued for it.
   */
  async materializeContent(docId: string, path: string): Promise<boolean> {
    const scope = this.scope;
    const store = this.docStore;
    if (!scope || !scope.isCurrent() || !store) return false;
    // This hook is called only after the registry creates a server-only note's
    // empty file. Keep that fact after its one watcher echo is consumed so the
    // later read-only pull can distinguish the placeholder from a user delete.
    this.unhydratedPlaceholders.add(docId);
    this.registry.markUnhydratedPlaceholder?.(docId);
    try {
      const state = await ipc.loadYjsState(docId, scope.vaultEpoch);
      if (!state.snapshot && state.updates.length === 0) return false;
    } catch {
      return false; // no local CRDT (or it can't be read) ⇒ hydrate lazily
    }
    if (!scope.isCurrent()) return false;
    // Whichever bridge already owns this doc does the write — a second bridge on
    // one doc_id is the doubling bug.
    const open = bridgeManager.currentBridge();
    if (open && open.docId === docId) {
      const wrote = await open.writeThrough();
      if (wrote) {
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
      }
      return wrote;
    }
    const resident = store.peekResident(docId);
    if (resident) {
      const wrote = await resident.writeThrough();
      if (wrote) {
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
      }
      return wrote;
    }
    const bridge = await store.promote(docId, path, {
      seedFromFile: false, // the file is the 0-byte placeholder we just made
      markRecent: false, // a 500-note pull must not evict the real recency list
      pin: true,
    });
    try {
      if (bridge.serialize().length === 0) return false; // nothing to write
      const wrote = await bridge.writeThrough();
      if (wrote) {
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
      }
      return wrote;
    } finally {
      await store.demote(docId);
    }
  }

  noteRemoved(
    docId: string,
    path: string,
    trashedTo: string | null,
    reason: "deleted" | "revoked",
    crdtCleared = false,
  ): void {
    // Every verdict below described the local incarnation that just left the
    // readable set. Keeping a terminal no-write result across revocation makes
    // the same stable doc_id permanently ineligible for re-evaluation when it
    // later returns as Read-only. Recovery copies remain in `.context/trash`
    // and are surfaced by the vault checks; the sync failure itself is stale.
    this.localChanges.delete(docId);
    this.divergedDocs.delete(docId);
    this.serverEmpty.delete(docId);
    this.serverBehind.delete(docId);
    this.emptyEverywhere.delete(docId);
    this.permanentFailures.delete(docId);
    this.bulkFailures.delete(docId);
    this.invalidatedFailures.add(docId);
    this.unsendableReported.delete(docId);
    this.unhydratedPlaceholders.delete(docId);
    this.registry.clearUnhydratedPlaceholder?.(docId);
    this.progress?.forgetDoc(docId);

    if (reason === "revoked") {
      // `releaseDoc` only RELEASED this doc, which deliberately keeps its state
      // vector (a rename doesn't change content, so the manifest stays true).
      // A revocation is the other case: the doc is gone for good, and an id left
      // in the manifest is re-sent in every `hello`, so the server names it in
      // every `ready.revoked` — re-stamping the ACL-authority clock on each
      // reconnect and making "the server announced a change in the last minute"
      // permanently true. `drop` takes it out of the manifest for this session…
      this.docStore?.drop(docId);
      // …and this takes the local CRDT rows (the persisted state vector among
      // them) out of `.context/index.sqlite`, so the next launch doesn't
      // re-advertise it either. It is also the right privacy answer: leaving the
      // note's full text in the local CRDT log would keep readable what deleting
      // the `.md` just took away. Fire-and-forget — a failure only means the
      // vault-open GC sweep tidies it instead, and nothing here may block the
      // removal loop.
      const epoch = this.scope?.vaultEpoch ?? undefined;
      if (!crdtCleared) void ipc.clearYjsDoc(docId, epoch).catch(() => {});
    }
    this.onNoteRemoved?.(docId, path, trashedTo, reason);
  }

  /** Called after an inbound rename lands on disk (store re-points the editor). */
  setInboundListeners(listeners: {
    onNotePathChanged?: (docId: string, from: string, to: string) => void;
    onNoteRemoved?: (
      docId: string,
      path: string,
      trashedTo: string | null,
      reason: "deleted" | "revoked",
    ) => void;
  }): void {
    this.onNotePathChanged = listeners.onNotePathChanged;
    this.onNoteRemoved = listeners.onNoteRemoved;
  }

  /**
   * Land the vault on a coherent state after a registry pull.
   *
   * A pull re-enters the `registering` phase (it may create rows for a teammate's
   * new folders/notes), so *something* has to re-stamp a terminal phase or the
   * vault sits on "registering 1/1" forever after someone else adds one note.
   *
   * But a pull can also ADOPT notes — a teammate's new note arrives as a mapped
   * row plus an empty placeholder file. Stamping `done` there would claim the
   * vault is fully synced while that note has no content on this device, and the
   * sidebar would (correctly, and contradictorily) badge its row as not synced.
   * So: if anything is still unconfirmed (or the server told us it holds no
   * content for it), run the content pass that confirms it and let THAT run stamp
   * the terminal phase — `startContentRunIfNeeded` decides which, and defers to
   * the vault channel's backfill if one is still arriving.
   */
  private settleAfterPull(scope: VaultScope): void {
    if (this.bulkDownloadPending && !this.bulkPhase && !this.contentRunInFlight()) {
      this.bulkDownloadPending = false;
      this.vaultEngineLiveOnly = true;
      this.vaultEngine?.reconnect({ liveOnly: true });
      this.bulkRun = this.runBulkEngine(scope).catch((e) => {
        console.warn("[sync] access restore download failed", e);
      });
      return;
    }
    // A live run will reach its own terminal phase and will pick up whatever the
    // pull added, because the queue is rebuilt from `mappedNotes()` minus the
    // pushed set. Restarting it here instead would let a busy team's structural
    // churn abandon the initial backfill over and over.
    if (this.contentRunInFlight()) return;
    this.startContentRunIfNeeded(scope);
  }

  /**
   * Start the content run, or stamp the terminal phase when there is nothing to
   * send. The ONE entry point for starting a run, called from every edge that can
   * change the answer: the download phase settling, a `ready` frame, a registry
   * pull, and the user's manual retry.
   *
   * Two gates, both load-bearing:
   *
   *  - a run already in flight is left alone. Its queue is rebuilt from
   *    `mappedNotes()` minus the pushed set, so it picks up whatever arrived
   *    while it was running; restarting it would let a busy team's structural
   *    churn abandon the initial backfill over and over.
   *  - the vault channel's backfill must have settled. Uploading a doc the
   *    channel is about to hand us is the double delivery this exists to remove,
   *    and the settle edge re-enters here anyway.
   */
  private startContentRunIfNeeded(scope: VaultScope): void {
    if (!this.enabled || !scope.isCurrent()) return;
    if (this.bulkDownloadPending) {
      if (!this.contentRunInFlight() && !this.bulkPhase) this.handleRegistryChanged("reauth");
      return;
    }
    if (this.contentRunInFlight()) return;
    // The bulk engine owns the vault's content right now. Its channel is
    // live-only, so `ready` arrives with a settled backfill and this edge fires
    // immediately — starting the per-doc run here would put a second writer on
    // every doc the batch push is about to send. The bulk phase re-enters here
    // itself once it is done, with only what it left behind.
    if (this.bulkPhase) return;
    // This server does not have the bulk engine. Falling back to the per-note
    // path here is exactly the silent degradation the hard cut exists to
    // prevent: it would open a socket per note, take ~22 minutes on a large
    // vault, and report success. The channel still backfills (the vault is
    // never empty); the content run stays stopped and the phase stays `error`.
    if (this.serverTooOld) return;
    // The `ready.empty` list is still being checked against disk. Starting now
    // would queue every named doc — including the empty placeholders the probe
    // is about to settle — so the probe's completion re-enters here instead.
    if (this.emptyProbe) return;
    const engine = this.vaultEngine;
    if (engine && !engine.backfillSettled()) return;
    if (this.contentWorkList().length === 0) {
      // …but bytes may still be moving. A binary wave reports through the same
      // counter (see `handleBinaryDownloads`), and stamping `done` on top of it
      // would badge the vault fully synced while a 50 MB file is mid-flight.
      // The wave's last settle re-enters here.
      if (this.binaryDownloads > 0) return;
      // Nothing to send. Stamp a terminal phase once, and only once: this edge
      // fires again on every drained inbound frame (a teammate typing), and
      // re-stamping `done` there would be a store write per keystroke.
      const phase = this.progress?.snapshot().phase;
      const stalled = this.channelStalled;
      this.channelStalled = false;
      if (phase !== "done" && (phase !== "error" || stalled)) {
        // The per-doc badges too. A run's uploader stamps every confirmed note
        // `synced` before its first socket; with no run there was nobody to do
        // it, so a fully-synced vault sat on "0/N" folder badges until something
        // happened to start one. Same guard as the phase: once per settle.
        this.badgeConfirmedDocs();
        this.completeRun(scope);
      }
      return;
    }
    this.bulkRun = this.runBulkSync(scope).catch((e) => {
      console.warn("[sync] content sync failed", e);
    });
  }

  /** Report every note the server is known to hold as `synced` (one coalesced
   *  patch). The open note is left to its own provider's reporting. */
  private badgeConfirmedDocs(): void {
    const progress = this.progress;
    if (!progress) return;
    const open = this.docStore?.suppressedDoc() ?? null;
    for (const { docId } of this.registry.mappedNotes()) {
      if (
        docId !== open &&
        this.registry.isPushed(docId) &&
        !this.serverEmpty.has(docId) &&
        !this.serverBehind.has(docId)
      ) {
        progress.doc(docId, "synced");
      }
    }
  }

  /**
   * The docs a content run would push: not confirmed by this device, OR named by
   * the server's `ready.empty` (which outranks our checkpoint). The open note is
   * excluded — its editor session owns that doc's provider.
   *
   * Replaces the old `unconfirmedNotes()` count, which asked the narrower
   * (device-local) question and could therefore never see a note the server had
   * lost. A freshly materialized note is an EMPTY `.md` on disk (the registry
   * writes a placeholder and hydrates lazily), so "in this list" is literally
   * "somebody does not have the content" — not a bookkeeping detail.
   */
  /**
   * Is a content run — per-doc OR batched — in flight right now?
   *
   * Every caller wants the same thing: "somebody already owns these docs, leave
   * them alone". Before the batch path existed, `uploader.isRunning()` answered
   * it on its own; now a run can be a `DocBatchPusher` instead, and a guard that
   * missed that would let a `ready` frame (or a local-change drain) start a
   * second writer on docs the first run is mid-push on.
   */
  private contentRunInFlight(): boolean {
    return (this.uploader?.isRunning() ?? false) || this.batchPushing;
  }

  private contentWorkList(): Array<{ docId: string; relPath: string }> {
    const open = this.docStore?.suppressedDoc() ?? null;
    return this.registry
      .mappedNotes()
      .filter(
        (n) =>
          n.docId !== open &&
          // Settled as "nothing anywhere", or failed for a reason a retry can't
          // fix — neither is work (see the field comments).
          !this.emptyEverywhere.has(n.docId) &&
          !this.permanentFailures.has(n.docId) &&
          (!this.registry.isPushed(n.docId) ||
            this.serverEmpty.has(n.docId) ||
            this.serverBehind.has(n.docId)),
      );
  }

  /**
   * The server just CREATED rows for these docs, so it holds no content for any
   * of them — the same statement `ready.empty` makes, arriving earlier.
   *
   * Registration is the only moment a client learns this about a brand-new note,
   * and it is what makes a LIVE import batch. `ready` is sent on a handshake and
   * nowhere else, so notes registered mid-session have no server statement until
   * the next connect: the batch pusher may not seed them (it seeds only what the
   * SERVER called empty, under `expectEmpty`), so each one falls back to its own
   * socket — which is precisely why dropping 500 files into a running vault was
   * minutes while the identical import after a relaunch was seconds.
   *
   * `status: "created"` is a stronger statement than `ready.empty`, not a weaker
   * one: the row did not exist a moment ago, so nothing can have pushed content
   * into it. An `adopted` row is deliberately NOT included — adoption is
   * by-path, and the incumbent it adopted may hold anything.
   *
   * This is the `InboundHost` hook the registry calls as it registers; a
   * registry that does not call it simply leaves the live import on the per-doc
   * path, which is the behaviour it had before.
   */
  noteServerCreated(docIds: readonly string[]): void {
    if (!this.syncable()) return;
    for (const docId of docIds) {
      // A doc already settled as "nothing anywhere", or one this device has
      // since confirmed, is not work — and must not be re-queued as if it were.
      if (this.emptyEverywhere.has(docId) || this.permanentFailures.has(docId)) continue;
      this.serverEmpty.add(docId);
    }
  }

  /**
   * A `ready` frame named the readable docs this device holds ops the server
   * lacks for. Arrives right before the same frame's `empty` list, whose
   * handler starts the run — so by then these are already in the work list.
   * Also recorded as diverged: "file == doc" is not "nothing to send" for them.
   */
  private handleServerBehind(docIds: string[], scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    if (docIds.length > 0) {
      this.note(
        "info",
        "server-behind",
        `${docIds.length} ${docIds.length === 1 ? "note has" : "notes have"} edits the server never received`,
      );
    }
    this.serverBehind = new Set(docIds);
    for (const docId of docIds) this.divergedDocs.add(docId);
  }

  /**
   * A `ready` frame told us which readable docs the server holds no content for.
   *
   * Every `ready` re-arms the run, which is what makes the uploader's failure
   * streak a PAUSE rather than a verdict: a server that was dead when the run
   * gave up will, when it comes back, send a `hello`→`ready` round that starts a
   * fresh one. Nothing else restarted it before — a five-failure streak stranded
   * every remaining note until sign-out.
   */
  private handleServerEmpty(docIds: string[], truncated: boolean, scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    this.clearChannelWatchdog(); // `ready` arrived — the channel is alive
    if (docIds.length > 0) {
      this.note(
        "info",
        "server-empty",
        `Server asked for the content of ${docIds.length} ${docIds.length === 1 ? "note" : "notes"}`,
      );
    }
    this.serverEmptyTruncated = truncated;
    // A live run keeps its queue and picks this set up on its next pass; only
    // the set is refreshed here. The refresh itself may need the disk (see
    // `settleServerEmpty`); when it does, the run start waits for it.
    const settled = this.settleServerEmpty(docIds, scope);
    if (settled instanceof Promise) {
      const probe = settled.then(() => {
        if (this.emptyProbe === probe) this.emptyProbe = null;
        if (!scope.isCurrent()) return;
        this.startContentRunIfNeeded(scope);
      });
      this.emptyProbe = probe;
      return;
    }
    this.serverEmpty = settled;
    this.startContentRunIfNeeded(scope);
  }

  /**
   * Turn `ready.empty` into the docs that actually need a push, settling the
   * ones this device has nothing for (see {@link emptyEverywhere}).
   *
   * Synchronous when nothing has to be read — a doc whose path is unknown here
   * stays in the list (the run can't manufacture work for it anyway, but this
   * layer must not decide that), and one already settled is skipped without a
   * read. Otherwise the remaining files are read with bounded concurrency and
   * the result lands in `serverEmpty` when the promise resolves. Every step is
   * scope-guarded: a vault switch mid-probe leaves the new vault's set alone.
   */
  private settleServerEmpty(docIds: string[], scope: VaultScope): Set<string> | Promise<void> {
    const keep = new Set<string>();
    const toProbe: Array<{ docId: string; relPath: string }> = [];
    for (const docId of docIds) {
      if (this.emptyEverywhere.has(docId) || this.permanentFailures.has(docId)) continue;
      const relPath = this.registry.pathForDocId(docId);
      if (!relPath) {
        keep.add(docId);
        continue;
      }
      toProbe.push({ docId, relPath });
    }
    if (toProbe.length === 0) return keep;
    return runPool(
      toProbe,
      async ({ docId, relPath }) => {
        let empty = false;
        try {
          empty = await this.fileIsEmpty(relPath, scope);
        } catch {
          empty = false; // unreadable ⇒ let the run try (and report) it
        }
        if (!scope.isCurrent()) return;
        // The FILE being empty is only half the question. `materializeContent`
        // fills a server-only placeholder from this device's local CRDT, and
        // when its `writeThrough` fails (disk full, permission, epoch switch)
        // the file stays 0 bytes while the doc still holds the note. Settling on
        // the file alone marked that doc pushed and badged it synced, so it was
        // never queued again and its text lived only in `index.sqlite` —
        // permanent divergence behind a green badge. "Nothing anywhere" has to
        // mean the doc too.
        if (empty && !(await this.docEmptyLocally(docId, scope))) empty = false;
        if (!scope.isCurrent()) return;
        if (!empty) {
          keep.add(docId);
          return;
        }
        // Nothing here, nothing there. Confirmed by definition — there is no
        // content whose arrival on the server could still be pending.
        this.emptyEverywhere.add(docId);
        this.registry.markPushed(docId);
        this.progress?.doc(docId, "synced");
      },
      { concurrency: IPC_CONCURRENCY, shouldStop: () => !scope.isCurrent() },
    ).then(() => {
      if (!scope.isCurrent()) return;
      this.serverEmpty = keep;
      this.progress?.flush();
    });
  }

  /**
   * Does this device hold NO text for a doc — resident bridge first, then the
   * local CRDT store?
   *
   * The companion probe to `registry.isNoteEmptyOnDisk`, and deliberately
   * conservative: anything unreadable answers false, which keeps the doc in the
   * push queue (a re-push costs a round trip; a wrong settle costs the text).
   */
  /**
   * Is this note's FILE empty — asking the cheapest question that can answer it?
   *
   * `ready.empty` names every readable doc the server holds no content for, on
   * EVERY connect and up to 2,000 at a time, and reading all of them in full to
   * learn "is it empty" was the single dumbest read in the sync layer: a vault
   * of 300 zero-byte `_Index.md` stubs paid 300 whole-file reads per reconnect.
   *
   * `file_stat` answers it without the bytes for the two cases that matter:
   * size 0 is empty, and anything over {@link EMPTY_PROBE_MAX_BYTES} has content
   * — a file that large cannot be whitespace-only in any real vault, and the
   * verdict it skips ("it only LOOKS non-empty") is the conservative one anyway:
   * it keeps the doc in the push queue, where a re-push costs a round trip while
   * a wrong settle costs the text. Only the small middle band is read, which is
   * where `.trim()` semantics actually have something to decide. A host (or a
   * test harness) without the stat command falls back to the full read.
   */
  private async fileIsEmpty(relPath: string, scope: VaultScope): Promise<boolean> {
    try {
      const stat = await ipc.fileStat(relPath, scope.vaultEpoch);
      if (stat.size === 0) return true;
      if (stat.size > EMPTY_PROBE_MAX_BYTES) return false;
    } catch {
      // No stat (older Rust core, a racing delete, a fake in a test): fall
      // through to the read, which answers the same question the slow way.
    }
    if (!scope.isCurrent()) return false;
    return this.registry.isNoteEmptyOnDisk(relPath);
  }

  private async docEmptyLocally(docId: string, scope: VaultScope): Promise<boolean> {
    const resident = this.docStore?.peekResident(docId);
    if (resident) return resident.serialize().length === 0;
    let state: Awaited<ReturnType<typeof ipc.loadYjsState>>;
    try {
      state = await ipc.loadYjsState(docId, scope.vaultEpoch);
    } catch {
      return false;
    }
    // The cheap answer for a doc this device never opened: no rows at all.
    if (!state.snapshot && state.updates.length === 0) return true;
    const doc = new Y.Doc();
    try {
      if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
      for (const u of state.updates) Y.applyUpdate(doc, u);
      return doc.getText("content").length === 0;
    } catch {
      return false;
    } finally {
      doc.destroy();
    }
  }

  /** Remember the run's permanent failures so later runs neither re-queue nor
   *  forget them (each run builds a fresh uploader with an empty failure list). */
  private recordPermanentFailures(uploader: ContentUploader): void {
    for (const f of uploader.failedDocs()) {
      if (this.invalidatedFailures.has(f.docId)) continue;
      if (f.permanent) this.permanentFailures.set(f.docId, f);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** May opening a note attach a network provider? True from the local prime
   *  onward — see {@link primed} for why this is narrower than `enabled`. */
  private syncable(): boolean {
    return this.enabled || this.primed;
  }

  /** Public twin of {@link syncable}, for the store's open gate. */
  isSyncable(): boolean {
    return this.syncable();
  }

  /** The vault scope this session is running under (null when disabled). */
  currentScope(): VaultScope | null {
    return this.scope;
  }

  /** True if opening `relPath` will connect a network provider. */
  willSync(relPath: string): boolean {
    return this.syncable() && this.registry.getMapping(relPath) != null;
  }

  /**
   * Enable networked sync for a vault: reconcile the registry so doc_ids are
   * shared across devices, and remember the presence identity. Requires an
   * active organization; a no-op (disabled) otherwise.
   *
   * Everything this starts belongs to ONE {@link VaultScope}. `begin` retires the
   * previous scope first, so any operation still in flight for the vault we're
   * leaving sees `isCurrent() === false` at its next checkpoint and drops. The
   * returned `scope` lets the caller check whether its own post-await state
   * updates are still about the vault it asked for.
   */
  async enable(
    session: SessionInfo,
    vault: VaultTarget,
    hooks?: {
      /**
       * The LOCAL prime landed: this folder's doc-id map is adopted, so a
       * mapped note can now be opened safely. Fires before the reconcile (the
       * networked half) has started, and at most once per call — it is what
       * lets the launch consider the vault usable without waiting minutes.
       */
      onPrimed?: () => void;
    },
  ): Promise<{ ok: boolean; reason?: string; seeded?: boolean; scope?: VaultScope }> {
    if (!session.activeOrganizationId) {
      this.disable();
      return { ok: false, reason: "no active organization" };
    }
    // A live session is in hand again (a sign-in, a server switch, a vault
    // switch), so re-arm the 401 guard. It latches shut on a confirmed
    // sign-out — that latch is what stops a torn-down vault's last few mints
    // from re-running the sign-out — and this is the only thing that opens it.
    this.sessionGuard.reset();
    // Retire whatever was running for the previous vault BEFORE any await, so no
    // old-vault work can interleave with this reconcile.
    this.teardown();
    const scope = vaultScopes.begin({
      orgId: vault.orgId,
      vaultPath: vault.path,
      vaultEpoch: vault.epoch,
    });
    this.scope = scope;
    this.presence = { id: session.user.id, name: session.user.name || session.user.email };
    // The progress mirror is created BEFORE the reconcile so the `registering`
    // phase is visible from its first item — that phase alone is minutes of work
    // on a large vault, and it used to report nothing at all.
    let cleanupActive = false;
    const progress = new SyncProgressReporter({
      onProgress: (p) => {
        if (cleanupActive) return;
        this.logRunPhase(p);
        this.onSyncProgress?.(p);
      },
      onDocState: (patch) => this.onDocState?.(patch),
    });
    this.progress = progress;
    // The registry writes into the SHARED reporter, but its COUNTERS are muted
    // while a content run or the download phase owns the pill: a pull that lands
    // mid-run re-stamps `registering` with its own (tiny) total while the
    // uploader keeps ticking `done` against it — which once rendered the header
    // as "Syncing 585/164". Per-doc badge states stay through in all cases:
    // they are keyed by docId, so concurrent writers cannot garble them.
    const cleanup = new SyncProgressReporter({
      onProgress: (p) => {
        if (!cleanupActive) return;
        this.logRunPhase(p);
        this.onSyncProgress?.(p);
      },
      onDocState: () => {},
    });
    this.cleanupProgress = cleanup;
    const counterOwned = (): boolean => this.bulkPhase || this.contentRunInFlight() || this.downloadPhase;
    this.registry.setProgressSink({
      phase: (p, t) => {
        if (p === "removing") {
          cleanupActive = true;
          cleanup.phase(p, t);
          return;
        }
        if (cleanupActive) {
          cleanup.flush();
          cleanupActive = false;
          this.onSyncProgress?.(progress.snapshot());
        }
        if (!counterOwned()) progress.phase(p, t);
      },
      addTotal: (n) => {
        if (cleanupActive) cleanup.addTotal(n);
        else if (!counterOwned()) progress.addTotal(n);
      },
      item: (o) => {
        if (cleanupActive) cleanup.item(o);
        else if (!counterOwned()) progress.item(o);
      },
      doc: (docId, state) => progress.doc(docId, state),
      flush: () => {
        if (cleanupActive) cleanup.flush();
        progress.flush();
      },
    });
    // ---- PHASE A: local only. One config read; no socket, no HTTP. ----
    //
    // From here `willSync()` is true for every note this folder already maps, so
    // a note clicked during the reconcile connects a provider and PULLS before
    // it seeds (spec 03 §5) instead of taking the local-only branch and forking
    // the doc. Best-effort: a folder with no (or a foreign) stamp doesn't prime,
    // and a broken config must not fail the enable.
    try {
      if (await this.registry.primeLocal(vault.orgId)) {
        if (!scope.isCurrent()) return { ok: false, reason: "vault changed", scope };
        this.primed = true;
        // Sidebar badges + `store.docIdByPath`, immediately.
        this.publishRegistryMap();
        hooks?.onPrimed?.();
        // OPEN THE CHANNEL NOW, alongside the reconcile below rather than after
        // it. The collection id is the only thing the socket needs and the prime
        // just read it out of `.context/config.json`, so waiting costs the user
        // the reconcile's whole serial HTTP chain (listVaults, then folders and
        // notes) before the connection even starts — seconds, on every launch and
        // every vault switch.
        //
        // Safe because the two flags that gate anything destructive are still
        // false: `enabled` (which `startContentRunIfNeeded` requires, so nothing
        // uploads) and `pulledOnce` (so `markLive` cannot arm, and the revocation
        // and disk-delete paths stay inert). All the early socket can do is
        // backfill content for docs the prime already mapped — which is exactly
        // the work we want overlapped.
        this.startVaultEngine(scope);
      }
    } catch (e) {
      console.warn("[sync] local prime failed; falling back to reconcile-first", e);
    }
    // ---- PHASE B: the networked reconcile. Unchanged. ----
    try {
      // The registry reads the vault tree itself (the FULL recursive walk); it
      // deliberately does not take one from here, because the tree this layer
      // has access to is the sidebar's lazy one. See `reconcile`.
      const { seeded } = await this.registry.reconcile({
        organizationId: session.activeOrganizationId,
        vaultName: vault.name,
        seedIfEmpty: vault.seedIfEmpty,
      });
      // The user may have switched vaults during the reconcile. Bringing sync up
      // now would start the engine for the OLD vault id while the NEW vault's
      // folder is open — exactly the state that merged two vaults.
      if (!scope.isCurrent()) return { ok: false, reason: "vault changed", scope };
      this.enabled = true;
      // One flag owns the state from here; `syncable()` stays true throughout
      // the handover, so nothing the user opened in the window loses its sync.
      this.primed = false;
      // The reconcile IS this session's first structure pull: every file the
      // server knows about has been accounted for, so from here a vanished file
      // is news (see `markLive` for the other half of the condition).
      this.pulledOnce = true;
      this.markLive();
      // The primed channel may name revocations before reconcile completes.
      // Their pull requests are ignored while disabled, and the first pass
      // deliberately lacks removal authority. Retry once that gate opens.
      if (this.revocationAuthority()) this.handleRegistryChanged("acl-revoked");
      // Sweep unreachable CRDT rows HERE and nowhere else: the registry map is
      // complete as of the line above, and the download phase below has not yet
      // begun to create docs. Fire-and-forget — a vault that cannot be tidied
      // must still open. See `crdtGc.ts` for why the allow-list is built from
      // two id spaces.
      void collectCrdtGarbage(
        { registryDocIds: () => this.registry.allDocIds() },
        { epoch: scope.vaultEpoch ?? undefined, pinned: this.currentDocId ? [this.currentDocId] : [] },
      );
      this.setupAttachments(scope);
      // Initial attachment reconcile (fire-and-forget; errors are logged rather
      // than left to surface as an unhandled rejection).
      void this.attachments
        ?.reconcile()
        .catch((e) => console.warn("[attachments] initial reconcile failed", e));
      this.startVaultEngine(scope);
      // DOWNLOAD FIRST, then push what is left. This order is the whole point of
      // the change: the vault channel backfills every readable doc over ONE
      // socket, and a doc it delivers needs no upload at all (see the
      // `onConverged` wiring in `startVaultEngine`). Running the content pass
      // first meant every note was delivered twice — once over the vault channel
      // and once over a dedicated per-note provider at 3.7 notes/second.
      //
      // The content run is now started by whichever of these lands first: the
      // download phase settling (`handleInboundIdle`), or a `ready` frame that
      // names docs the server has no content for (`handleServerEmpty`). Both run
      // in the BACKGROUND — `enable` must return as soon as the vault is usable,
      // or "Turn on sync" would block the UI for the whole backfill.
      this.beginDownloadPhase(scope);
      // …and, on a vault big enough for it, the BULK engine owns that phase:
      // the bootstrap download, then the batched push, then a normal reconnect.
      // Background, like the content run it replaces — `enable` must return as
      // soon as the vault is usable or "Turn on sync" blocks the UI for the
      // whole backfill.
      if (useBulkPath(this.registry.mappedNotes().length)) {
        this.bulkRun = this.runBulkEngine(scope).catch((e) => {
          console.warn("[sync] bulk sync failed", e);
        });
      } else if (this.vaultEngineLiveOnly) {
        // The prime window sized the channel from the LOCAL doc map and put it
        // in live-only mode; the reconcile then found a vault below the
        // threshold. Nothing is going to page it down over HTTP, so give the
        // channel its backfill back — otherwise the content would arrive from
        // nowhere at all.
        this.restoreChannelBackfill();
      }
      return { ok: true, seeded, scope };
    } catch (e) {
      if (scope.isCurrent()) this.disable();
      return { ok: false, reason: e instanceof Error ? e.message : String(e), scope };
    }
  }

  /** Resolves when the current bulk sync run settles (tests / shutdown). */
  async whenBulkSyncSettled(): Promise<void> {
    // The disk probe behind a `ready` runs before the run it may start.
    while (this.emptyProbe) await this.emptyProbe;
    await (this.bulkRun ?? Promise.resolve());
  }

  /**
   * Repair a note the server has permanently refused for being over its size cap.
   *
   * Nothing else can unstick such a note. It is rejected before a single update
   * is applied, so it cannot be edited down; and its bulk is edit HISTORY, not
   * text, so compaction cannot shrink it either. The only exit is to discard the
   * history on both sides and start the doc again from the text.
   *
   * DESTRUCTIVE, and deliberately explicit: the note's text survives (the file on
   * disk is the durable source of truth and is what re-seeds the doc), its
   * history does not. Never call this automatically — a doc over the cap with a
   * legitimately large file needs a smaller note, not a silently emptied one.
   *
   * ── Order is the whole correctness argument ─────────────────────────────────
   *   1. SERVER first. While the server still holds the old state, any client —
   *      including this one — can re-upload it.
   *   2. LOCAL second. A surviving local CRDT merges the old state back on the
   *      next connect, which is the fork this is undoing.
   *   3. Re-seed from the file, then re-queue. The bridge rebuilds a fresh doc
   *      with a new clientID and no shared history with the discarded one.
   *
   * Reversing 1 and 2 leaves a window where the local copy is gone but the
   * server's is not, and the next pull restores the megabytes.
   */
  async resetNoteHistory(docId: string): Promise<{ bytesFreed: number }> {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) {
      throw new Error("sync is not enabled for this vault");
    }
    const relPath = this.registry.pathForDocId(docId);
    if (!relPath) throw new Error(`no note is mapped to ${docId}`);

    // The file is the truth we re-seed from. An unreadable file is not a reason
    // to reset to empty — bail instead, so a transient read error cannot be the
    // thing that blanks a note.
    const content = await ipc.readNote(relPath, scope.vaultEpoch ?? undefined);
    if (!scope.isCurrent()) throw new Error("vault changed");

    const { bytesBefore, bytesAfter } = await api.resetNoteHistory(docId, content);
    if (!scope.isCurrent()) throw new Error("vault changed");
    await ipc.clearYjsDoc(docId, scope.vaultEpoch ?? undefined);

    // It is no longer permanently failed, and the server no longer has its
    // content — so it must be re-queued rather than left believed-pushed.
    this.permanentFailures.delete(docId);
    this.registry.unmarkPushed(docId);
    this.divergedDocs.add(docId);
    this.note(
      "info",
      "reset-history",
      `Cleared the saved edit history for ${relPath} and re-sent it from the file`,
      { docId, path: relPath },
    );
    console.info(
      `[sync] reset history for ${relPath}: ` +
        `${(bytesBefore / (1024 * 1024)).toFixed(1)} MB → ` +
        `${(bytesAfter / 1024).toFixed(1)} KB`,
    );
    return { bytesFreed: Math.max(0, bytesBefore - bytesAfter) };
  }

  /**
   * Re-queue ONE note's content, from the Health page's per-row Retry.
   *
   * The three pieces of state that would otherwise make the retry a no-op, in
   * the order they'd bite:
   *
   *   1. `permanentFailures` — a doc in here is deliberately skipped by every
   *      later `ready`, so it must be forgotten before anything else runs.
   *      (A doc that is STILL over the cap simply fails again, permanently, and
   *      lands back in the map — which is the honest outcome, not a loop: the
   *      re-fail costs one encode and opens no socket.)
   *   2. `registry.isPushed` — the durable "the server has this note's content"
   *      checkpoint. A believed-pushed doc is not in any work list, so the retry
   *      has to withdraw the claim rather than trust it.
   *   3. `divergedDocs` — forces a real connect (`mustConnect`) instead of the
   *      echo-guarded fast path, because we cannot know whether the local ops
   *      ever reached the server.
   *
   * It then joins the SAME queue an external writer's file change uses
   * (`localChanges` + the debounced drain), which runs the uploader with `force`
   * and `ingestFromFile` — exactly the pass this note needs. Deliberately not a
   * whole `retrySync()`: one row's Retry must not re-pull the registry and
   * re-walk a 5,000-note vault.
   *
   * Scope-guarded like everything else here: a vault switch between the click
   * and the drain drops the work silently rather than pushing into the new vault.
   */
  async retryDoc(docId: string): Promise<void> {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    const relPath = this.registry.pathForDocId(docId);
    if (!relPath) return;
    this.note("info", "retry", "Retrying this note", { docId, path: relPath });
    this.permanentFailures.delete(docId);
    this.bulkFailures.delete(docId);
    this.invalidatedFailures.add(docId);
    this.registry.unmarkPushed(docId);
    this.divergedDocs.add(docId);
    // A `ready.empty` verdict for this doc would otherwise short-circuit the
    // push before it opens a socket; the user just told us to try again.
    this.emptyEverywhere.delete(docId);
    this.localChanges.set(docId, relPath);
    this.armLocalChangeDrain(scope, LOCAL_CHANGE_DEBOUNCE_MS);
  }

  /**
   * User-triggered "sync now": re-pull the registry and re-run the content pass,
   * so notes stranded by a transient failure get another chance without a
   * sign-out/relaunch. Backs the sync pill's retry button.
   *
   * No-op while a run is already in flight — that run will pick everything up.
   */
  async retrySync(): Promise<void> {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    if (this.contentRunInFlight()) return;
    this.note("info", "retry", "Sync now requested");
    // Permission refusals are terminal only for the access/state observed by
    // that attempt. A manual check safely re-evaluates them: withdraw the local
    // confirmation so the normal pull-first path compares again. Oversized
    // notes remain terminal because another identical encode cannot help them.
    for (const [docId, failure] of [...this.permanentFailures]) {
      if (failure.kind !== "no-write-access") continue;
      this.permanentFailures.delete(docId);
      this.bulkFailures.delete(docId);
      this.invalidatedFailures.add(docId);
      this.registry.unmarkPushed(docId);
      this.divergedDocs.add(docId);
    }
    // The old uploader's failure list belongs to the run being retried; keeping
    // it would let `completeRun` re-report failures the retry just fixed.
    this.uploader = null;
    // Show life immediately — the pull below can take a moment on a big vault.
    this.progress?.phase("registering", 0);
    this.progress?.flush();
    let changed = false;
    try {
      changed = await this.registry.pull();
    } catch (e) {
      console.warn("[sync] manual retry pull failed", e);
    }
    if (!scope.isCurrent()) return;
    if (changed) this.onRegistryChanged?.();
    this.settleAfterPull(scope);
  }

  /**
   * The BULK content engine: download the vault over the bootstrap route, then
   * push what the server is missing in batched requests — the replacement for
   * "one WS frame + three IPC calls per doc down, one token mint + one WebSocket
   * per doc up" (measured at 3.7 notes/second, i.e. ~22 minutes for 5,000 notes
   * before the second thousand had moved).
   *
   * Ordered, and the order is the safety argument:
   *
   *   1. BOOTSTRAP first. A doc the server already has is downloaded, not
   *      uploaded — and a doc whose local file diverges comes back `conflict`,
   *      having written nothing, so step 2 never seeds over it.
   *   2. BATCH PUSH for what the server itself named empty or behind, plus
   *      anything this device has not confirmed.
   *   3. PER-DOC `DocSync` for exactly what cannot be batched: the conflicts and
   *      anything over `BULK_ITEM_MAX_BYTES`. Those need a real pull-then-merge,
   *      which is a socket, which is `ContentUploader`.
   *   4. RECONNECT the channel normally. The manifest now covers everything the
   *      bootstrap wrote, so the backfill this asks for is ~0 frames wide, and
   *      its `ready` restates `empty`/`behind`/`revoked` for the ordinary run.
   *
   * Runs in the BACKGROUND (`enable` returns as soon as the vault is usable) and
   * holds {@link bulkPhase} throughout, which is what keeps the per-doc run from
   * starting underneath it.
   */
  private async runBulkEngine(scope: VaultScope): Promise<void> {
    const vaultId = this.registry.vaultId;
    const store = this.docStore;
    const progress = this.progress;
    if (!vaultId || !store || !progress) return;
    this.bulkPhase = true;
    try {
      const bootstrap = await this.runBootstrapPhase(scope, vaultId, store);
      if (!scope.isCurrent()) return;
      const conflicts = new Set(bootstrap?.conflicts ?? []);
      // The server's own statement of what it holds nothing for: the bootstrap
      // session's `emptyDocs` plus whatever the channel's `ready.empty` has
      // named by now. Both are the SERVER talking; `registry.isPushed` is only
      // this device's optimisation and joins the work list separately.
      const serverEmpty = new Set([...(bootstrap?.emptyDocs ?? []), ...this.serverEmpty]);
      // Bootstrap can finish before ready.empty's disk probe, or name empty
      // docs beyond that frame's cap. A server-empty note is not upload work
      // when its file AND local CRDT are empty too. Settle both sources before
      // building the batch, just as the ordinary channel path does.
      while (this.emptyProbe) {
        await this.emptyProbe;
        if (!scope.isCurrent()) return;
      }
      await this.settleServerEmpty([...serverEmpty], scope);
      if (!scope.isCurrent()) return;
      const push = await this.runBatchPushPhase(scope, vaultId, store, serverEmpty, conflicts);
      if (!scope.isCurrent()) return;
      for (const docId of push?.conflicts ?? []) conflicts.add(docId);
      const followUp = [
        ...conflicts,
        ...(push?.oversized ?? []).map((o) => o.docId),
        ...(push?.deferred ?? []).map((o) => o.docId),
      ];
      await this.runBulkFollowUp(scope, vaultId, store, followUp);
    } catch (e) {
      if (isServerTooOld(e)) this.reportServerTooOld(scope);
      else console.warn("[sync] bulk content engine failed", e);
    } finally {
      this.bulkPhase = false;
      this.bootstrapRunner = null;
      this.batchPusher = null;
    }
    if (!scope.isCurrent()) return;
    // Durably record everything the phase confirmed BEFORE anything claims the
    // vault is settled: this is the resume point a kill -9 falls back to.
    await this.registry.flushCheckpoint();
    if (!scope.isCurrent()) return;
    // Back to an ordinary channel (see step 4 above). A no-op when the engine
    // was never put in live-only mode — below the threshold nothing here ran.
    this.restoreChannelBackfill();
    this.startContentRunIfNeeded(scope);
  }

  /** Step 1: page the vault down. `null` when it was cancelled or never ran. */
  private async runBootstrapPhase(
    scope: VaultScope,
    vaultId: string,
    store: VaultDocStore,
  ): Promise<Awaited<ReturnType<BootstrapRunner["run"]>> | null> {
    const runner: BootstrapRunner = new BootstrapRunner({
      serverVaultId: vaultId,
      progress: this.progress ?? undefined,
      shouldStop: () => !scope.isCurrent() || this.bootstrapRunner !== runner,
      onFailure: (f) => this.recordBulkFailure(f),
      deps: {
        createSession: (have) => api.createBootstrapSession(vaultId, have),
        fetchPage: (sessionId, cursor) =>
          api.fetchBootstrapPage(vaultId, sessionId, { cursor }),
        // ONE IPC (and one SQLite transaction) per page. Rust decides each doc's
        // fate from the FILE and the local CRDT tables, never from this list.
        applyBatch: (entries) => ipc.applyBootstrapBatch(entries, scope.vaultEpoch),
        // A doc that already has local CRDT: merge it the normal cold way, which
        // is what makes re-running a page free.
        coldApply: (docId, update) => store.applyUpdate(docId, update),
        haveDocs: async () => {
          // The DURABLE manifest, not an in-memory guess — the same list the
          // channel's `hello` announces. Everything in it is state the server
          // can skip sending.
          await store.whenReady();
          return store.knownDocs();
        },
        markPushed: (docId) => {
          this.registry.markPushed(docId);
          this.serverEmpty.delete(docId);
          this.serverBehind.delete(docId);
        },
        markMaterialized: (relPath) => this.registry.markMaterialized(relPath),
        loadResume: () => this.registry.bootstrapResume(),
        saveResume: (state) => this.registry.setBootstrapResume(state),
        flushCheckpoint: () => this.registry.flushCheckpoint(),
      },
    });
    this.bootstrapRunner = runner;
    const result = await runner.run();
    if (!scope.isCurrent() || this.bootstrapRunner !== runner) return null;
    if (result.applied > 0 || result.merged > 0) {
      this.note(
        "info",
        "bootstrap",
        `Downloaded ${result.applied + result.merged} ${
          result.applied + result.merged === 1 ? "note" : "notes"
        } from the server`,
      );
    }
    return result;
  }

  /** Step 2: push, batched. `null` when there was nothing to send. */
  private async runBatchPushPhase(
    scope: VaultScope,
    vaultId: string,
    store: VaultDocStore,
    serverEmpty: Set<string>,
    conflicts: Set<string>,
  ): Promise<Awaited<ReturnType<DocBatchPusher["run"]>> | null> {
    const open = store.suppressedDoc();
    const work: DocPushWork[] = this.registry
      .mappedNotes()
      .filter(
        (n) =>
          n.docId !== open &&
          // Settled as "nothing anywhere", permanently refused, or already
          // owned by the per-doc follow-up — none of them are work here.
          !this.emptyEverywhere.has(n.docId) &&
          !this.permanentFailures.has(n.docId) &&
          !conflicts.has(n.docId) &&
          (serverEmpty.has(n.docId) ||
            this.serverBehind.has(n.docId) ||
            !this.registry.isPushed(n.docId)),
      )
      .map((n) => ({
        docId: n.docId,
        relPath: n.relPath,
        // The SERVER's word, never a guess: it is what licenses a seed from the
        // file without a pull, and what `expectEmpty` makes the server re-check.
        serverEmpty: serverEmpty.has(n.docId),
      }));
    return this.runDocBatchPush(scope, vaultId, store, work);
  }

  /**
   * ONE batched content push, whoever asked for it.
   *
   * Extracted so the three sites that push content in bulk — `enable`'s bulk
   * engine, the steady-state content run and the local-change drain — cannot
   * drift apart in the things that make a batch push safe: the pusher seeds only
   * what the SERVER called empty (and flags it `expectEmpty`), never touches the
   * open note, releases every bridge it opens, and discards a seed the server
   * refused before anything else can merge it. Everything that differs between
   * the sites lives in the WORK LIST the caller builds, which is the only part
   * worth reading twice.
   *
   * `null` means "this run is void" — the vault changed, or another pusher took
   * the slot — never "nothing happened".
   */
  private async runDocBatchPush(
    scope: VaultScope,
    vaultId: string,
    store: VaultDocStore,
    work: DocPushWork[],
  ): Promise<DocBatchPushResult | null> {
    if (work.length === 0) return null;
    const progress = this.progress;
    progress?.phase("uploading", work.length);
    const pusher: DocBatchPusher = new DocBatchPusher({
      work,
      progress: progress ?? undefined,
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.divergedDocs.delete(docId); // a confirmed push carries any merged ops
        this.serverEmpty.delete(docId);
        this.serverBehind.delete(docId);
      },
      // Never touch the open note: its editor session owns that doc's provider.
      skip: (docId) => store.suppressedDoc() === docId,
      onFailure: (f) => this.recordBulkFailure(f),
      shouldStop: () => !scope.isCurrent() || this.batchPusher !== pusher,
      deps: {
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, {
            seedFromFile: false, // the pusher seeds, and only what the server called empty
            markRecent: false, // a 5,000-note run must not evict the real recency list
            pin: true,
          }),
        release: (docId) => store.demote(docId),
        push: (items) => api.batchPushDocs(vaultId, items),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
        // The `conflict` undo: throw away the seed this run just made (and the
        // cached state vector that describes it) so the follow-up's pull lands
        // in an EMPTY doc and nothing can double. See `docBatchPush.ts`.
        discardLocalCrdt: async (docId) => {
          store.drop(docId);
          await ipc.clearYjsDoc(docId, scope.vaultEpoch);
        },
      },
    });
    this.batchPusher = pusher;
    // The in-flight marker every "is a content run happening?" guard reads (see
    // {@link contentRunInFlight}). Without it a `ready` frame landing mid-batch
    // starts a SECOND run over the same docs — two pushers promoting one doc.
    this.batchPushing = true;
    let result: DocBatchPushResult;
    try {
      result = await pusher.run();
    } finally {
      this.batchPushing = false;
    }
    if (!scope.isCurrent() || this.batchPusher !== pusher) return null;
    await this.registry.flushCheckpoint();
    return result;
  }

  /**
   * The docs a batch push could not settle, as notes the per-doc path can take.
   *
   * Three buckets, one destination: a `conflict` (the server was not empty after
   * all), an item over `BULK_ITEM_MAX_BYTES`, and a doc whose local CRDT is
   * empty with no server statement to license a seed. All three need the same
   * thing — connect, PULL FIRST, then seed/merge — which is `ContentUploader`.
   */
  private batchLeftovers(
    result: DocBatchPushResult,
    known: ReadonlyArray<{ docId: string; relPath: string }> = [],
  ): Array<{ docId: string; relPath: string }> {
    const byDocId = new Map(known.map((n) => [n.docId, n.relPath]));
    const out: Array<{ docId: string; relPath: string }> = [];
    const seen = new Set<string>();
    const add = (docId: string, relPath: string | null | undefined): void => {
      if (seen.has(docId)) return;
      const path = relPath ?? this.registry.pathForDocId(docId);
      if (!path) return; // unmapped now — nothing to push it under
      seen.add(docId);
      out.push({ docId, relPath: path });
    };
    for (const docId of result.conflicts) add(docId, byDocId.get(docId));
    for (const item of result.oversized) add(item.docId, item.relPath);
    for (const item of result.deferred) add(item.docId, item.relPath);
    return out;
  }

  /**
   * Step 3: the per-doc `DocSync` path, for the docs that genuinely need one.
   *
   * `force` + `ingestFromFile` + an `include` that matches everything is the
   * real merge: connect, PULL FIRST, find the doc non-empty so
   * `seedFromFileIfEmpty` inserts nothing, then fold the file's bytes back in as
   * a DIFF. That is why a conflict can neither double the text (no second insert
   * history) nor lose it (the file rejoins through the diff).
   */
  private async runBulkFollowUp(
    scope: VaultScope,
    vaultId: string,
    store: VaultDocStore,
    docIds: string[],
  ): Promise<void> {
    const progress = this.progress;
    if (!progress || docIds.length === 0) return;
    const notes = docIds
      .map((docId) => ({ docId, relPath: this.registry.pathForDocId(docId) }))
      .filter((n): n is { docId: string; relPath: string } => n.relPath != null);
    if (notes.length === 0) return;
    const uploader: ContentUploader = new ContentUploader({
      vaultId,
      notes,
      deps: {
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, { seedFromFile: false, markRecent: false, pin: true }),
        release: (docId) => store.demote(docId),
        connect: ({ docId, vaultId: collectionId, doc }) =>
          new DocSync({
            api,
            doc,
            docId,
            vaultId: collectionId,
            onSessionRejected: () => this.noteSessionRejected(),
          }),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
        writeTrashCopy: (relPath, stamp, content) =>
          ipc.writeTrashCopy(relPath, stamp, content, scope.vaultEpoch),
      },
      isPushed: (docId) => this.registry.isPushed(docId),
      // Everything here is work by construction — the batch already decided it
      // cannot settle these — so nothing may be skipped as "already confirmed",
      // and `include` also forces a real connect rather than the ingest
      // fast-path (which would see file == doc and send nothing).
      force: true,
      include: () => true,
      ingestFromFile: true,
      isUnhydratedPlaceholder: (docId, _relPath, fileText) =>
        fileText.length === 0 &&
        (this.unhydratedPlaceholders.has(docId) ||
          this.registry.isUnhydratedPlaceholder?.(docId)),
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
        this.divergedDocs.delete(docId);
        this.serverEmpty.delete(docId);
        this.serverBehind.delete(docId);
      },
      skip: (docId) => store.suppressedDoc() === docId,
      progress,
      onFailure: (f) => this.logUploadFailure(f),
      shouldStop: (): boolean => !scope.isCurrent() || this.uploader !== uploader,
    });
    this.uploader = uploader;
    await uploader.run();
    if (!scope.isCurrent() || this.uploader !== uploader) return;
    this.recordPermanentFailures(uploader);
    await this.registry.flushCheckpoint();
  }

  /** One note the bulk engine could not get through. */
  private recordBulkFailure(f: UploadFailure): void {
    this.invalidatedFailures.delete(f.docId);
    this.bulkFailures.set(f.docId, f);
    if (f.permanent) this.permanentFailures.set(f.docId, f);
    this.logUploadFailure(f);
  }

  /**
   * The server answered 404 on a bulk route: it predates this engine.
   *
   * Terminal and loud. There is deliberately no silent per-note fallback (design
   * §3.7): the structure reconcile and the vault channel have already run, so
   * the vault is populated and never empty — it is the CONTENT phase that stops,
   * and it says why.
   */
  private reportServerTooOld(scope: VaultScope): void {
    if (!scope.isCurrent() || this.serverTooOld) return;
    this.serverTooOld = true;
    this.note(
      "error",
      "server-too-old",
      "Update your Baalda server — this app needs its bulk sync routes",
    );
    this.progress?.phase("error");
    this.progress?.flush();
  }

  /**
   * Push the CONTENT of every note the server does not already have, then report
   * a terminal phase.
   *
   * This is the half of "turn on sync" that did not exist: reconcile created a
   * `notes` row (and an EMPTY server Y.Doc) per file, and a note's markdown only
   * ever reached the server when a human opened that note. See `contentUpload.ts`
   * for why re-running it cannot duplicate content.
   *
   * It runs AFTER the vault channel's backfill now (`startContentRunIfNeeded`),
   * so its queue is the remainder rather than the whole vault: every doc the
   * channel delivered is already marked pushed, and every doc the server has no
   * content for is named in `serverEmpty` and pushed first.
   */
  private async runBulkSync(scope: VaultScope): Promise<void> {
    const vaultId = this.registry.vaultId;
    const store = this.docStore;
    const progress = this.progress;
    if (!vaultId || !store || !progress) return;

    // ── The batch path, for the same reason `enable` takes it ────────────────
    //
    // This run is what a LIVE import lands in: 500 files dropped into a vault
    // that is already open and already synced register in one batched request
    // each 200 — and then used to send their CONTENT one socket at a time, at
    // 3.7 notes/second, because the threshold was only ever consulted inside
    // `enable`. Quitting and relaunching the app made the identical import take
    // seconds, which is the whole bug in one sentence (#audit §1).
    //
    // Everything that makes the batch safe is unchanged and lives in the work
    // list: a doc is seeded from its file ONLY where the SERVER said it holds
    // nothing (`expectEmpty`, re-checked under the server's per-doc lock), and
    // the three buckets the batch cannot settle — conflict, oversized, and a
    // doc with no local state and no server statement — go to the per-doc
    // pull-then-merge path below, exactly as the bulk engine's follow-up does.
    const batchWork = this.contentWorkList();
    if (!this.serverTooOld && useBulkPath(batchWork.length)) {
      // Everything already confirmed reads as synced straight away, the way the
      // uploader's own first pass does it — the batch pusher only speaks about
      // the docs in its work list.
      this.badgeConfirmedDocs();
      const result = await this.runDocBatchPush(
        scope,
        vaultId,
        store,
        batchWork.map((n) => ({
          docId: n.docId,
          relPath: n.relPath,
          // The SERVER's word, never a guess.
          serverEmpty: this.serverEmpty.has(n.docId),
        })),
      );
      if (result == null || !scope.isCurrent()) return;
      // A 404 on the batch route is a verdict about the SERVER, not about any
      // note: it predates this engine. Terminal and loud, with no silent
      // per-note fallback (design §3.7) — the same answer `runBulkEngine` gives.
      if (isServerTooOld(result.transportError)) {
        this.reportServerTooOld(scope);
        return;
      }
      if (result.cancelled) return;
      const leftovers = this.batchLeftovers(result, batchWork);
      if (leftovers.length > 0) {
        await this.runBulkFollowUp(scope, vaultId, store, leftovers.map((n) => n.docId));
        if (!scope.isCurrent()) return;
      }
      this.completeRun(scope);
      // Same rule as the per-doc run below: ask for the next slice of a
      // truncated `ready.empty` only after a pass that made progress.
      if (this.serverEmptyTruncated && result.pushed > 0) {
        this.serverEmptyTruncated = false;
        this.vaultEngine?.refresh();
      }
      return;
    }

    const uploader: ContentUploader = new ContentUploader({
      vaultId,
      notes: this.registry.mappedNotes(),
      deps: {
        // Hold the doc in the hot tier (pinned) for the duration of its push, so
        // there is exactly ONE bridge for it even while the background feed is
        // delivering updates for the same doc.
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, {
            seedFromFile: false, // pull-before-seed; the uploader seeds an orphan
            markRecent: false, // a 500-note run must not evict the real recency list
            pin: true,
          }),
        release: (docId) => store.demote(docId),
        connect: ({ docId, vaultId: collectionId, doc }) =>
          new DocSync({
            api,
            doc,
            docId,
            vaultId: collectionId,
            // A run connects one provider per note, so a lapsed session refuses
            // a mint for every doc in the vault in seconds. The guard coalesces
            // that burst into ONE session check.
            onSessionRejected: () => this.noteSessionRejected(),
          }),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
        writeTrashCopy: (relPath, stamp, content) =>
          ipc.writeTrashCopy(relPath, stamp, content, scope.vaultEpoch),
      },
      isPushed: (docId) => this.registry.isPushed(docId),
      // The server's word beats our checkpoint: a doc it holds no content for is
      // queued even when `pushed` claims it, which is the only way a note
      // stranded by a crashed run (or a restored `.context/`) is ever recovered.
      // …or one it holds an incomplete copy of (`ready.behind`): the missing
      // ops are on this device and nowhere else.
      include: (docId) => this.serverEmpty.has(docId) || this.serverBehind.has(docId),
      // …and it goes FIRST. Those notes have nothing at all on the server, so if
      // the run is cut short they are the work that had to happen.
      priority: (docId) => this.serverEmpty.has(docId),
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.unhydratedPlaceholders.delete(docId);
        this.registry.clearUnhydratedPlaceholder?.(docId);
        this.divergedDocs.delete(docId); // a confirmed push carries any merged ops
        this.serverEmpty.delete(docId); // the server has its content now
        this.serverBehind.delete(docId); // …all of it
      },
      // Never touch the open note: its editor session owns a provider for that doc.
      skip: (docId) => store.suppressedDoc() === docId,
      isUnhydratedPlaceholder: (docId, _relPath, fileText) =>
        fileText.length === 0 &&
        (this.unhydratedPlaceholders.has(docId) ||
          this.registry.isUnhydratedPlaceholder?.(docId)),
      progress,
      onFailure: (f) => this.logUploadFailure(f),
      shouldStop: (): boolean => !scope.isCurrent() || this.uploader !== uploader,
    });
    this.uploader = uploader;

    const result = await uploader.run();
    if (!scope.isCurrent() || this.uploader !== uploader) return;
    this.recordPermanentFailures(uploader);
    // Durably record what we pushed before claiming anything: this is the resume
    // point a kill -9 falls back to.
    await this.registry.flushCheckpoint();
    if (!scope.isCurrent() || this.uploader !== uploader) return;
    if (result.cancelled) return;
    this.completeRun(scope);
    // The server had more empty docs than one `ready` frame names. Ask again —
    // but only after a run that actually SENT something: a server that keeps
    // naming docs we cannot push would otherwise spin the socket in a tight
    // hello/ready loop. Progress, not perfection, is the bar: requiring zero
    // failures let ONE doc that can never be pushed stall paging for the rest of
    // the session, and every refresh still has to push at least one doc, so it
    // cannot spin. A slice with nothing pushable waits for the next connect,
    // whose sample is a different one (`listEmptyDocs`).
    if (this.serverEmptyTruncated && result.pushed > 0) {
      this.serverEmptyTruncated = false;
      this.vaultEngine?.refresh();
    }
  }

  /**
   * Second half of the run: report the vault channel's BACKFILL until it lands,
   * then finish. Driven by the engine's callbacks rather than polling — the queue
   * is serial, so every applied document is a tick.
   *
   * Bounded to the backfill, which is bounded by the server's `ready`. Steady-
   * state traffic is explicitly not this phase's business: the server fans a doc
   * update back to its own author, so counting live frames meant every keystroke
   * in the open note ticked the counter — a five-note vault reporting
   * "Syncing 55/55", climbing, forever.
   */
  private beginDownloadPhase(scope: VaultScope): void {
    const engine = this.vaultEngine;
    const progress = this.progress;
    if (!engine || !progress) return;
    if (!scope.isCurrent()) return;
    const { done, total } = engine.inboundProgress();
    this.lastInboundDone = done;
    this.lastInboundTotal = total;
    this.downloadPhase = true;
    this.armChannelWatchdog(scope);
    // Opens at 0/0 ("Syncing…"), because this now runs the moment the engine is
    // started — before its socket is even open, let alone `hello`ed. There is
    // deliberately no bare `backfillSettled()` short-circuit here: an engine
    // that has not connected yet reports settled (nothing is queued and no window
    // is open), so checking it alone would end the phase before it began.
    progress.phase("downloading", total - done);
    // …but the channel can also be AHEAD of us. In the prime window it starts
    // before the reconcile, and on a small vault its `ready` and the idle edge
    // both land while the reconcile is still running — so the one event that
    // ends this phase (`handleInboundIdle`) fired before the phase existed, the
    // watchdog stands down because the channel is healthy, and the pill said
    // "Syncing" until some teammate's keystroke happened to drain a frame. A
    // synced channel whose backfill is settled has already delivered the edge;
    // take it now. `vaultStatus === "synced"` is what makes the check safe: an
    // unconnected engine never reports synced, only settled.
    if (this.vaultStatus === "synced" && engine.backfillSettled()) {
      this.handleInboundIdle(scope);
    }
  }

  private armChannelWatchdog(scope: VaultScope): void {
    this.clearChannelWatchdog();
    this.channelWatchdog = setTimeout(() => {
      this.channelWatchdog = null;
      if (!scope.isCurrent() || !this.downloadPhase) return;
      if (this.vaultStatus === "synced") return; // `ready` landed; the idle edge owns it
      const progress = this.progress;
      if (!progress) return;
      // Stop claiming progress that isn't happening. `channelStalled` lets the
      // next `ready` re-stamp a terminal phase (completion normally refuses to
      // overwrite `error`, because a real failure must not be papered over).
      this.downloadPhase = false;
      this.channelStalled = true;
      progress.phase("error");
      progress.flush();
    }, CHANNEL_WATCHDOG_MS);
  }

  private clearChannelWatchdog(): void {
    if (this.channelWatchdog) {
      clearTimeout(this.channelWatchdog);
      this.channelWatchdog = null;
    }
  }

  /** One backfilled document applied by the vault channel. */
  private handleInboundProgress(done: number, total: number, scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    if (!this.downloadPhase && !this.bulkPhase && !this.contentRunInFlight()) {
      this.beginDownloadPhase(scope);
    }
    if (!this.downloadPhase) return;
    const progress = this.progress;
    if (!progress) return;
    if (total > this.lastInboundTotal) {
      progress.addTotal(total - this.lastInboundTotal);
      this.lastInboundTotal = total;
    }
    for (let i = this.lastInboundDone; i < done; i++) progress.item("ok");
    this.lastInboundDone = done;
    // Buffer draining is useful work even while the socket is paused. A slow
    // apply must not inherit the original connection's expired watchdog.
    this.armChannelWatchdog(scope);
    // Completion is NOT decided here. This runs inside the engine's drain loop,
    // where `draining` is true and therefore nothing can ever look settled; the
    // engine signals the real edge through `handleInboundIdle`.
  }

  /**
   * The backfill finished and everything it sent has been applied — the edge that
   * ends the download phase and hands over to the content run.
   *
   * Fires again on every later drain (a teammate typing keeps the queue moving),
   * so it must stay cheap when there is nothing to do: `startContentRunIfNeeded`
   * no-ops unless the work list is non-empty and no run is live.
   */
  private handleInboundIdle(scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    this.downloadPhase = false;
    this.startContentRunIfNeeded(scope);
  }

  /**
   * Terminal phase for the run. `done` only when NOTHING failed: a vault with any
   * registry failure, any un-pushed note or a plan limit reports `error`, so the
   * UI can never claim a vault is fully synced while an arbitrary subset is
   * local-only. The counters are left intact (e.g. 480/500, failed 20).
   */
  private completeRun(scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    if (!this.bulkPhase && this.vaultEngine && !this.vaultEngine.backfillSettled()) {
      this.beginDownloadPhase(scope);
      return;
    }
    const progress = this.progress;
    if (!progress) return;
    this.downloadPhase = false;
    this.channelStalled = false;
    this.clearChannelWatchdog();
    const uploadFailures = this.uploader?.failedDocs().length ?? 0;
    const clean =
      uploadFailures === 0 &&
      // The bulk engine's own refusals count exactly as much as the per-doc
      // ones: a bootstrap page that could not be applied, or a doc the batch
      // push was denied, leaves the vault partly unsynced either way.
      this.bulkFailures.size === 0 &&
      !this.serverTooOld &&
      this.permanentFailures.size === 0 &&
      !this.registry.hasFailures() &&
      this.registry.limitCode() == null;
    progress.phase(clean ? "done" : "error");
    progress.flush();
  }

  /**
   * ONE doc's position in the sync layer, as five facts it already holds.
   *
   * The Health page's "Check a note" box, and the reason it can be honest: every
   * field here is read, never inferred. They disagree with each other on purpose
   * — `pushed` without `queued` is a settled note, `pushed` WITH `diverged` is a
   * note whose local edits may never have left, and `emptyEverywhere` is the one
   * combination where "not pushed" is not a problem at all.
   *
   * Scope-safe: with no live vault every answer is the honest empty one rather
   * than a leftover from the vault we left.
   */
  inspectDoc(docId: string): {
    pushed: boolean;
    queued: boolean;
    diverged: boolean;
    permanentFailure: string | null;
    emptyEverywhere: boolean;
  } {
    const scope = this.scope;
    if (!scope || !scope.isCurrent()) {
      return {
        pushed: false,
        queued: false,
        diverged: false,
        permanentFailure: null,
        emptyEverywhere: false,
      };
    }
    return {
      pushed: this.registry.isPushed(docId),
      queued: this.localChanges.has(docId),
      diverged: this.divergedDocs.has(docId),
      permanentFailure: this.permanentFailures.get(docId)?.reason ?? null,
      emptyEverywhere: this.emptyEverywhere.has(docId),
    };
  }

  /** Everything the current run could not sync — registry rows and note content. */
  syncFailures(): {
    registry: ReturnType<VaultRegistry["failures"]>;
    // `permanent` controls retry scheduling; `kind` carries the diagnosis. The
    // Health page must not infer "too large" from terminal scheduling metadata.
    content: Array<{
      docId: string;
      relPath: string;
      reason: string;
      permanent?: boolean;
      kind?: UploadFailure["kind"];
    }>;
    limitCode: string | null;
  } {
    // Permanent failures are remembered across runs (see the field), so they are
    // reported from there; the live uploader's list covers this run's transient
    // ones. A doc in both is listed once.
    const content = [...this.permanentFailures.values()].filter(
      (f) => !this.invalidatedFailures.has(f.docId),
    );
    const seen = new Set(content.map((f) => f.docId));
    // The bulk engine's failures, before the per-doc uploader's: a doc in both
    // is listed once, and the bulk verdict is the more recent one.
    for (const f of this.bulkFailures.values()) {
      if (this.invalidatedFailures.has(f.docId)) continue;
      if (seen.has(f.docId)) continue;
      seen.add(f.docId);
      content.push(f);
    }
    for (const f of this.uploader?.failedDocs() ?? []) {
      if (this.invalidatedFailures.has(f.docId)) continue;
      if (seen.has(f.docId)) continue;
      // A doc sitting in the local-change queue is being pushed again right now
      // (an external write, or the Health page's Retry). The failure still in the
      // PREVIOUS run's uploader describes an attempt that has been superseded, so
      // reporting it would leave a row the user just retried looking broken until
      // the next run happened to replace the uploader.
      if (this.localChanges.has(f.docId)) continue;
      content.push(f);
    }
    return {
      registry: this.registry.failures(),
      content,
      limitCode: this.registry.limitCode(),
    };
  }

  /**
   * Sign-out / vault-switch: stop networked sync. MUST run BEFORE the Rust vault
   * slot is swapped (`ipc.openVault*`) — that ordering is what stops a surviving
   * timer from pulling with vault A's server ids against vault B's tree. The
   * scope guard is the second line of defence for call sites that get it wrong.
   */
  disable(): void {
    this.teardown();
    // closeCurrent only emits when a note was open; make sure a note-less
    // disable (e.g. switching to a local vault) still drops to offline.
    this.emitStatus();
  }

  /**
   * Release every resource tied to the current vault. Shared by `disable()` and
   * `enable()` (which re-arms immediately afterwards). Anything vault-scoped
   * added later belongs here — a leak here is a cross-vault write.
   */
  private teardown(): void {
    this.enabled = false;
    this.primed = false;
    // A pending badge hold belongs to the vault we are leaving; letting it fire
    // would paint that vault's status over the next one's.
    this.clearStatusHold();
    this.emittedStatus = null;
    this.presence = null;
    this.viewing = null;
    this.announcedDocId = null;
    this.warnedUnmapped.clear();
    if (this.presenceRepushTimer) {
      clearTimeout(this.presenceRepushTimer);
      this.presenceRepushTimer = null;
    }
    this.vaultStatus = "idle";
    this.onVaultStatus?.("idle");
    // The timeline describes the vault we are leaving; keeping it would explain
    // the next vault's state with the previous one's history. The SyncLog object
    // itself survives, so a subscriber's unsubscribe stays valid (see the field).
    this.log.clear();
    this.loggedPhase = null;
    // Timers first: a timer that fires after we've cleared the state below would
    // still see a live `registry`/`attachments` and act on the wrong vault.
    if (this.registryPullTimer) {
      clearTimeout(this.registryPullTimer);
      this.registryPullTimer = null;
    }
    this.registryPullBurstAt = 0;
    if (this.localChangeTimer) {
      clearTimeout(this.localChangeTimer);
      this.localChangeTimer = null;
    }
    if (this.diskDeleteTimer) {
      clearTimeout(this.diskDeleteTimer);
      this.diskDeleteTimer = null;
    }
    this.localChanges.clear();
    // A pending disk delete belongs to the vault we are leaving, and its paths
    // would name a DIFFERENT file in the next one. Dropping them is also the
    // conservative direction: the delete simply doesn't propagate, and the next
    // session re-materializes the note with its content.
    this.pendingDiskDeletes.clear();
    this.pendingDeleteByPath.clear();
    this.renameCandidates.clear();
    this.pullAfterDiskDeletes = false;
    // The next vault starts un-live: its own reconcile + channel decide.
    this.liveSince = null;
    this.channelSynced = false;
    this.pulledOnce = false;
    // Another vault's permission news says nothing about this one's listings.
    this.aclChangedAt = 0;
    this.serverRevoked.clear();
    this.divergedDocs.clear();
    // Scoped to the vault like everything else here: another vault's empty-doc
    // list would put ITS doc ids at the head of this vault's upload queue.
    this.serverEmpty.clear();
    this.serverEmptyTruncated = false;
    this.serverBehind.clear();
    this.emptyEverywhere.clear();
    this.permanentFailures.clear();
    this.invalidatedFailures.clear();
    this.unhydratedPlaceholders.clear();
    this.emptyProbe = null; // a probe still in flight sees a stale scope and drops
    // The bulk run before the engine it borrows from: `stop()` makes every pool
    // lane drop at its next checkpoint, so nothing is still promoting a bridge
    // when `stopVaultEngine` destroys the store underneath it.
    this.uploader?.stop();
    this.uploader = null;
    // Same reason, one layer up: both bulk engines check `shouldStop` between
    // every page / every doc, so stopping them here means nothing is still
    // holding a bridge when the store is destroyed below.
    this.bootstrapRunner?.stop();
    this.bootstrapRunner = null;
    this.batchPusher?.stop();
    this.batchPusher = null;
    // The run's own `finally` clears this when its pool notices `shouldStop`;
    // clearing it here too means the next vault's guards are never held by the
    // previous vault's in-flight pusher.
    this.batchPushing = false;
    this.bulkPhase = false;
    this.vaultEngineLiveOnly = false;
    this.bulkFailures.clear();
    this.serverTooOld = false;
    this.bulkRun = null;
    this.bulkDownloadPending = false;
    this.downloadPhase = false;
    this.clearChannelWatchdog();
    this.channelStalled = false;
    this.lastInboundDone = 0;
    this.lastInboundTotal = 0;
    // The binary wave's counters belong to the vault we are leaving; a stopped
    // mirror will never settle what it announced.
    this.binaryDownloads = 0;
    this.binaryDownloadPhase = false;
    this.attachments?.stop();
    this.attachments = null;
    this.binaryDeletes?.stop();
    this.binaryDeletes = null;
    this.clearVaultPresence();
    this.stopVaultEngine();
    this.closeCurrent();
    // The registry is a process singleton: a surviving `serverVaultId` + path
    // maps are precisely what let vault A's ids be applied to vault B's tree.
    // (`reset` also disposes its config-checkpointer synchronously, so a pending
    // flush can't write this vault's doc map into the next one.)
    this.registry.reset();
    // Nulls the store's `syncProgress`, so a half-finished count from the vault we
    // just left is never on screen.
    this.cleanupProgress?.dispose();
    this.cleanupProgress = null;
    this.progress?.dispose();
    this.progress = null;
    // Retire the scope LAST so anything above that consults `isCurrent()` while
    // tearing down still sees a coherent scope; after this, every captured scope
    // in flight reads as stale.
    this.scope = null;
    vaultScopes.end();
    // Now that no scope is current, this publishes an EMPTY path→docId map (and
    // clears the coalescing timer, so nothing from the vault we left arrives
    // 100ms into the next one). The last-edit stamps go the same way.
    this.publishRegistryMap();
    this.publishNoteMeta({});
    this.onColors?.({});
  }

  /** UI subscribes here for the vault-wide background-sync indicator. */
  setVaultStatusListener(cb: ((status: VaultSyncStatus) => void) | undefined): void {
    this.onVaultStatus = cb;
  }

  /**
   * UI subscribes here for the live "who's viewing what" roster that drives the
   * sidebar presence dots. Fires with the full peer list on every change.
   */
  setVaultPresenceListener(cb: ((peers: VaultPeer[]) => void) | undefined): void {
    this.onVaultPresence = cb;
  }

  // ---- push-to-talk voice ------------------------------------------------

  /**
   * UI subscribes here to learn who is currently talking. Fires with the set of
   * speaking user ids on every change, so the sidebar can light them up.
   */
  setVoiceListener(cb: ((speaking: VoiceSpeaker[]) => void) | undefined): void {
    this.onVoiceSpeakers = cb;
  }

  /**
   * Open the mic and stream to the vault until the returned handle is stopped.
   *
   * One transmission per press. The stream id is minted here so every chunk of
   * a single press-and-hold groups on the receiving end, and the format rides
   * the opening chunk only.
   *
   * Works with no channel at all. `this.vaultEngine` is read per chunk rather
   * than captured up front, so a transmission that starts offline still lands
   * the moment the channel comes back mid-press, and one that starts online
   * survives a drop instead of throwing. Chunks with nowhere to go are simply
   * dropped — which is what "ephemeral" already means everywhere else here.
   */
  async startBroadcast(): Promise<{ stop: () => Promise<void> }> {
    const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let lastSeq = -1;

    const capture = await startCapture((audio, seq) => {
      lastSeq = seq;
      this.vaultEngine?.sendVoice(
        { s: streamId, n: seq, ...(seq === 0 ? CAPTURE_FORMAT : {}) },
        audio,
      );
    });

    return {
      stop: async () => {
        await capture.stop();
        // Always send a final marker, even with an empty payload: it's what
        // closes the stream on every listener. Without it a receiver holds the
        // "talking" indicator until its own timeout.
        this.vaultEngine?.sendVoice({ s: streamId, n: lastSeq + 1, f: 1 }, new Uint8Array());
      },
    };
  }

  /** Route one inbound chunk into the player and keep the speaking roster fresh. */
  private handleVoice(frame: VoiceFrame): void {
    const { header, audio } = frame;
    const userId = header.u;
    if (!userId) return;
    this.voiceRoster.learn(userId, header.m, header.c);
    this.voicePlayer.push({
      streamId: header.s,
      userId,
      seq: header.n,
      audio,
      sampleRate: header.sr,
      final: header.f === 1,
    });
  }

  private emitVoiceSpeakers(): void {
    this.onVoiceSpeakers?.(this.voiceRoster.list());
  }

  /**
   * Record which note this client is now viewing (null = none) and broadcast it.
   *
   * Takes the note's PATH, not a doc id: the server id is resolved through the
   * registry on every send, so a mapping that lands later still reaches
   * teammates (see {@link viewing}). `localId` is the local index id — it only
   * has to prove a note is open; it is never announced.
   */
  setViewing(relPath: string | null, localId?: string | null): void {
    this.viewing = relPath ? { path: relPath, localId: localId ?? null } : null;
    this.pushLocalPresence();
  }

  /**
   * Re-broadcast our presence unprompted.
   *
   * The vault channel keeps no shared roster: it is rebuilt only when some
   * connection's first announce triggers a presence-query round. A member
   * joining triggers nothing on the clients already connected, so there was no
   * self-healing path at all — if a newcomer's frames were missed, the gap
   * lasted the whole session. Calling this on member-joined costs one small
   * frame and gives the roster a way to converge.
   */
  announcePresence(): void {
    this.pushLocalPresence();
  }

  /**
   * The server doc_id to announce for the note we have open, resolved NOW.
   *
   * Case-insensitive on purpose: `byPath` is keyed by the server's spelling of
   * a path and the store opens notes by their disk spelling, which on
   * macOS/Windows can differ only in case for one and the same file.
   */
  private resolveViewingDocId(): string | null {
    if (!this.viewing) return null;
    const mapped = this.registry.getMappingCi(this.viewing.path)?.docId;
    const docId = viewingDocId(this.viewing.localId, mapped);
    if (!docId) this.warnUnmapped(this.viewing.path);
    return docId;
  }

  /** What the next presence frame would carry (see {@link pushLocalPresence}). */
  private effectiveViewingDocId(): string | null {
    return this.status === "invisible" ? null : this.resolveViewingDocId();
  }

  /**
   * Say out loud that we are about to announce "nothing" for an open note.
   *
   * Both ends of this used to fail in silence — the sender shrugged because a
   * missing mapping is normal for a local vault, and the server dropped the
   * unreadable id without a word — which is why #125 took a repro to find.
   * Once per path per vault: a registry pull re-resolves thousands of times.
   */
  private warnUnmapped(relPath: string): void {
    if (!this.vaultEngine || this.warnedUnmapped.has(relPath)) return;
    this.warnedUnmapped.add(relPath);
    console.warn(
      `[presence] no server doc_id for "${relPath}" — announcing nothing. ` +
        "Teammates won't see this note on their sidebar until the registry maps it.",
    );
  }

  /** Send our current viewing state over the vault channel. Invisible users
   *  broadcast a null doc so they don't appear on teammates' sidebars. */
  private pushLocalPresence(): void {
    if (!this.vaultEngine || !this.presence) return;
    const docId = this.effectiveViewingDocId();
    this.announcedDocId = docId;
    this.vaultEngine.setPresence({
      docId,
      name: this.presence.name,
      color: colorForUser(this.presence.id),
      status: this.status,
    });
  }

  /** Coalesce a burst of registry map changes into at most one re-resolve. */
  private schedulePresenceRepush(): void {
    if (this.presenceRepushTimer) return;
    this.presenceRepushTimer = setTimeout(() => {
      this.presenceRepushTimer = null;
      this.repushPresenceForMapping();
    }, PRESENCE_REPUSH_MS);
  }

  /**
   * The registry map moved; re-announce only if that changed the id we would
   * send. Silent when nothing is open, when the mapping is still missing, and
   * when the reconcile merely re-affirmed what we already announced — so a pull
   * over thousands of notes costs one lookup, not thousands of frames.
   */
  private repushPresenceForMapping(): void {
    if (!this.viewing || !this.vaultEngine || !this.presence) return;
    if (this.effectiveViewingDocId() === this.announcedDocId) return;
    this.pushLocalPresence();
  }

  /** Fold an incoming teammate presence update into the roster and notify the UI. */
  private handleVaultPresence(peer: VaultPeer): void {
    // Never show ourselves in the sidebar — you know where you are.
    if (this.presence && peer.userId === this.presence.id) return;
    if (peer.docId === null) this.vaultPresence.delete(peer.userId);
    else this.vaultPresence.set(peer.userId, peer);
    this.onVaultPresence?.([...this.vaultPresence.values()]);
  }

  /** Drop the whole roster (on disconnect/disable) so no stale dots linger. */
  private clearVaultPresence(): void {
    if (this.vaultPresence.size === 0) return;
    this.vaultPresence.clear();
    this.onVaultPresence?.([]);
  }

  /** Start the always-on background feed for the reconciled vault (spec 05). */
  private startVaultEngine(scope: VaultScope): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) return;
    // Already live for this collection (the prime window got there first) — leave
    // it alone. See `vaultEngineId`.
    if (this.vaultEngine && this.vaultEngineId === vaultId) return;
    this.stopVaultEngine();
    this.vaultEngineId = vaultId;
    markOnce("channel-start");
    // Reflect "connecting" the moment we switch into a vault, so the light
    // moves off a stale value before the socket reports back.
    this.vaultStatus = "connecting";
    this.onVaultStatus?.("connecting");
    if (!this.current) this.emitStatus();
    const store = new VaultDocStore({
      resolvePath: (docId) => this.registry.pathForDocId(docId),
      // The background feed writes .md files for docs nobody has open. Pin its
      // IO to this vault's epoch so a cold apply that lands after a vault switch
      // is refused by Rust instead of overwriting the new vault's file at the
      // same relative path.
      io: createTauriBridgeIO(scope.vaultEpoch),
      // Durable state-vector manifest in this vault's own `.context/index.sqlite`,
      // epoch-pinned for the same reason. Without it the engine's `hello` was empty
      // on every launch and the server re-sent the full state of every doc, forever.
      manifest: createIpcManifestStore(scope.vaultEpoch),
      // A cold apply merged an external disk edit into the doc: those ops are
      // local-only until pushed, and the local-change drain's own ingest will
      // see file == doc and try to skip — the diverged set is what forces the
      // connect (see `handleLocalFileChanged`).
      onExternalMerge: (docId) => {
        if (!scope.isCurrent()) return;
        this.divergedDocs.add(docId);
        const relPath = this.registry.pathForDocId(docId);
        if (relPath) {
          this.localChanges.set(docId, relPath);
          this.note("info", "push-queued", "Merged an edit made outside Baalda — sending the result", {
            docId,
            path: relPath,
          });
          this.armLocalChangeDrain(scope, LOCAL_CHANGE_DEBOUNCE_MS);
        }
      },
      // The counterpart: a cold apply landed the server's state and the file had
      // nothing of its own to add, so this doc is on the server BY DEFINITION —
      // record the push. This is what stops the content run from re-sending every
      // note the vault channel just delivered, over a socket apiece.
      //
      // Never for a diverged doc: those hold local-only ops from an out-of-band
      // merge, and marking them pushed would strand exactly the bytes nobody else
      // has. (`divergedDocs` is the only local-only state this layer can see; a
      // doc edited offline in the editor and never flushed is not in it, which is
      // why `pushed` stays an optimisation and `ready.empty` stays the authority.)
      onConverged: (docId) => {
        if (!scope.isCurrent() || this.divergedDocs.has(docId)) return;
        this.registry.markPushed(docId);
        this.serverEmpty.delete(docId);
      },
    });
    this.docStore = store;
    // Skip the server's cold backfill when the bulk engine is going to page the
    // same content out over HTTP (with a cursor, and without a WS frame per
    // doc). Decided from the doc count we know at THIS moment: the prime window
    // knows the local map, and a cold join — which does not prime at all — knows
    // the server's full listing by the time this runs. Below the threshold the
    // flag is off and the channel behaves exactly as it always has.
    const liveOnly = useBulkPath(this.registry.allDocIds().length);
    this.vaultEngineLiveOnly = liveOnly;
    // A note opened during the PRIME window already owns a provider for its doc.
    // `openDoc` suppressed it on the store that existed then — which was null —
    // and a fresh store suppresses nothing, so without this the background feed
    // would cold-apply to that same Y.Doc: two writers on one doc, the one thing
    // this layer is built to avoid.
    if (this.currentDocId) store.setSuppressedDoc(this.currentDocId);
    this.vaultEngine = new VaultSyncEngine({
      api,
      vaultId,
      sink: store,
      onBootstrapRequired: () => {
        if (!scope.isCurrent()) return;
        this.bulkDownloadPending = true;
        if (!this.contentRunInFlight() && !this.bulkPhase) this.progress?.phase("downloading", 0);
        this.handleRegistryChanged("reauth");
      },
      onStatus: (s) => {
        // A dropped/reconnecting channel means we no longer have a live roster —
        // clear it so the sidebar doesn't show ghosts (the engine re-announces
        // everyone on the next `synced`).
        if (s !== "synced") this.clearVaultPresence();
        this.vaultStatus = s;
        this.emitStatus();
        this.onVaultStatus?.(s);
        // Every (re)connect re-pulls the registry. `registry` control frames only
        // reach clients that were CONNECTED when the change happened — anything a
        // teammate created/renamed/deleted while this device was offline (or
        // between reconcile and the socket coming up) was announced to nobody
        // here. Without this, those changes surfaced only on the next sign-in or
        // relaunch. Debounced + idempotent, so the extra pull on a healthy
        // connect costs one listing round trip.
        if (s === "synced") {
          this.channelSynced = true;
          this.markLive();
          this.handleRegistryChanged("channel-synced");
        }
      },
      // The vault token mint was refused with a 401 — the session, not the
      // vault. Reaches the same guard as the per-note mints above; with no note
      // open this channel is the ONLY thing still minting, so without it a
      // signed-out app that is merely sitting on its sidebar never notices.
      onSessionRejected: () => this.noteSessionRejected(),
      // An ACL change in this vault may have flipped the open note's grant
      // (view↔edit, lock/unlock). Re-mint its token so the editor becomes
      // read-only/editable live — no reopen (spec 04 §4).
      onAclChanged: () => this.handleServerReauth(scope),
      // A teammate changed the folder/note structure — re-pull + refresh tree.
      onRegistryChanged: () => this.handleRegistryChanged("registry-frame"),
      // A new teammate joined the vault — refresh roster + celebrate.
      onMemberJoined: (name) => this.onMemberJoined?.(name),
      // A teammate's viewing state changed — update the sidebar presence roster.
      onPresence: (peer) => this.handleVaultPresence(peer),
      // A teammate is talking. Play it as it lands; nothing is kept.
      onVoice: (frame) => this.handleVoice(frame),
      // Inbound backfill progress — the `downloading` half of the run's progress.
      onInboundProgress: (done, total) => this.handleInboundProgress(done, total, scope),
      // …and the edge that ends it (and starts the content run).
      onInboundIdle: () => this.handleInboundIdle(scope),
      // Which readable docs the server has NO content for. Arrives on every
      // `ready`, so it also re-arms a run the uploader's failure streak paused.
      onServerEmpty: (docIds, truncated) =>
        this.handleServerEmpty(docIds, truncated, scope),
      // Which readable docs THIS device holds ops the server lacks for. Fired
      // right before `onServerEmpty`, so the run that starts sees them queued.
      onServerBehind: (docIds) => this.handleServerBehind(docIds, scope),
      // Which docs we HOLD that we may no longer read. Server-stated, on every
      // connect — the authority a cold launch after a revocation never had.
      onServerRevoked: (docIds, truncated) =>
        this.handleServerRevoked(docIds, truncated, scope),
      // The live half of the same statement: `refreshAcl` names each lost doc
      // with a `drop` just before the `reauth`, so both paths carry a list.
      onServerDrop: (docId) => this.handleServerDrop(docId, scope),
      liveOnly,
      // The tree binaries this device holds. Not in the manifest — a binary has
      // no CRDT and so no state vector — but announced all the same, because
      // `ready.revoked` can only name what we say we hold, and a `.pdf` set to
      // Private has to leave this disk exactly as a note does.
      fileDocIds: () => this.registry.fileDocIds(),
      heldNoteIds: () => this.registry.allDocIds(),
    });
    this.vaultEngine.start();
    // Seed our own presence into the fresh engine (it flushes on `ready`).
    this.pushLocalPresence();
  }

  /**
   * Give the vault channel its backfill back: one fresh `hello`, without
   * `mode: "live-only"`.
   *
   * Idempotent and silent when the channel was never live-only, which is what
   * lets both callers — the bulk phase finishing, and a reconcile that found a
   * vault below the threshold after the prime window sized it above — just call
   * it. By the time the bulk phase calls it the manifest covers everything the
   * bootstrap wrote, so the backfill it asks for is ≈0 frames wide.
   */
  private restoreChannelBackfill(): void {
    if (!this.vaultEngineLiveOnly) return;
    this.vaultEngineLiveOnly = false;
    this.vaultEngine?.reconnect({ liveOnly: false });
  }

  private stopVaultEngine(): void {
    this.vaultEngine?.stop();
    this.vaultEngine = null;
    this.vaultEngineId = null;
    // Cut any audio still playing: it belongs to the vault we're leaving, and
    // hearing a teammate from the previous vault after switching would be a bug
    // with an unpleasant privacy flavour.
    this.voicePlayer.stopAll();
    this.voiceRoster.clear();
    this.emitVoiceSpeakers();
    // Kick the durable manifest write FIRST, while this vault's epoch is still the
    // open one: the store's IPC is epoch-pinned, so a write issued after Rust has
    // swapped vaults is refused (benignly — the manifest just misses its last
    // second of updates and the next connect back-fills a little more).
    const store = this.docStore;
    this.docStore = null;
    void store?.flushStateVectors();
    void store?.destroyAll();
  }

  /**
   * Handle a watcher event for a BINARY: schedule a debounced two-way reconcile.
   * Binaries never touch the CRDT pipeline.
   *
   * The PATH is what makes a delete possible. A reconcile alone can only ever
   * say "the server has bytes this device doesn't" — which is exactly what a
   * deleted file looks like, and why deleting a synced PDF used to download it
   * back on the next pass. Handing the path to the delete queue
   * (`binaryDeletes.ts`) is what lets the disk be asked instead. Called with no
   * path (a caller that has only "something changed"), the behaviour is exactly
   * what it always was.
   */
  handleAttachmentChanged(relPath?: string): void {
    if (!this.enabled) return;
    // Every kind, not just `removed`: Rust reports a non-note file as `tree`
    // whether it was written or deleted (`watcher.rs plan_batch`), so the queue
    // records the path and asks the DISK when its window closes.
    if (relPath) this.binaryDeletes?.noteChanged(relPath);
    this.attachments?.scheduleReconcile();
  }

  /**
   * The blob mirror is about to pull `count` files down.
   *
   * Bytes are work, and the header counts work: a wave of binaries reports
   * through the SAME {@link SyncProgressReporter} a note backfill does, so
   * "Syncing 1/1" covers a re-granted `.docx` exactly as it covers a note. The
   * alternative — a second counter for files — would mean two things on screen
   * disagreeing about whether the vault is settled.
   *
   * Two cases, one rule: when a note run (or the channel backfill) already owns
   * the phase, the files JOIN its denominator; when nothing else is running,
   * this stamps `downloading` itself and the wave's last settle hands the
   * terminal phase back to {@link startContentRunIfNeeded}.
   */
  private handleBinaryDownloads(count: number, scope: VaultScope): void {
    if (count <= 0 || !scope.isCurrent()) return;
    const progress = this.progress;
    if (!progress) return;
    this.binaryDownloads += count;
    if (this.downloadPhase || this.contentRunInFlight() || this.binaryDownloadPhase) {
      progress.addTotal(count);
    } else {
      this.binaryDownloadPhase = true;
      progress.phase("downloading", count);
    }
    progress.flush();
  }

  /** One announced file landed (or failed). See {@link handleBinaryDownloads}. */
  private handleBinaryDownloadSettled(outcome: "ok" | "failed", scope: VaultScope): void {
    if (!scope.isCurrent()) return;
    const progress = this.progress;
    if (!progress) return;
    if (this.binaryDownloads > 0) this.binaryDownloads--;
    progress.item(outcome);
    if (this.binaryDownloads > 0) return;
    progress.flush();
    this.binaryDownloadPhase = false;
    // The wave is over, so re-enter the ONE place that decides a terminal phase.
    // Unconditionally, not just for a phase this wave opened: the note run's own
    // settle edge may have come and gone while these bytes were moving (the gate
    // in `startContentRunIfNeeded` sent it away), and then nobody else is left to
    // stamp `done`. It no-ops while a run is live.
    this.startContentRunIfNeeded(scope);
  }

  /**
   * The index finished extracting text for these tree binaries (`files-indexed`).
   *
   * Public like `handleAttachmentChanged`: it is an external signal for this
   * vault, and the sync layer decides what it is worth. All it does is offer
   * the words to the server for team search — it never moves bytes and never
   * blocks the blob mirror.
   */
  handleFilesIndexed(paths: string[]): void {
    if (!this.enabled || paths.length === 0) return;
    this.attachments?.handleFilesIndexed(paths);
  }

  /** Build the AttachmentSync from the reconciled server vault id + ipc/api.
   *  Bound to `scope`: the captured `vaultId` is only valid while that vault is
   *  open, so both the pass guard and the pinned IPC epoch reference it. */
  private setupAttachments(scope: VaultScope): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) {
      this.attachments?.stop();
      this.attachments = null;
      this.binaryDeletes?.stop();
      this.binaryDeletes = null;
      return;
    }
    const epoch = scope.vaultEpoch;
    // Built BEFORE the mirror, because the mirror asks it before every download.
    this.binaryDeletes?.stop();
    this.binaryDeletes = new BinaryDeleteQueue({
      isCurrent: () => scope.isCurrent(),
      // The same liveness the note queue uses: the vault channel is synced and
      // one pull has completed, so a missing file is a decision, not a startup.
      isLive: () => this.isLive(),
      // `false` only for a definite not-found; every other failure — a vault
      // switch, an IPC hiccup under load — rejects, and the drain reads a
      // rejection as "couldn't ask" rather than "gone". This used to be a
      // `file_stat` whose EVERY error meant "deleted", which propagated deletes
      // for binaries that never left the disk.
      exists: (relPath) => ipc.binaryExists(relPath, epoch),
      listLocal: () => ipc.listBinaries(epoch),
      listServer: () => api.listVaultBlobs(vaultId),
      fileId: (relPath) => this.registry.getFileId(relPath),
      // The mirror caches ids per path too, and consults that cache BEFORE the
      // registry. Forgetting only the registry's copy left the dead id live for
      // the rest of the session: a file that came back uploaded under a row
      // the server had just deleted, and failed on every pass.
      forgetFileId: (relPath) => {
        this.registry.forgetFileId(relPath);
        this.attachments?.forgetFile(relPath);
      },
      moveFileId: (from, to) => this.registry.moveFileId(from, to),
      deleteFile: (id) => api.deleteFile(id),
      // Never forced: a 409 means a note still embeds those bytes, and that
      // refusal is the whole reason the flag exists.
      deleteBlob: (id) => api.deleteBlob(id),
      moveFile: async ({ id, relPath }) => {
        await api.registerFile({ vaultId, id, path: relPath });
      },
      notify: (text, tone) => toast(text, tone ?? "error"),
      // A pass rebuilds the sidebar's file dots from both listings, so this is
      // also how a removed file's dot goes away.
      onServerChanged: () => this.attachments?.scheduleReconcile(),
    });
    this.attachments = new AttachmentSync({
      isCurrent: () => scope.isCurrent(),
      // The WHOLE vault, not just `attachments/`: a `.docx` in `Team/` is a
      // blob like any other since it got its own `files` row (PR3 Stage A).
      listLocal: () => ipc.listBinaries(epoch),
      readLocal: (relPath) => ipc.readBinaryFile(relPath, epoch),
      writeLocal: (relPath, bytes) => ipc.writeBinaryFile(relPath, bytes, epoch),
      // A tree binary materializes through its OWN guard; the `attachments/`
      // one stays exactly as strict as it was for server-supplied paths.
      writeTreeLocal: (relPath, bytes) => ipc.writeTreeBinary(relPath, bytes, epoch),
      // Our own write, so its watcher echo is not an external edit — the same
      // one-echo-per-path claim the registry makes for a materialized note.
      markMaterialized: (relPath) => this.registry.markMaterialized(relPath),
      // A file inside an open delete window is not a file this device is
      // missing — without this the debounced pass downloads it back before the
      // queue has even decided.
      isDeletePending: (relPath) => this.binaryDeletes?.isPending(relPath) ?? false,
      listServer: () => api.listVaultBlobs(vaultId),
      // The legacy pair: still the whole flow for a server that predates the
      // intent route, and the fallback the client drops to on its 404.
      uploadServer: (relPath, bytes, mime, docId) =>
        api
          .uploadBlob({ vaultId, relPath, bytes, mime, fileName: baseName(relPath), docId })
          .then(() => undefined),
      downloadServer: (id) => api.downloadBlob(id),
      // intent → PUT → complete. Bytes go through Rust (epoch-pinned, streamed
      // from/to disk); the webview `fetch` pair behind it is only reached when
      // the invoke bridge says the command isn't there.
      createIntent: (input) =>
        api.createBlobIntent(vaultId, {
          sha256: input.sha256,
          size: input.size,
          mime: input.mime,
          relPath: input.relPath,
          filename: input.filename,
          docId: input.docId,
        }),
      completeUpload: (completeUrl, body) =>
        api.completeBlob(completeUrl, body).then(() => undefined),
      requestParts: (partsUrl, partNumbers) => api.requestBlobParts(partsUrl, partNumbers),
      putFile: (input) =>
        ipc.uploadAttachment(
          {
            relPath: input.relPath,
            url: input.url,
            method: input.method,
            headers: input.headers,
            range: input.range,
          },
          epoch,
        ),
      putBytes: (input) => api.uploadBytesTo(input),
      downloadUrl: (blobId) => api.blobDownloadUrl(blobId),
      fetchToFile: (input) => ipc.downloadAttachment(input, epoch),
      // ---- Tree binaries: the `files` row that carries their ACL ----------
      localFileIds: async () =>
        new Map((await ipc.listFileRows()).map((r) => [r.path, r.id])),
      knownFileId: (relPath) => this.registry.getFileId(relPath),
      registerFile: async ({ relPath, id }) => {
        const row = await api.registerFile({ vaultId, id, path: relPath });
        // The server echoes the row's own id — which is ours today, and is what
        // lets a future path-adopting server hand back the identity it already
        // holds without this side having to guess.
        return row.docId ?? row.id ?? null;
      },
      // The batch twin, used only above the bulk threshold (see
      // `AttachmentSync.preregisterFiles`). The server resolves each parent from
      // the path, exactly as `registerFile` relies on it to — `folderPath` is
      // sent so it can, and a mismatch comes back per item rather than as a
      // failed request.
      registerFiles: (inputs) =>
        api.batchCreateFiles(
          vaultId,
          inputs.map((i) => ({
            fileId: i.id,
            relPath: i.relPath,
            folderPath: parentDirOf(i.relPath),
            sha256: i.sha256,
            size: i.size,
            mime: i.mime,
          })),
        ).then((results) =>
          results.map((r) => ({
            relPath: r.relPath,
            // The server echoes the row's own id, like `registerFile` does.
            id: r.fileId,
            status: r.status,
            code: r.code,
            error: r.error,
          })),
        ),
      rememberFileId: (relPath, id, opts) => this.registry.setFileId(relPath, id, opts),
      // A row is not its bytes. This is the separate, stronger claim that lets a
      // revocation remove the file (`registry.confirmFileBytes`).
      confirmFileBytes: (relPath) => this.registry.confirmFileBytes(relPath),
      // The other half of an adoption: the path the row used to be at stops
      // naming it, so `.context/config.json` never holds two ids for one file.
      forgetFileId: (relPath) => this.registry.forgetFileId(relPath),
      // Only ever used to drop a row THIS device minted for bytes the server
      // already holds under another id (`reconcileDedupedRow`).
      deleteFile: (id) => api.deleteFile(id),
      // A rename the delete queue could not settle (the server was unreachable
      // when its window closed) must not be registered as a new file meanwhile:
      // that is precisely how one file ends up with two `files` rows.
      isRenamePending: () => this.binaryDeletes?.hasUnsettled() ?? false,
      // Extracted text: Rust already pulled the words out for local search, so
      // the server gets a copy as ranking fuel rather than re-parsing the file.
      fileText: (relPath) => ipc.getFileText(relPath),
      uploadText: (input) =>
        api.uploadBlobText(vaultId, input.blobId, {
          chars: input.chars,
          content: input.content,
          source: "client",
          docId: input.docId,
          sha256: input.sha256,
        }),
      fetchBytes: (url, headers) => api.downloadBytesFrom(url, headers),
      // Only ever applied to a download URL the SERVER serves; a presigned one
      // is fetched clean (see `sync/attachments.ts`).
      authHeaders: () => api.authHeaders(),
      notify: (text, tone) => toast(text, tone ?? "error"),
      // The sidebar's dot on a `.pdf` row. Scope-guarded like every other
      // emission here: a pass that spans a vault switch must not paint the new
      // vault's rows with the old vault's paths.
      onFileStates: (states) => {
        if (scope.isCurrent()) this.onFileState?.(states);
      },
      onEntitlementBlocked: (blocked) => {
        if (scope.isCurrent()) this.onAttachmentEntitlement?.(blocked);
      },
      // …and the counted half of the same fact, on the vault's one progress
      // reporter. Scope-guarded inside the handlers, for the same reason.
      onDownloadsQueued: (count) => this.handleBinaryDownloads(count, scope),
      onDownloadSettled: (outcome) => this.handleBinaryDownloadSettled(outcome, scope),
    });
  }

  /**
   * Open a doc-session for a freshly-opened bridge. Assumes the caller opened the
   * bridge with `seedFromFile: !willSync(relPath)`.
   */
  async openDoc(bridge: NoteBridge, relPath: string): Promise<OpenedDoc> {
    this.closeCurrent();

    const mapping = this.syncable() ? this.registry.getMapping(relPath) : null;
    if (!mapping) {
      // Local-only: the bridge already seeded from disk on open.
      this.docStore?.setSuppressedDoc(null);
      const awareness = new Awareness(bridge.doc);
      this.currentLocalAwareness = awareness;
      this.applyPresence(awareness);
      return { awareness, sync: null, readOnly: false, status: "offline" };
    }

    // This doc's own provider will own its content sync + presence, so the
    // background vault feed must skip it (no two writers on one Y.Doc).
    this.docStore?.setSuppressedDoc(mapping.docId);
    // Opening a note is the one way its text can grow WITHOUT the watcher event
    // that would otherwise clear this verdict: an egest from the open note is
    // suppressed in `handleLocalFileChanged` a few lines before the
    // `emptyEverywhere.delete` there. Leaving a stale "empty everywhere" in
    // place would make the next `ready.empty` skip the probe for a doc that is
    // no longer empty — stranding the text until an app restart (create note →
    // settle → go offline → type → close → reconnect). Every new note is now
    // created EMPTY, so this is the common path, not an edge case. The cost is
    // at most one extra `readNote` per opened-and-still-empty note per connect.
    this.emptyEverywhere.delete(mapping.docId);

    const sync = new DocSync({
      api,
      doc: bridge.doc,
      docId: mapping.docId,
      vaultId: mapping.vaultId,
      onStatus: (s) => this.handleDocStatus(s),
      // The open note's refresher re-mints 60s before its JWT expires
      // (`tokenRefresh.ts`), so on a long-lived session this is usually the
      // first mint to meet a session that lapsed while the app stayed open.
      onSessionRejected: () => this.noteSessionRejected(),
      onPending: this.onPending,
      onFlushed: this.onFlushed,
    });
    this.current = sync;
    this.currentDocId = mapping.docId;
    // Take over the indicator from the vault channel right away with the
    // provider's initial status (it fires again as the socket progresses).
    this.docStatus = sync.status;
    this.emitStatus();
    // Only for a note the server doesn't have yet — see `reportOpenDocState`.
    // Unconditionally stamping "syncing" here was the other half of the flash.
    this.reportOpenDocState(mapping.docId, "syncing");

    // INSTANT OPEN (spec 05 §1): we no longer BLOCK the editor on the initial
    // server sync. Vault-wide background sync has almost always already brought
    // this doc's CRDT current in local SQLite, so the bridge hydrated with real
    // content and the editor renders it immediately. The pull-before-seed rule
    // (spec 03 §5) still holds — we just run it off the critical path: wait for
    // the provider's first sync, THEN seed only a genuine orphan.
    void this.confirmOpenDoc(sync, bridge, mapping.docId, this.scope);

    this.applyPresence(sync.awareness);
    return {
      awareness: sync.awareness,
      sync,
      readOnly: sync.readOnly,
      status: sync.status,
    };
  }

  /**
   * Background half of pull-before-seed for the OPEN note — and the thing that
   * finally marks it confirmed. Never blocks the editor (spec 05 §1).
   *
   * The bulk uploader deliberately skips the open note, because its editor
   * session already owns a provider for that doc and two writers on one Y.Doc is
   * the one thing to avoid. But skipping is all it used to do: nothing ever
   * called `markPushed` for it. So every note you opened became permanently
   * unconfirmed — `unconfirmedNotes()` counted it the moment you closed it, the
   * next registry signal started another bulk run to "fix" it, and its folder
   * dropped from a settled dot back to a percentage. Opening a note made the
   * vault look less synced, indefinitely.
   *
   * This runs the same contract `ContentUploader.pushOne` runs, over the
   * provider this doc already has: pull first, seed only a genuine orphan, wait
   * for the server to ack, and only then record the push.
   */
  private async confirmOpenDoc(
    sync: DocSync,
    bridge: NoteBridge,
    docId: string,
    scope: VaultScope | null,
  ): Promise<void> {
    const current = (): boolean =>
      (!scope || scope.isCurrent()) && this.current === sync && this.syncable();
    // Capture before the pull can egest over disk, but compare only against a
    // confirmed server state. A partial/empty Y.Doc is not evidence of an edit.
    let fileBeforePull: string | undefined;
    try {
      fileBeforePull = await ipc.readNote(bridge.path, scope?.vaultEpoch);
    } catch { /* no readable local content to preserve */ }
    if (!current()) return;
    // Up to 5s of waiting — easily long enough to span a vault switch. Seeding
    // then would read the NEW vault's file at this path into the OLD vault's doc.
    await sync.whenSynced(5000);
    if (!current()) return;
    if (!sync.isSynced) return;
    if (sync.readOnly) await this.keepUnsendableOpenEdit(bridge, docId, scope, fileBeforePull);
    if (!current()) return;
    const decision = decideSeed({
      signedIn: true,
      serverSynced: true, // past whenSynced (real sync or its offline timeout)
      docEmpty: bridge.serialize().length === 0,
      fileHasContent: true, // seedFromFileIfEmpty is a no-op when the file is empty
    });
    if (decision.action === "seed-from-file") {
      await bridge.seedFromFileIfEmpty();
      if (!current()) return;
    }
    // `isSynced` (not "the timeout elapsed") — the same honesty the uploader
    // insists on. An offline open must not be recorded as confirmed.
    if (!sync.isSynced) return;
    // A view-only grant has nothing to push; the server's copy IS the content, so
    // the doc is confirmed without a flush.
    if (!sync.readOnly && !(await sync.whenFlushed(30_000))) return;
    if (!current()) return;
    this.registry.markPushed(docId);
    this.progress?.doc(docId, "synced");
  }

  /**
   * The open note is read-only and its file diverges from the doc: save the
   * file's bytes to `.context/trash/` and report that they could not be sent.
   *
   * Best effort — a failed read or a failed copy must not stop the doc from
   * confirming — but never silent: an edit the app is about to overwrite is the
   * one thing a user must be told about. Once per doc per session, so reopening
   * a note that is still diverged doesn't fill the trash.
   */
  private async keepUnsendableOpenEdit(
    bridge: NoteBridge,
    docId: string,
    scope: VaultScope | null,
    beforePull?: string,
  ): Promise<void> {
    if (this.unsendableReported.has(docId)) return;
    const relPath = bridge.path;
    let fileText: string;
    try {
      fileText = beforePull ?? await ipc.readNote(relPath, scope?.vaultEpoch);
    } catch {
      return; // nothing readable to lose
    }
    if (scope && !scope.isCurrent()) return;
    if (fileText.length === 0) return; // a download placeholder has no edit to lose
    if (fileText === bridge.serialize()) return; // converged — nothing to keep
    this.unsendableReported.add(docId);
    let dest: string | null = null;
    try {
      dest = await ipc.writeTrashCopy(relPath, trashStamp(), fileText, scope?.vaultEpoch);
    } catch (e) {
      if (ipc.isVaultMismatch(e)) return;
      console.warn(`[sync] couldn't keep a copy of ${relPath}`, e);
    }
    this.registry.recordFailure({
      kind: "note",
      path: relPath,
      docId,
      reason:
        "edit could not be sent: no write access" +
        (dest ? `; copy saved to ${dest}` : "; the local copy could not be saved either"),
      code: null,
    });
  }

  currentSync(): DocSync | null {
    return this.current;
  }

  closeCurrent(): void {
    if (this.current) {
      this.current.destroy();
      this.current = null;
      this.currentDocId = null;
      // The closed note can't have outstanding local edits anymore — clear any
      // lingering "Saving…" so the next note starts clean.
      this.onPending?.(false);
      // No note owns the indicator now — fall back to the vault channel.
      this.docStatus = null;
      this.emitStatus();
    }
    if (this.currentLocalAwareness) {
      this.currentLocalAwareness.destroy();
      this.currentLocalAwareness = null;
    }
    // The note is no longer open — let the background feed resume syncing it.
    this.docStore?.setSuppressedDoc(null);
  }

  /**
   * Update the broadcast activity status and re-publish it on any live
   * awareness immediately, so teammates viewing the same note see the change.
   */
  setPresenceStatus(status: ActivityStatus): void {
    this.status = status;
    if (this.current) this.applyPresence(this.current.awareness);
    if (this.currentLocalAwareness) this.applyPresence(this.currentLocalAwareness);
    // Reflect the new availability on the vault-wide sidebar presence too
    // (also hides/shows us when toggling invisible).
    this.pushLocalPresence();
  }

  private applyPresence(awareness: Awareness): void {
    if (!this.presence) return;
    awareness.setLocalStateField(
      "user",
      presenceUser(this.presence.id, this.presence.name, this.status),
    );
  }
}

/** Process-wide singleton (parallels `bridgeManager`). */
export const syncManager = new SyncManager();

// ---- dev only: never hot-swap this module in half ---------------------------
//
// `syncManager` is a module singleton, and EVERY listener that connects it to
// the UI (`setStatusListener`, `setSyncProgressListener`, `setDocStateListener`,
// `setFileStateListener`, the registry/presence/ACL ones) is registered exactly
// once per page load, from `store.initAuth` — which App.tsx runs behind a
// `useRef` guard that Fast Refresh preserves.
//
// So a Vite HMR round that re-executes this file (every save while working on
// the sync layer, and every save to a module below it) mints a FRESH manager
// whose listeners are all `undefined`, while nothing re-runs `initAuth` to wire
// them up. The vault still opens, the channel still connects and notes still
// sync — the console says so — but the badge, the progress pill and the sidebar
// dots never move again until the webview is reloaded by hand. That is exactly
// the "not connected until I reload" report; it is a dev artifact, never
// reachable in a packaged build, where a module is evaluated once.
//
// Reload the page on the update instead of running half-wired. `import.meta.hot`
// is undefined in production builds, so this disappears there.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}

/** The parent folder of a vault-relative path, or null at the root — the
 *  `folderPath` the batch file route resolves each parent from. */
function parentDirOf(relPath: string): string | null {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? null : relPath.slice(0, i);
}
