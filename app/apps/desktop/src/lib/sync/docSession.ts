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
import type { NoteBridge } from "../bridge";
import { bridgeManager, createTauriBridgeIO } from "../bridge/adapter";
import type { NoteLastEdited, SessionInfo } from "../api";
import * as ipc from "../ipc";
import { api } from "../auth/authManager";
import { colorForUser, presenceUser } from "../presence/color";
import type { ActivityStatus } from "../prefs";
import { AttachmentSync } from "./attachments";
import { ContentUploader, type UploadFailure } from "./contentUpload";
import { runPool } from "./pool";
import { SyncProgressReporter } from "./progress";
import { decideSeed } from "./startup";
import { DocSync, type SyncStatus } from "./syncManager";
import { VaultRegistry, type InboundHost } from "./registry";
import { VaultDocStore, createIpcManifestStore } from "./vaultDocStore";
import {
  vaultScopes,
  type DocSyncState,
  type SyncProgress,
  type VaultScope,
} from "./vaultScope";
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
 * Quiet window before pushing locally-changed (externally-written) notes. Long
 * enough that an AI writing a batch of files coalesces into one run; short
 * enough that a single saved file is on the server within ~a second.
 */
const LOCAL_CHANGE_DEBOUNCE_MS = 800;
/** Re-check interval while a bulk run holds the uploader slot. */
const LOCAL_CHANGE_RETRY_MS = 2_000;
/**
 * How long the download phase may wait for the vault channel's `ready` before
 * the run stops reporting "Syncing…" and admits the channel is unreachable.
 * Generous: a cold 5k-note backfill legitimately takes a while, but its frames
 * flip the engine to `synced`-in-progress long before this elapses; only a
 * socket that never opens gets here.
 */
const CHANNEL_WATCHDOG_MS = 30_000;

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

export class SyncManager implements InboundHost {
  readonly registry = new VaultRegistry(api);

  constructor() {
    // The registry owns the only {relPath → docId} map there is, and the sidebar
    // needs it to badge a row (every sync fact is keyed by docId). Mirror it out
    // reactively — coalesced — instead of letting the UI read it imperatively
    // during render, which never re-rendered when the mapping changed.
    this.registry.setMapListener(() => this.scheduleRegistryMapPublish());
    // Who last edited each note, refreshed by the same registry pull. Not
    // coalesced like the map above: it fires once per pull, not once per note.
    this.registry.setNoteMetaListener((meta) => this.publishNoteMeta(meta));
    // Item colors are a vault-wide fact and ride the same pull (see
    // `VaultRegistry.publishColors`).
    this.registry.setColorListener((colors) => this.publishColors(colors));
    // Inbound reconciliation mutates files the editor and the background doc store
    // may be holding, so it has to be able to make them let go first.
    this.registry.setInboundHost(this);
  }

  private current: DocSync | null = null;
  /** docId of the open networked note (null when none) — the key its per-doc sync
   *  state is reported under. Keyed by docId, never by path. */
  private currentDocId: string | null = null;
  private currentLocalAwareness: Awareness | null = null;
  private enabled = false;
  private presence: { id: string; name: string } | null = null;
  /** The local user's chosen activity status, broadcast via awareness. */
  private status: ActivityStatus = "online";
  private onStatus?: (status: SyncStatus) => void;
  private onPending?: (pending: boolean) => void;
  private onFlushed?: () => void;
  private onRegistryChanged?: () => void;
  private onAclChangedListener?: () => void;
  private onNotePathChanged?: (docId: string, from: string, to: string) => void;
  private onNoteRemoved?: (docId: string, path: string, trashedTo: string | null) => void;
  private onMemberJoined?: (name: string) => void;
  /** Mirrors the registry's {relPath → docId} map to the UI (coalesced). */
  private onRegistryMap?: (map: Record<string, string>) => void;
  /** Mirrors the registry's {docId → last-edit} stamps to the UI. */
  private onNoteMeta?: (meta: Record<string, NoteLastEdited>) => void;
  /** Mirrors the vault's shared {relPath → color id} map to the UI. */
  private onColors?: (colors: Record<string, string>) => void;
  private mapPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private registryPullTimer: ReturnType<typeof setTimeout> | null = null;
  private attachments: AttachmentSync | null = null;
  /** The vault generation everything below belongs to; null while disabled. */
  private scope: VaultScope | null = null;

  // Vault-wide background sync (spec 05): the engine (one WS to /vault-sync)
  // feeds the store, which keeps every authorized doc current on disk without
  // opening it. Present only while sync is enabled.
  private docStore: VaultDocStore | null = null;
  private vaultEngine: VaultSyncEngine | null = null;
  private onVaultStatus?: (status: VaultSyncStatus) => void;

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
  private progress: SyncProgressReporter | null = null;
  private onSyncProgress?: (progress: SyncProgress | null) => void;
  private onDocState?: (patch: Record<string, DocSyncState | null>) => void;
  /** The content upload for the current scope, while one is running. */
  private uploader: ContentUploader | null = null;
  /** Locally-changed MAPPED notes awaiting a content push (docId → relPath):
   *  the watcher saw an external writer (an AI, another editor) change their
   *  .md on disk. Drained by {@link runLocalChangePush}, debounced so a burst
   *  (an AI writing many files) coalesces into one run. */
  private localChanges = new Map<string, string>();
  private localChangeTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Resolves when the current bulk run finishes (tests). */
  private bulkRun: Promise<void> | null = null;

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
  private viewingDocId: string | null = null;
  private onVaultPresence?: (peers: VaultPeer[]) => void;

  /** UI subscribes here to render the connection indicator. */
  setStatusListener(cb: ((status: SyncStatus) => void) | undefined): void {
    this.onStatus = cb;
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

  /** Push the effective status to the UI: an open networked note owns the
   *  indicator; with none open we fall back to the always-on vault channel. */
  private emitStatus(): void {
    const effective = this.current
      ? (this.docStatus ?? this.current.status)
      : this.vaultStatusAsSync();
    this.onStatus?.(effective);
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
          : s === "no-access" || s === "error"
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
  handleRegistryChanged(): void {
    // A signal that arrives once sync is down (or for the vault we just left) must
    // not even ARM the timer — an armed timer is the thing that outlived the switch
    // in the first place. Requiring a live, current scope is strictly stronger than
    // checking `isCurrent()` on a possibly-null one.
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    if (this.registryPullTimer) clearTimeout(this.registryPullTimer);
    this.registryPullTimer = setTimeout(() => {
      this.registryPullTimer = null;
      if (!scope.isCurrent()) return;
      void this.registry
        .pull()
        .then((changed) => {
          if (!scope.isCurrent()) return;
          // Only poke the sidebar when the pull actually changed something it
          // can see. A refresh replaces the tree's row objects, which reads as
          // a flicker under the pointer — needless on the common "nothing new"
          // pull (e.g. the catch-up pull every reconnect now makes).
          if (changed) this.onRegistryChanged?.();
          this.settleAfterPull(scope);
        })
        .catch((e) => console.warn("[sync] registry pull failed", e));
    }, 250);
  }

  /** True while a debounced registry pull is still armed (teardown assertions). */
  hasPendingRegistryPull(): boolean {
    return this.registryPullTimer != null;
  }

  /**
   * One watcher `files-changed` BATCH, minus the open note (App routes the open
   * note's events into its bridge, whose own provider pushes).
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
   *  - a removal → nothing. Deleting a server note stays an explicit act (UI or
   *    MCP): auto-propagating disk deletions would let `git checkout`-style tree
   *    churn delete a team's notes.
   */
  handleLocalFilesChanged(
    changes: ReadonlyArray<{ path: string; kind: "modified" | "removed" | "tree" }>,
  ): void {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    // ONE registry pull for the whole batch, however many items ask for it. The
    // watcher already debounces into batches, and an AI writing 200 new files
    // used to re-enter `handleRegistryChanged` 200 times per batch — 200 timer
    // teardowns for the single pull that was always going to happen.
    let pullRegistry = false;
    for (const { path: relPath, kind } of changes) {
      if (kind === "removed") continue;
      if (kind === "tree") {
        pullRegistry = true;
        continue;
      }
      const mapping = this.registry.getMapping(relPath);
      if (!mapping) {
        pullRegistry = true;
        continue;
      }
      // Belt and braces with the uploader's own `skip`: the open note's editor
      // session owns its provider, and its bridge already ingests watcher events.
      if (this.docStore?.suppressedDoc() === mapping.docId) continue;
      // The file has new bytes, so two verdicts about its OLD bytes are void: an
      // empty placeholder may now hold text, and an oversized file may have been
      // trimmed under the ceiling. Both get a fresh push.
      this.emptyEverywhere.delete(mapping.docId);
      this.permanentFailures.delete(mapping.docId);
      this.localChanges.set(mapping.docId, relPath);
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
    if (pullRegistry) this.handleRegistryChanged();
  }

  /** Single-event form of {@link handleLocalFilesChanged}, for call sites that
   *  see one change at a time. */
  handleLocalFileChanged(relPath: string, kind: "modified" | "removed" | "tree"): void {
    this.handleLocalFilesChanged([{ path: relPath, kind }]);
  }

  private armLocalChangeDrain(scope: VaultScope, delayMs: number): void {
    if (this.localChangeTimer) clearTimeout(this.localChangeTimer);
    this.localChangeTimer = setTimeout(() => {
      this.localChangeTimer = null;
      if (!scope.isCurrent()) return;
      // A bulk run (enable's backfill, or a settle pass) is single-writer on the
      // uploader slot AND may be about to push these very docs. Wait it out; the
      // queue survives, so nothing is dropped.
      if (this.uploader?.isRunning()) {
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
    if (!vaultId || !store || !progress) return;
    const notes = [...this.localChanges].map(([docId, relPath]) => ({ docId, relPath }));
    this.localChanges.clear();
    if (notes.length === 0) return;

    const uploader: ContentUploader = new ContentUploader({
      vaultId,
      notes,
      deps: {
        acquire: (docId, relPath) =>
          store.promote(docId, relPath, {
            seedFromFile: false, // pull-before-seed, exactly like the bulk run
            markRecent: true, // an externally-edited note is genuinely recent
            pin: true,
          }),
        release: (docId) => store.demote(docId),
        connect: ({ docId, vaultId: collectionId, doc }) =>
          new DocSync({ api, doc, docId, vaultId: collectionId }),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
      },
      isPushed: (docId) => this.registry.isPushed(docId),
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.divergedDocs.delete(docId); // its local-only ops are now on the server
      },
      skip: (docId) => store.suppressedDoc() === docId,
      force: true,
      ingestFromFile: true,
      mustConnect: (docId) => this.divergedDocs.has(docId),
      progress,
      shouldStop: (): boolean => !scope.isCurrent() || this.uploader !== uploader,
    });
    this.uploader = uploader;

    const result = await uploader.run();
    if (!scope.isCurrent() || this.uploader !== uploader) return;
    this.recordPermanentFailures(uploader);
    await this.registry.flushCheckpoint();
    if (!scope.isCurrent() || this.uploader !== uploader) return;
    if (result.cancelled) return;
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
    //    want: for a rename they then travel with the file, and for a trash they
    //    end up in the trashed copy. Nothing is lost, and nothing is written back
    //    AFTER the move.
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

  noteRemoved(docId: string, path: string, trashedTo: string | null): void {
    this.onNoteRemoved?.(docId, path, trashedTo);
  }

  /** Called after an inbound rename lands on disk (store re-points the editor). */
  setInboundListeners(listeners: {
    onNotePathChanged?: (docId: string, from: string, to: string) => void;
    onNoteRemoved?: (docId: string, path: string, trashedTo: string | null) => void;
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
    // A live run will reach its own terminal phase and will pick up whatever the
    // pull added, because the queue is rebuilt from `mappedNotes()` minus the
    // pushed set. Restarting it here instead would let a busy team's structural
    // churn abandon the initial backfill over and over.
    if (this.uploader?.isRunning()) return;
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
    if (this.uploader?.isRunning()) return;
    // The `ready.empty` list is still being checked against disk. Starting now
    // would queue every named doc — including the empty placeholders the probe
    // is about to settle — so the probe's completion re-enters here instead.
    if (this.emptyProbe) return;
    const engine = this.vaultEngine;
    if (engine && !engine.backfillSettled()) return;
    if (this.contentWorkList().length === 0) {
      // Nothing to send. Stamp a terminal phase once, and only once: this edge
      // fires again on every drained inbound frame (a teammate typing), and
      // re-stamping `done` there would be a store write per keystroke.
      const phase = this.progress?.snapshot().phase;
      const stalled = this.channelStalled;
      this.channelStalled = false;
      if (phase !== "done" && (phase !== "error" || stalled)) this.completeRun(scope);
      return;
    }
    this.bulkRun = this.runBulkSync(scope).catch((e) => {
      console.warn("[sync] content sync failed", e);
    });
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
          (!this.registry.isPushed(n.docId) || this.serverEmpty.has(n.docId)),
      );
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
          empty = await this.registry.isNoteEmptyOnDisk(relPath);
        } catch {
          empty = false; // unreadable ⇒ let the run try (and report) it
        }
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
      { concurrency: 8, shouldStop: () => !scope.isCurrent() },
    ).then(() => {
      if (!scope.isCurrent()) return;
      this.serverEmpty = keep;
      this.progress?.flush();
    });
  }

  /** Remember the run's permanent failures so later runs neither re-queue nor
   *  forget them (each run builds a fresh uploader with an empty failure list). */
  private recordPermanentFailures(uploader: ContentUploader): void {
    for (const f of uploader.failedDocs()) {
      if (f.permanent) this.permanentFailures.set(f.docId, f);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The vault scope this session is running under (null when disabled). */
  currentScope(): VaultScope | null {
    return this.scope;
  }

  /** True if opening `relPath` will connect a network provider. */
  willSync(relPath: string): boolean {
    return this.enabled && this.registry.getMapping(relPath) != null;
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
  ): Promise<{ ok: boolean; reason?: string; seeded?: boolean; scope?: VaultScope }> {
    if (!session.activeOrganizationId) {
      this.disable();
      return { ok: false, reason: "no active organization" };
    }
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
    const progress = new SyncProgressReporter({
      onProgress: (p) => this.onSyncProgress?.(p),
      onDocState: (patch) => this.onDocState?.(patch),
    });
    this.progress = progress;
    // The registry writes into the SHARED reporter, but its COUNTERS are muted
    // while a content run or the download phase owns the pill: a pull that lands
    // mid-run re-stamps `registering` with its own (tiny) total while the
    // uploader keeps ticking `done` against it — which once rendered the header
    // as "Syncing 585/164". Per-doc badge states stay through in all cases:
    // they are keyed by docId, so concurrent writers cannot garble them.
    const counterOwned = (): boolean =>
      (this.uploader?.isRunning() ?? false) || this.downloadPhase;
    this.registry.setProgressSink({
      phase: (p, t) => {
        if (!counterOwned()) progress.phase(p, t);
      },
      addTotal: (n) => {
        if (!counterOwned()) progress.addTotal(n);
      },
      item: (o) => {
        if (!counterOwned()) progress.item(o);
      },
      doc: (docId, state) => progress.doc(docId, state),
      flush: () => progress.flush(),
    });
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
   * User-triggered "sync now": re-pull the registry and re-run the content pass,
   * so notes stranded by a transient failure get another chance without a
   * sign-out/relaunch. Backs the sync pill's retry button.
   *
   * No-op while a run is already in flight — that run will pick everything up.
   */
  async retrySync(): Promise<void> {
    const scope = this.scope;
    if (!this.enabled || !scope || !scope.isCurrent()) return;
    if (this.uploader?.isRunning()) return;
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
          new DocSync({ api, doc, docId, vaultId: collectionId }),
        readFile: (relPath) => ipc.readNote(relPath, scope.vaultEpoch),
      },
      isPushed: (docId) => this.registry.isPushed(docId),
      // The server's word beats our checkpoint: a doc it holds no content for is
      // queued even when `pushed` claims it, which is the only way a note
      // stranded by a crashed run (or a restored `.context/`) is ever recovered.
      include: (docId) => this.serverEmpty.has(docId),
      // …and it goes FIRST. Those notes have nothing at all on the server, so if
      // the run is cut short they are the work that had to happen.
      priority: (docId) => this.serverEmpty.has(docId),
      markPushed: (docId) => {
        this.registry.markPushed(docId);
        this.divergedDocs.delete(docId); // a confirmed push carries any merged ops
        this.serverEmpty.delete(docId); // the server has its content now
      },
      // Never touch the open note: its editor session owns a provider for that doc.
      skip: (docId) => store.suppressedDoc() === docId,
      progress,
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
    // but only after a run that actually SENT something and failed nothing,
    // otherwise a server that keeps naming docs we cannot push would spin the
    // socket in a tight hello/ready loop.
    if (this.serverEmptyTruncated && result.pushed > 0 && result.failed === 0) {
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
    // deliberately no `backfillSettled()` short-circuit here any more: an engine
    // that has not connected yet reports settled (nothing is queued and no window
    // is open), so checking it here would end the phase before it began.
    progress.phase("downloading", total - done);
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
    if (!this.downloadPhase || !scope.isCurrent()) return;
    const progress = this.progress;
    if (!progress) return;
    if (total > this.lastInboundTotal) {
      progress.addTotal(total - this.lastInboundTotal);
      this.lastInboundTotal = total;
    }
    for (let i = this.lastInboundDone; i < done; i++) progress.item("ok");
    this.lastInboundDone = done;
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
    const progress = this.progress;
    if (!progress) return;
    this.downloadPhase = false;
    this.channelStalled = false;
    this.clearChannelWatchdog();
    const uploadFailures = this.uploader?.failedDocs().length ?? 0;
    const clean =
      uploadFailures === 0 &&
      this.permanentFailures.size === 0 &&
      !this.registry.hasFailures() &&
      this.registry.limitCode() == null;
    progress.phase(clean ? "done" : "error");
    progress.flush();
  }

  /** Everything the current run could not sync — registry rows and note content. */
  syncFailures(): {
    registry: ReturnType<VaultRegistry["failures"]>;
    content: Array<{ docId: string; relPath: string; reason: string }>;
    limitCode: string | null;
  } {
    // Permanent failures are remembered across runs (see the field), so they are
    // reported from there; the live uploader's list covers this run's transient
    // ones. A doc in both is listed once.
    const content = [...this.permanentFailures.values()];
    const seen = new Set(content.map((f) => f.docId));
    for (const f of this.uploader?.failedDocs() ?? []) {
      if (!seen.has(f.docId)) content.push(f);
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
    this.presence = null;
    this.viewingDocId = null;
    this.vaultStatus = "idle";
    // Timers first: a timer that fires after we've cleared the state below would
    // still see a live `registry`/`attachments` and act on the wrong vault.
    if (this.registryPullTimer) {
      clearTimeout(this.registryPullTimer);
      this.registryPullTimer = null;
    }
    if (this.localChangeTimer) {
      clearTimeout(this.localChangeTimer);
      this.localChangeTimer = null;
    }
    this.localChanges.clear();
    this.divergedDocs.clear();
    // Scoped to the vault like everything else here: another vault's empty-doc
    // list would put ITS doc ids at the head of this vault's upload queue.
    this.serverEmpty.clear();
    this.serverEmptyTruncated = false;
    this.emptyEverywhere.clear();
    this.permanentFailures.clear();
    this.emptyProbe = null; // a probe still in flight sees a stale scope and drops
    // The bulk run before the engine it borrows from: `stop()` makes every pool
    // lane drop at its next checkpoint, so nothing is still promoting a bridge
    // when `stopVaultEngine` destroys the store underneath it.
    this.uploader?.stop();
    this.uploader = null;
    this.bulkRun = null;
    this.downloadPhase = false;
    this.clearChannelWatchdog();
    this.channelStalled = false;
    this.lastInboundDone = 0;
    this.lastInboundTotal = 0;
    this.attachments?.stop();
    this.attachments = null;
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

  /** Record which note this client is now viewing (null = none) and broadcast it. */
  setViewing(docId: string | null): void {
    this.viewingDocId = docId;
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

  /** Send our current viewing state over the vault channel. Invisible users
   *  broadcast a null doc so they don't appear on teammates' sidebars. */
  private pushLocalPresence(): void {
    if (!this.vaultEngine || !this.presence) return;
    const docId = this.status === "invisible" ? null : this.viewingDocId;
    this.vaultEngine.setPresence({
      docId,
      name: this.presence.name,
      color: colorForUser(this.presence.id),
      status: this.status,
    });
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
    this.stopVaultEngine();
    // Reflect "connecting" the moment we switch into a vault, so the light
    // moves off a stale value before the socket reports back.
    this.vaultStatus = "connecting";
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
    this.vaultEngine = new VaultSyncEngine({
      api,
      vaultId,
      sink: store,
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
        if (s === "synced") this.handleRegistryChanged();
      },
      // An ACL change in this vault may have flipped the open note's grant
      // (view↔edit, lock/unlock). Re-mint its token so the editor becomes
      // read-only/editable live — no reopen (spec 04 §4).
      onAclChanged: () => {
        // Two things follow from "the ACL moved". The open note re-mints its
        // token so a view<->edit flip lands live...
        this.current?.refreshAccess();
        // ...and the registry gets re-pulled, because the readable SET may have
        // changed too. That pull is what removes a note this user just lost
        // access to from their disk, and without it the removal would wait for
        // the next structural change or an app restart - long enough to look
        // like the revocation hadn't worked.
        this.handleRegistryChanged();
        // ...and the UI's lock overlay refreshes, so the NEXT open of a
        // just-locked note starts read-only from its first frame.
        this.onAclChangedListener?.();
      },
      // A teammate changed the folder/note structure — re-pull + refresh tree.
      onRegistryChanged: () => this.handleRegistryChanged(),
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
    });
    this.vaultEngine.start();
    // Seed our own presence into the fresh engine (it flushes on `ready`).
    this.pushLocalPresence();
  }

  private stopVaultEngine(): void {
    this.vaultEngine?.stop();
    this.vaultEngine = null;
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
   * Handle a watcher `file-changed` event under `attachments/`: schedule a
   * debounced two-way reconcile. Attachments never touch the CRDT pipeline.
   */
  handleAttachmentChanged(): void {
    if (!this.enabled) return;
    this.attachments?.scheduleReconcile();
  }

  /** Build the AttachmentSync from the reconciled server vault id + ipc/api.
   *  Bound to `scope`: the captured `vaultId` is only valid while that vault is
   *  open, so both the pass guard and the pinned IPC epoch reference it. */
  private setupAttachments(scope: VaultScope): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) {
      this.attachments = null;
      return;
    }
    const epoch = scope.vaultEpoch;
    this.attachments = new AttachmentSync({
      isCurrent: () => scope.isCurrent(),
      listLocal: () => ipc.listAttachments(epoch),
      readLocal: (relPath) => ipc.readBinaryFile(relPath, epoch),
      writeLocal: (relPath, bytes) => ipc.writeBinaryFile(relPath, bytes, epoch),
      listServer: () => api.listVaultBlobs(vaultId),
      uploadServer: (relPath, bytes, mime) =>
        api
          .uploadBlob({ vaultId, relPath, bytes, mime, fileName: baseName(relPath) })
          .then(() => undefined),
      downloadServer: (id) => api.downloadBlob(id),
    });
  }

  /**
   * Open a doc-session for a freshly-opened bridge. Assumes the caller opened the
   * bridge with `seedFromFile: !willSync(relPath)`.
   */
  async openDoc(bridge: NoteBridge, relPath: string): Promise<OpenedDoc> {
    this.closeCurrent();

    const mapping = this.enabled ? this.registry.getMapping(relPath) : null;
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

    const sync = new DocSync({
      api,
      doc: bridge.doc,
      docId: mapping.docId,
      vaultId: mapping.vaultId,
      onStatus: (s) => this.handleDocStatus(s),
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
      (!scope || scope.isCurrent()) && this.current === sync && !!this.enabled;
    // Up to 5s of waiting — easily long enough to span a vault switch. Seeding
    // then would read the NEW vault's file at this path into the OLD vault's doc.
    await sync.whenSynced(5000);
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
