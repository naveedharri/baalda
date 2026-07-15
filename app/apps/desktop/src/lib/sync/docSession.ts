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
import { presenceUser } from "../presence/color";
import { AttachmentSync } from "./attachments";
import { decideSeed } from "./startup";
import { DocSync, type SyncStatus } from "./syncManager";
import { VaultRegistry } from "./registry";
import { VaultDocStore } from "./vaultDocStore";
import { VaultSyncEngine, type VaultSyncStatus } from "./vaultSyncEngine";

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
  private onStatus?: (status: SyncStatus) => void;
  private attachments: AttachmentSync | null = null;

  // Vault-wide background sync (spec 05): the engine (one WS to /vault-sync)
  // feeds the store, which keeps every authorized doc current on disk without
  // opening it. Present only while sync is enabled.
  private docStore: VaultDocStore | null = null;
  private vaultEngine: VaultSyncEngine | null = null;
  private onVaultStatus?: (status: VaultSyncStatus) => void;

  /** UI subscribes here to render the per-note sync indicator. */
  setStatusListener(cb: ((status: SyncStatus) => void) | undefined): void {
    this.onStatus = cb;
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
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!session.activeOrganizationId) {
      this.enabled = false;
      return { ok: false, reason: "no active organization" };
    }
    this.presence = { id: session.user.id, name: session.user.name || session.user.email };
    try {
      await this.registry.reconcile(
        { organizationId: session.activeOrganizationId, vaultName },
        tree,
      );
      this.enabled = true;
      this.setupAttachments();
      // Initial attachment reconcile (fire-and-forget; errors are logged).
      void this.attachments?.reconcile();
      this.startVaultEngine();
      return { ok: true };
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
    this.stopVaultEngine();
    this.closeCurrent();
  }

  /** UI subscribes here for the vault-wide background-sync indicator. */
  setVaultStatusListener(cb: ((status: VaultSyncStatus) => void) | undefined): void {
    this.onVaultStatus = cb;
  }

  /** Start the always-on background feed for the reconciled vault (spec 05). */
  private startVaultEngine(): void {
    const vaultId = this.registry.vaultId;
    if (!vaultId) return;
    this.stopVaultEngine();
    const store = new VaultDocStore({
      resolvePath: (docId) => this.registry.pathForDocId(docId),
    });
    this.docStore = store;
    this.vaultEngine = new VaultSyncEngine({
      api,
      vaultId,
      sink: store,
      onStatus: (s) => this.onVaultStatus?.(s),
    });
    this.vaultEngine.start();
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
      onStatus: this.onStatus,
    });
    this.current = sync;

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
    }
    if (this.currentLocalAwareness) {
      this.currentLocalAwareness.destroy();
      this.currentLocalAwareness = null;
    }
    // The note is no longer open — let the background feed resume syncing it.
    this.docStore?.setSuppressedDoc(null);
  }

  private applyPresence(awareness: Awareness): void {
    if (!this.presence) return;
    awareness.setLocalStateField(
      "user",
      presenceUser(this.presence.id, this.presence.name),
    );
  }
}

/** Process-wide singleton (parallels `bridgeManager`). */
export const syncManager = new SyncManager();
