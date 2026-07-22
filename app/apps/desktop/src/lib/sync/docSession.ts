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
import type { SessionInfo } from "../api";
import type { TreeNode } from "../ipc";
import * as ipc from "../ipc";
import { api } from "../auth/authManager";
import { colorForUser, presenceUser } from "../presence/color";
import type { ActivityStatus } from "../prefs";
import { AttachmentSync } from "./attachments";
import { decideSeed } from "./startup";
import { DocSync, type SyncStatus } from "./syncManager";
import { VaultRegistry } from "./registry";
import { VaultDocStore } from "./vaultDocStore";
import {
  VaultSyncEngine,
  type VaultPeer,
  type VaultSyncStatus,
} from "./vaultSyncEngine";

/** Basename of a vault-relative path (for the upload's x-file-name hint). */
function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

export interface OpenedDoc {
  awareness: Awareness;
  sync: DocSync | null;
  readOnly: boolean;
  status: SyncStatus;
}

export class SyncManager {
  readonly registry = new VaultRegistry(api);

  private current: DocSync | null = null;
  private currentLocalAwareness: Awareness | null = null;
  private enabled = false;
  private presence: { id: string; name: string } | null = null;
  /** The local user's chosen activity status, broadcast via awareness. */
  private status: ActivityStatus = "online";
  private onStatus?: (status: SyncStatus) => void;
  private onPending?: (pending: boolean) => void;
  private onFlushed?: () => void;
  private onRegistryChanged?: () => void;
  private onMemberJoined?: (name: string) => void;
  private registryPullTimer: ReturnType<typeof setTimeout> | null = null;
  private attachments: AttachmentSync | null = null;

  // Vault-wide background sync (spec 05): the engine (one WS to /vault-sync)
  // feeds the store, which keeps every authorized doc current on disk without
  // opening it. Present only while sync is enabled.
  private docStore: VaultDocStore | null = null;
  private vaultEngine: VaultSyncEngine | null = null;
  private onVaultStatus?: (status: VaultSyncStatus) => void;

  // The UI shows ONE connection indicator, but two things can drive it: the
  // open note's provider (authoritative for that doc, incl. read-only grants)
  // and the always-on vault channel (connects the instant a workspace opens,
  // before any note). We track both and emit the effective status so switching
  // workspaces lights up presence immediately — not only once a note is opened.
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

  /** Record the open note's provider status and re-emit the effective status. */
  private handleDocStatus(s: SyncStatus): void {
    this.docStatus = s;
    this.emitStatus();
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
   * UI subscribes here to react when a new teammate joins the workspace: refresh
   * the roster (so the member list updates without a reload) and celebrate.
   */
  setMemberJoinedListener(cb: ((name: string) => void) | undefined): void {
    this.onMemberJoined = cb;
  }

  /**
   * A `registry` signal arrived from the vault channel. Debounce a re-pull (a
   * burst of changes — e.g. a folder move rewriting many rows — coalesces into
   * one), then tell the UI to refresh the tree.
   */
  private handleRegistryChanged(): void {
    if (this.registryPullTimer) clearTimeout(this.registryPullTimer);
    this.registryPullTimer = setTimeout(() => {
      this.registryPullTimer = null;
      void this.registry
        .pull()
        .then(() => this.onRegistryChanged?.())
        .catch((e) => console.warn("[sync] registry pull failed", e));
    }, 250);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** True if opening `relPath` will connect a network provider. */
  willSync(relPath: string): boolean {
    return this.enabled && this.registry.getMapping(relPath) != null;
  }

  /**
   * Enable networked sync for a vault: reconcile the registry so doc_ids are
   * shared across devices, and remember the presence identity. Requires an
   * active organization; a no-op (disabled) otherwise.
   */
  async enable(
    session: SessionInfo,
    tree: TreeNode,
    vaultName: string,
  ): Promise<{ ok: boolean; reason?: string; seeded?: boolean }> {
    if (!session.activeOrganizationId) {
      this.enabled = false;
      return { ok: false, reason: "no active organization" };
    }
    this.presence = { id: session.user.id, name: session.user.name || session.user.email };
    try {
      const { seeded } = await this.registry.reconcile(
        { organizationId: session.activeOrganizationId, vaultName },
        tree,
      );
      this.enabled = true;
      this.setupAttachments();
      // Initial attachment reconcile (fire-and-forget; errors are logged).
      void this.attachments?.reconcile();
      this.startVaultEngine();
      return { ok: true, seeded };
    } catch (e) {
      this.enabled = false;
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Sign-out / vault-switch: stop networked sync. */
  disable(): void {
    this.enabled = false;
    this.presence = null;
    this.attachments = null;
    this.viewingDocId = null;
    this.vaultStatus = "idle";
    this.clearVaultPresence();
    this.stopVaultEngine();
    this.closeCurrent();
    // closeCurrent only emits when a note was open; make sure a note-less
    // disable (e.g. switching to a local workspace) still drops to offline.
    this.emitStatus();
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

  /** Record which note this client is now viewing (null = none) and broadcast it. */
  setViewing(docId: string | null): void {
    this.viewingDocId = docId;
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
  private startVaultEngine(): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) return;
    this.stopVaultEngine();
    // Reflect "connecting" the moment we switch into a workspace, so the light
    // moves off a stale value before the socket reports back.
    this.vaultStatus = "connecting";
    if (!this.current) this.emitStatus();
    const store = new VaultDocStore({
      resolvePath: (docId) => this.registry.pathForDocId(docId),
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
      },
      // An ACL change in this vault may have flipped the open note's grant
      // (view↔edit, lock/unlock). Re-mint its token so the editor becomes
      // read-only/editable live — no reopen (spec 04 §4).
      onAclChanged: () => this.current?.refreshAccess(),
      // A teammate changed the folder/note structure — re-pull + refresh tree.
      onRegistryChanged: () => this.handleRegistryChanged(),
      // A new teammate joined the workspace — refresh roster + celebrate.
      onMemberJoined: (name) => this.onMemberJoined?.(name),
      // A teammate's viewing state changed — update the sidebar presence roster.
      onPresence: (peer) => this.handleVaultPresence(peer),
    });
    this.vaultEngine.start();
    // Seed our own presence into the fresh engine (it flushes on `ready`).
    this.pushLocalPresence();
  }

  private stopVaultEngine(): void {
    this.vaultEngine?.stop();
    this.vaultEngine = null;
    void this.docStore?.destroyAll();
    this.docStore = null;
  }

  /**
   * Handle a watcher `file-changed` event under `attachments/`: schedule a
   * debounced two-way reconcile. Attachments never touch the CRDT pipeline.
   */
  handleAttachmentChanged(): void {
    if (!this.enabled) return;
    this.attachments?.scheduleReconcile();
  }

  /** Build the AttachmentSync from the reconciled server vault id + ipc/api. */
  private setupAttachments(): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) {
      this.attachments = null;
      return;
    }
    this.attachments = new AttachmentSync({
      listLocal: () => ipc.listAttachments(),
      readLocal: (relPath) => ipc.readBinaryFile(relPath),
      writeLocal: (relPath, bytes) => ipc.writeBinaryFile(relPath, bytes),
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
    // Take over the indicator from the vault channel right away with the
    // provider's initial status (it fires again as the socket progresses).
    this.docStatus = sync.status;
    this.emitStatus();

    // INSTANT OPEN (spec 05 §1): we no longer BLOCK the editor on the initial
    // server sync. Vault-wide background sync has almost always already brought
    // this doc's CRDT current in local SQLite, so the bridge hydrated with real
    // content and the editor renders it immediately. The pull-before-seed rule
    // (spec 03 §5) still holds — we just run it off the critical path: wait for
    // the provider's first sync, THEN seed only a genuine orphan.
    void this.seedOrphanAfterSync(sync, bridge);

    this.applyPresence(sync.awareness);
    return {
      awareness: sync.awareness,
      sync,
      readOnly: sync.readOnly,
      status: sync.status,
    };
  }

  /** Background half of pull-before-seed: never blocks the editor (spec 05 §1). */
  private async seedOrphanAfterSync(sync: DocSync, bridge: NoteBridge): Promise<void> {
    await sync.whenSynced(5000);
    const decision = decideSeed({
      signedIn: true,
      serverSynced: true, // past whenSynced (real sync or its offline timeout)
      docEmpty: bridge.serialize().length === 0,
      fileHasContent: true, // seedFromFileIfEmpty is a no-op when the file is empty
    });
    if (decision.action === "seed-from-file") {
      await bridge.seedFromFileIfEmpty();
    }
  }

  currentSync(): DocSync | null {
    return this.current;
  }

  closeCurrent(): void {
    if (this.current) {
      this.current.destroy();
      this.current = null;
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
