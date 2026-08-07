// Vault ↔ server registry reconciliation (spec 03 §5 "doc registry mapping").
//
// On vault-connect (signed in, with an active org) we make the server aware of
// this vault's folders and notes so that `doc_id`s are STABLE and SHARED across
// devices. We adopt existing server rows by path, and for anything missing we
// create it USING THE LOCAL INDEX doc_id (the server honours a supplied id) so a
// note keeps one identity across its .md file, the local CRDT store, and the
// server. The resulting {relPath → {vaultId, docId}} map is what the sync layer
// uses to name Hocuspocus documents.
//
// The mapping is persisted to the vault's own `.context/config.json` (via ipc),
// so it travels with the vault, not the app profile.
//
// Bulk behaviour (phase 2). Registering a large vault is a bounded, checkpointed,
// cancellable, honest operation:
//   • bounded — folders (level by level, parents first) and notes go through a
//     `runPool` at `REGISTRY_CONCURRENCY`, not a sequential await-in-a-loop;
//   • checkpointed — the doc-id map is flushed incrementally (`Checkpointer`), so
//     a kill -9 at note 200/500 keeps the first 200 and the next run resumes;
//   • cancellable — every lane re-checks the VaultScope before each item;
//   • honest — a per-item failure is retried with backoff and then RECORDED
//     (`failures()`), so a vault with failures can never report fully synced.

import {
  ApiClient,
  ApiError,
  noteDocId,
  noteRelPath,
  vaultOrgId,
  type RegisteredFolder,
} from "../api";
import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";
import { seedWelcomeContent } from "../vault/seed";
import { Checkpointer } from "./checkpoint";
import { REGISTRY_CONCURRENCY, runPool, withRetry } from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";
import { vaultScopes, type VaultScope, type VaultScopeSource } from "./vaultScope";

export interface DocMapping {
  vaultId: string;
  docId: string;
}

interface VaultSyncConfig {
  serverVaultId?: string;
  /** relPath → server docId (notes). */
  docs?: Record<string, string>;
  /** folder relPath → server folder id. */
  folders?: Record<string, string>;
  /**
   * docIds whose CONTENT this device has confirmed on the server (the bulk
   * upload's resume point — see `ContentUploader`).
   *
   * Purely an optimization: it lets a relaunch skip re-connecting every note in
   * the vault. Correctness never depends on it, because the upload path is
   * idempotent by construction (pull-before-seed; it only ever transmits CRDT
   * state that already exists locally, never re-inserts text). A missing or
   * stale entry therefore costs a round trip, never duplicated content.
   */
  pushed?: string[];
}

export interface ReconcileInput {
  /** Active organization to create the vault under (required to create). */
  organizationId: string;
  /** Display name for a newly created server vault. */
  vaultName: string;
}

/** A folder/note that could NOT be registered, after retries. Surfaced so the
 *  vault is never reported fully synced while an arbitrary subset is local-only. */
export interface RegistryFailure {
  kind: "folder" | "note" | "materialize";
  /** Vault-relative path. */
  path: string;
  /** Intended docId, when known (notes) — phase 3 keys its badge by this. */
  docId: string | null;
  reason: string;
  /** Server error code when it carried one (`vault_limit_reached`, …). */
  code: string | null;
}

/** Extensions treated as editable notes (reconciled to the server `notes` set).
 *  Images/PDFs surface in the tree but sync as embedded attachments, not notes. */
const NOTE_EXTS = ["md", "markdown", "mdx", "txt", "html", "htm", "canvas"];
function isNoteFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && NOTE_EXTS.includes(ext);
}

/** Flatten a tree into folder paths and note paths (both vault-relative). */
export function flattenTree(root: TreeNode): { folders: TreeNode[]; notes: TreeNode[] } {
  const folders: TreeNode[] = [];
  const notes: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.isDir) {
      if (n.path) folders.push(n); // skip the root (empty path)
      for (const c of n.children ?? []) walk(c);
    } else if (isNoteFile(n.path)) {
      notes.push(n); // only text/note files become server notes
    }
  };
  walk(root);
  // Parents before children so folder parentId links resolve.
  folders.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  return { folders, notes };
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Server error `code` field, when the body carried one. */
function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * "Retrying this can never help."
 *
 * Any 4xx is the server telling us the REQUEST is wrong, not that it was
 * unlucky: 402 = a plan limit (`vault_limit_reached` / `member_limit_reached`),
 * 403 = no grant, 409 = this doc_id already belongs to another vault. Those must
 * be surfaced immediately rather than retried forever. 5xx and network failures
 * (no `ApiError` at all) are the retryable ones.
 */
function isTerminalApiError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

function reasonOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.status}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class VaultRegistry {
  private serverVaultId: string | null = null;
  private byPath = new Map<string, DocMapping>();
  /** Reverse of byPath: docId → relPath, for the vault sync engine (spec 05). */
  private byDocId = new Map<string, string>();
  private folderByPath = new Map<string, string>();
  /** docIds whose content this device has confirmed on the server. See
   *  `VaultSyncConfig.pushed` for why this is an optimization, not a guarantee. */
  private pushed = new Set<string>();
  /** Everything that could not be registered in the last run. */
  private failed: RegistryFailure[] = [];
  /** Set when the server refused on a plan limit: the rest of the run is
   *  pointless (every further create would 402 too), so it stops. */
  private limitReached: string | null = null;

  /**
   * The scope this registry's *contents* belong to: `serverVaultId` and the path
   * maps were all resolved for THAT vault. Bound by `reconcile`, dropped by
   * `reset`. Null means "not bound" — nothing reconciled yet, or no scope manager
   * scope at all (unit tests), which keeps the legacy unguarded behaviour.
   *
   * It is deliberately NOT re-read from `scopes.current()` per operation. Doing
   * that defeats the entire guard: the debounced `pull()` fires *after* a vault
   * switch, so `current()` is already the NEW vault while `serverVaultId` still
   * holds the OLD one — which is precisely the merge this class exists to
   * prevent. The question is never "what vault is open now" but "is the vault my
   * data came from still the open one".
   */
  private bound: VaultScope | null = null;

  /**
   * Coalesced writer for `.context/config.json`. Recreated per `reconcile` and
   * disposed by `reset()` — disposal is synchronous precisely so a queued flush
   * can't snapshot the vault we left and write it into the one we just opened.
   */
  private checkpoint: Checkpointer<VaultSyncConfig> | null = null;

  /**
   * Notified whenever the {relPath → docId} map changes.
   *
   * This map is the ONLY place a sidebar path and a note's docId meet, and every
   * sync fact (`docSyncState`) is keyed by docId — so the UI needs it to badge a
   * row. It used to be read imperatively from `getMapping()` during render, which
   * is not reactive: rows kept a stale badge until something else re-rendered
   * them. The listener (owned by `SyncManager`, which coalesces it) replaces that.
   *
   * Owned for the process lifetime, so `reset()` deliberately does NOT clear it —
   * a vault switch has to be *published* as "no mapped notes", not go silent.
   */
  private onMapChanged: (() => void) | null = null;

  constructor(
    private readonly api: ApiClient,
    /** Where the current VaultScope comes from; injectable for tests. */
    private readonly scopes: VaultScopeSource = vaultScopes,
    /** Progress reporting; a no-op sink by default (unit tests). */
    private progress: SyncProgressSink = nullProgressSink,
  ) {}

  get vaultId(): string | null {
    return this.serverVaultId;
  }

  /** Point the registry at a progress sink (SyncManager, per vault scope). */
  setProgressSink(sink: SyncProgressSink): void {
    this.progress = sink;
  }

  /** Subscribe to {relPath → docId} changes (see {@link onMapChanged}). */
  setMapListener(cb: (() => void) | null): void {
    this.onMapChanged = cb;
  }

  /** Announce a change to the path→docId map. Fired freely (once per adopted or
   *  created note); the listener is responsible for coalescing. */
  private notifyMapChanged(): void {
    this.onMapChanged?.();
  }

  /**
   * Forget everything about the vault this registry was reconciled against.
   * MUST be called on every vault switch / disable: this instance is a process
   * singleton, so a surviving `serverVaultId` + path maps are exactly what let
   * vault A's server ids be applied to vault B's tree.
   */
  reset(): void {
    // Synchronously first: a pending flush must never outlive the vault.
    this.checkpoint?.dispose();
    this.checkpoint = null;
    this.serverVaultId = null;
    this.byPath.clear();
    this.byDocId.clear();
    this.folderByPath.clear();
    this.pushed.clear();
    this.failed = [];
    this.limitReached = null;
    this.bound = null;
    this.progress = nullProgressSink;
  }

  /** True when this registry's contents belong to a vault that is no longer the
   *  open one. Bail silently — "the user moved on" is not an error. */
  private stale(): boolean {
    return this.bound != null && !this.bound.isCurrent();
  }

  /**
   * Where to report progress. Silenced once this registry's contents are stale.
   *
   * This class is a process singleton, so a newer `enable` for ANOTHER vault will
   * already have replaced `this.progress` with that vault's reporter by the time a
   * reconcile for the vault we left reaches its next checkpoint. Emitting through
   * the raw field would then pour vault A's counts into vault B's progress bar.
   */
  private get sink(): SyncProgressSink {
    return this.stale() ? nullProgressSink : this.progress;
  }

  /** `expectedEpoch` to pin vault-relative IPC to: the epoch of the vault these
   *  contents came from, so Rust refuses any call that outlives it. */
  private epoch(): number | null {
    return this.bound?.vaultEpoch ?? null;
  }

  /** Server doc mapping for a note's vault-relative path, if registered. */
  getMapping(relPath: string): DocMapping | null {
    return this.byPath.get(relPath) ?? null;
  }

  /** Vault-relative path for a docId, if mapped (reverse of getMapping). */
  pathForDocId(docId: string): string | null {
    return this.byDocId.get(docId) ?? null;
  }

  /** All mapped doc ids (for the vault sync engine's initial doc set). */
  allDocIds(): string[] {
    return [...this.byDocId.keys()];
  }

  /** Every mapped note as {docId, relPath} — the bulk upload's work list. */
  mappedNotes(): Array<{ docId: string; relPath: string }> {
    return [...this.byDocId].map(([docId, relPath]) => ({ docId, relPath }));
  }

  /** Server folder id for a folder's vault-relative path, if registered. */
  getFolderId(relPath: string): string | null {
    return this.folderByPath.get(relPath) ?? null;
  }

  // ---- content-push checkpoint (resume point for the bulk upload) ---------

  /** Has this device confirmed `docId`'s content on the server? */
  isPushed(docId: string): boolean {
    return this.pushed.has(docId);
  }

  /** Record that `docId`'s content is on the server (checkpointed, batched). */
  markPushed(docId: string): void {
    if (this.pushed.has(docId)) return;
    this.pushed.add(docId);
    this.checkpoint?.touch();
  }

  /** Flush any owed checkpoint now (end of a phase / before teardown). */
  async flushCheckpoint(): Promise<void> {
    await this.checkpoint?.flush();
  }

  /** Completed config.json writes (tests: "did we checkpoint incrementally?"). */
  checkpointWrites(): number {
    return this.checkpoint?.writes ?? 0;
  }

  // ---- failure reporting --------------------------------------------------

  /** Everything that could not be registered in the last reconcile/pull. */
  failures(): RegistryFailure[] {
    return [...this.failed];
  }

  hasFailures(): boolean {
    return this.failed.length > 0;
  }

  /** The plan-limit code that stopped the run, if one did. */
  limitCode(): string | null {
    return this.limitReached;
  }

  private recordFailure(f: RegistryFailure): void {
    this.failed.push(f);
    if (f.code === "vault_limit_reached" || f.code === "member_limit_reached") {
      this.limitReached = f.code;
    }
    if (f.docId) this.sink.doc(f.docId, "error");
    console.warn(`[registry] ${f.kind} ${f.path} failed — ${f.reason}`);
  }

  /** Stop the current bulk run? Either the vault moved on, or the server told us
   *  we've hit a plan limit and every further create would 402 as well. */
  private stopRun(): boolean {
    return this.stale() || this.limitReached != null;
  }

  // ---- config.json -------------------------------------------------------

  private async loadConfig(): Promise<VaultSyncConfig> {
    try {
      const raw = await ipc.getVaultConfig(this.epoch());
      if (!raw) return {};
      return JSON.parse(raw) as VaultSyncConfig;
    } catch {
      return {};
    }
  }

  /** The value the checkpointer writes: whatever the in-memory maps hold NOW. */
  private configSnapshot(): VaultSyncConfig {
    const docs: Record<string, string> = {};
    for (const [rp, m] of this.byPath) docs[rp] = m.docId;
    const folders: Record<string, string> = {};
    for (const [rp, id] of this.folderByPath) folders[rp] = id;
    return {
      serverVaultId: this.serverVaultId ?? undefined,
      docs,
      folders,
      pushed: [...this.pushed],
    };
  }

  private async writeConfig(cfg: VaultSyncConfig): Promise<void> {
    // Never write another vault's doc map into this folder's config.
    if (this.stale()) return;
    if (!cfg.serverVaultId) return; // nothing meaningful to persist yet
    await ipc.setVaultConfig(JSON.stringify(cfg, null, 2), this.epoch());
  }

  private newCheckpointer(): Checkpointer<VaultSyncConfig> {
    this.checkpoint?.dispose();
    const cp = new Checkpointer<VaultSyncConfig>({
      write: (cfg) => this.writeConfig(cfg),
      snapshot: () => this.configSnapshot(),
    });
    this.checkpoint = cp;
    return cp;
  }

  private setMapping(relPath: string, docId: string, vaultId: string): void {
    this.byPath.set(relPath, { vaultId, docId });
    this.byDocId.set(docId, relPath);
    this.notifyMapChanged();
  }

  /**
   * Ensure the server knows this vault's folders + notes; adopt existing ids,
   * create missing rows, and persist the mapping. Idempotent.
   *
   * Reads the tree ITSELF (`listTree`, the full recursive walk) rather than
   * accepting one from the caller — exactly as `pull()` does, and for a reason
   * that cost 428 notes: the sidebar's tree is LAZY. `store.refreshTree` fetches
   * only the top level, and every unexpanded folder carries an empty `children`
   * placeholder. Handed that tree, `flattenTree` sees root-level notes and
   * nothing else, so (a) no nested note is ever registered or uploaded, and
   * (b) — the destructive half — every nested note the server already knows
   * about looks server-only to step 5 below and gets materialized as an EMPTY
   * file over real content. A partial tree must never reach this method, and the
   * only way to guarantee that is for this method to be the one that reads it.
   *
   * Returns `{ seeded }` — true only when this call wrote first-run starter
   * content into a brand-new, empty vault (so the caller can open it).
   */
  async reconcile(input: ReconcileInput): Promise<{ seeded: boolean }> {
    // Bind this registry to the vault the reconcile is FOR — this is the one
    // operation allowed to (re)claim it. Every await below is a chance for the
    // user to switch vaults; each `stale()` checkpoint drops the rest of the work
    // instead of applying it to whatever vault is now open.
    this.bound = this.scopes.current();
    this.failed = [];
    this.limitReached = null;
    this.newCheckpointer();
    this.sink.phase("registering", 0);
    // Epoch-pinned like every other read here: a vault switch mid-walk makes Rust
    // reject it, which `stale()` then turns into a clean drop.
    const tree = await ipc.listTree(this.epoch());
    if (this.stale()) return { seeded: false };
    const cfg = await this.loadConfig();
    if (this.stale()) return { seeded: false };

    // 1. Ensure a server note collection (the `vaults` table row, 1:1 with this
    //    vault in practice) — resolved by ID, never by name (names collide and
    //    vary per device; the vault's org id is the identity).
    //    Precedence:
    //      a. the collection id recorded in .context/config.json, IF it still
    //         exists in THIS vault (a stale or cross-vault id is discarded);
    //      b. the vault's oldest existing collection (server lists created_at
    //         ASC), so every device deterministically adopts the same one —
    //         matching by folder name here used to fork a second, empty
    //         collection (and 403 for plain members, who can't create them),
    //         which is why a freshly-joined device saw an empty vault;
    //      c. create one (owner/admin bootstrapping a brand-new vault).
    const vaults = await this.api.listVaults();
    if (this.stale()) return { seeded: false };
    const inOrg = vaults.filter((v) => vaultOrgId(v) === input.organizationId);
    let vaultId = cfg.serverVaultId ?? null;
    if (vaultId && !inOrg.some((v) => v.id === vaultId)) vaultId = null;
    if (!vaultId) {
      let vault = inOrg[0] ?? null;
      if (!vault) {
        try {
          vault = await this.api.createVault({
            name: input.vaultName,
            organizationId: input.organizationId,
          });
        } catch (e) {
          // Only owner/admin may create a collection (403 for a plain member).
          // A member reaching here means the server showed them no collection
          // in this vault — they have no access to one yet, which is a waiting
          // state, not a broken client. Letting this throw failed the whole
          // reconcile, so sync never came on and the only visible remedy made
          // them a brand-new vault of their own. Report it and stop instead.
          throw new Error(
            `No accessible note collection in this vault yet. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      vaultId = vault.id;
    }
    if (this.stale()) return { seeded: false };
    this.serverVaultId = vaultId;
    // Publish the resolved collection id on the scope for the layers above.
    if (this.bound) this.bound.serverVaultId = vaultId;
    // Adopt the previous run's content-push checkpoint. This is what makes a
    // killed backfill resume instead of re-walking the whole vault.
    this.pushed = new Set(cfg.pushed ?? []);

    // 1b. First-run seeding. A brand-new vault — nothing on the server AND
    //     an empty local folder — gets welcome/starter content so the vault
    //     isn't an empty void. We seed BEFORE flattening so the files register
    //     as ordinary server docs in steps 2–4. Skipped when the server already
    //     has notes (joining/rejoining a populated vault) or the folder
    //     already has content — those paths adopt/materialize instead.
    const serverNotes = await this.api.listNotes(vaultId);
    if (this.stale()) return { seeded: false };
    let workingTree = tree;
    let seeded = false;
    const localFlat = flattenTree(tree);
    if (
      serverNotes.length === 0 &&
      localFlat.notes.length === 0 &&
      localFlat.folders.length === 0
    ) {
      await seedWelcomeContent(this.epoch());
      if (this.stale()) return { seeded: false };
      workingTree = await ipc.listTree(this.epoch());
      seeded = true;
    }

    await this.syncStructure(vaultId, workingTree);
    return { seeded };
  }

  /**
   * Re-pull the server's folder/note set and reconcile it against the current
   * local tree WITHOUT re-resolving the vault or seeding. Called when the vault
   * channel signals a `registry` change (a teammate created/renamed/moved/
   * deleted something) so this device's tree catches up live. Idempotent.
   */
  async pull(): Promise<void> {
    // Scope-guarded because this is THE historical corruption path: a debounced
    // pull that survived a vault switch still held vault A's `serverVaultId`
    // while `listTree()` returned vault B's tree, so B's folders/notes were
    // created under A and A's doc map was written into B's config.json.
    if (this.stale()) return;
    if (!this.serverVaultId) return;
    const vaultId = this.serverVaultId;
    const tree = await ipc.listTree(this.epoch());
    if (this.stale()) return;
    // The vault id must not have moved on either (a reconcile for another vault
    // could have re-pointed it while we were reading the tree).
    if (this.serverVaultId !== vaultId) return;
    await this.syncStructure(vaultId, tree);
  }

  /**
   * The shared core of reconcile/pull: make the server + this device agree on the
   * folder/note set. Adopts existing rows by path, creates missing ones (reusing
   * local doc_ids), materializes server-only notes onto disk, and checkpoints the
   * {relPath → docId} + {folderPath → id} maps to `.context/config.json`.
   *
   * Bounded and cancellable throughout: folders go level by level (so a parent
   * always exists before its children ask for its id), notes go in one flat pool,
   * and every lane re-checks the scope before it picks up an item.
   */
  private async syncStructure(vaultId: string, workingTree: TreeNode): Promise<void> {
    if (this.stale()) return;
    const [serverFolders, serverNotes] = await Promise.all([
      this.api.listFolders(vaultId),
      this.api.listNotes(vaultId),
    ]);
    if (this.stale()) return;
    const { folders, notes } = flattenTree(workingTree);
    const checkpoint = this.checkpoint ?? this.newCheckpointer();

    // Drop anything belonging to a different collection before we start adding:
    // the maps are written into incrementally from here on (so a mid-run
    // checkpoint is a valid partial map rather than an empty one), which is only
    // safe if nothing from another vault is still in them.
    for (const [rp, m] of [...this.byPath]) {
      if (m.vaultId !== vaultId) {
        this.byPath.delete(rp);
        this.byDocId.delete(m.docId);
        this.notifyMapChanged();
      }
    }

    // 2. Folders: adopt by path, create missing (parents first).
    for (const f of serverFolders) this.folderByPath.set(f.path, f.id);
    const missingFolders = folders.filter((f) => !this.folderByPath.has(f.path));

    // 3. Notes: adopt by relPath, create missing. Any first-run seeding happened
    //    in reconcile before this runs; the seeded files register here as docs.
    const resolvedNotePaths = new Set<string>();
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp) {
        this.setMapping(rp, noteDocId(n), vaultId);
        resolvedNotePaths.add(rp);
      }
    }
    const missingNotes = notes.filter((n) => !resolvedNotePaths.has(n.path));

    this.sink.phase("registering", missingFolders.length + missingNotes.length);

    const titles = await ipc.listNoteTitles(this.epoch());
    if (this.stale()) return;
    const titleByPath = new Map(titles.map((t) => [t.path, t.title] as const));
    // The local index already keyed each note by a stable doc_id. Supply it as
    // the server id so a note has ONE identity across the .md file, the local
    // CRDT store, and the server (the invariant: key by doc_id, never by path).
    // Omitting it lets the server mint a *different* random id, which forks the
    // note — the editor's bridge persists CRDT under the local id while sync
    // reads/writes the server id, so content silently fails to appear.
    const idByPath = new Map(titles.map((t) => [t.path, t.id] as const));

    // ---- folders, level by level ----
    const byDepth = new Map<number, TreeNode[]>();
    for (const f of missingFolders) {
      const depth = f.path.split("/").length;
      const bucket = byDepth.get(depth);
      if (bucket) bucket.push(f);
      else byDepth.set(depth, [f]);
    }
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      if (this.stopRun()) break;
      await runPool(
        byDepth.get(depth)!,
        async (f) => {
          const parentPath = parentDir(f.path);
          const parentId = parentPath ? (this.folderByPath.get(parentPath) ?? null) : null;
          const out = await withRetry<RegisteredFolder>(
            () =>
              this.api.createFolder({ vaultId, name: f.name, path: f.path, parentId }),
            { isTerminal: isTerminalApiError, shouldStop: () => this.stopRun() },
          );
          if (out.ok) {
            this.folderByPath.set(f.path, out.value.id);
            checkpoint.touch();
            this.sink.item("ok");
          } else {
            this.recordFailure({
              kind: "folder",
              path: f.path,
              docId: null,
              reason: reasonOf(out.error),
              code: errorCode(out.error),
            });
            this.sink.item("failed");
          }
        },
        { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
      );
    }
    if (this.stale()) return;

    // ---- notes, one flat pool (parentIds are all resolved by now) ----
    await runPool(
      missingNotes,
      async (note) => {
        const rp = note.path;
        const docId = idByPath.get(rp) ?? null;
        if (docId) this.sink.doc(docId, "queued");
        const folderId = this.folderByPath.get(parentDir(rp)) ?? null;
        const out = await withRetry(
          () =>
            this.api.createNote({
              vaultId,
              relPath: rp,
              title: titleByPath.get(rp) ?? note.name,
              folderId,
              docId: docId ?? undefined,
            }),
          { isTerminal: isTerminalApiError, shouldStop: () => this.stopRun() },
        );
        if (out.ok) {
          this.setMapping(rp, noteDocId(out.value), vaultId);
          resolvedNotePaths.add(rp);
          checkpoint.touch();
          this.sink.item("ok");
          return;
        }
        // 409 = this note's local doc_id is already a note in a DIFFERENT vault
        // (e.g. this folder was previously synced to another vault whose ids the
        // local index still carries). Deliberately leave it UNMAPPED: the note
        // keeps working locally, whereas mapping it would point sync at a doc the
        // user has no grant on, which only yields a permanent 403. Rotating the
        // local doc_id to rejoin such a note to this vault is not implemented.
        this.recordFailure({
          kind: "note",
          path: rp,
          docId,
          reason: reasonOf(out.error),
          code: errorCode(out.error) ?? (isConflict(out.error) ? "doc_id_conflict" : null),
        });
        this.sink.item("failed");
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
    if (this.stale()) return;

    // 4. Prune mappings for notes that no longer exist anywhere (deleted on the
    //    server AND absent locally), then checkpoint the map.
    for (const [rp, m] of [...this.byPath]) {
      if (!resolvedNotePaths.has(rp)) {
        this.byPath.delete(rp);
        this.byDocId.delete(m.docId);
        this.notifyMapChanged();
      }
    }
    // The push checkpoint only ever describes docs we still track.
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId)) this.pushed.delete(docId);
    }
    checkpoint.touch();
    await checkpoint.flush();
    if (this.stale()) return;

    // 5. Materialize server-only notes locally. This is what makes a folder
    //    that's empty on this device (a just-joined vault, or a fresh
    //    per-vault folder) actually show the vault's notes. We write an
    //    empty file — `writeNoteIfMissing` creates any missing parent folders —
    //    and the real content hydrates lazily when the note is opened
    //    (pull-before-seed in docSession, which never seeds a non-empty server
    //    doc from an empty file).
    //
    //    CREATE-ONLY, never overwrite. `toMaterialize` is a *difference of two
    //    lists*, and the local side of that difference is only as complete as the
    //    tree we were given. When it was short — a lazily-loaded tree that stopped
    //    at the vault root — every nested note read as "server-only" and a plain
    //    empty `writeNote` destroyed 428 real notes. `reconcile` now reads the
    //    full tree itself, which fixes the wrong input; this call makes the same
    //    mistake non-destructive if it ever recurs. Both, deliberately: one bug
    //    here is worth a belt and braces.
    const localNotePaths = new Set(notes.map((n) => n.path));
    const toMaterialize = [...resolvedNotePaths].filter((rp) => !localNotePaths.has(rp));
    this.sink.addTotal(toMaterialize.length);
    await runPool(
      toMaterialize,
      async (rp) => {
        // Doubly guarded: the pool's shouldStop stops the run the instant the
        // vault changes, and the pinned epoch makes Rust refuse anything that
        // slips past (this loop used to litter vault A's note paths through
        // vault B's folder).
        try {
          await ipc.writeNoteIfMissing(rp, "", this.epoch());
          this.sink.item("ok");
        } catch (e) {
          if (ipc.isVaultMismatch(e)) return; // the vault moved on — not a failure
          this.recordFailure({
            kind: "materialize",
            path: rp,
            docId: this.byPath.get(rp)?.docId ?? null,
            reason: reasonOf(e),
            code: null,
          });
          this.sink.item("failed");
        }
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
  }

  /**
   * Register a single newly-created note on demand (e.g. after ⌘N) and return
   * its mapping, or null if the vault isn't reconciled yet.
   *
   * O(1) amortized: it updates the in-memory maps and `touch()`es the
   * checkpointer. It used to read config.json, merge one key and rewrite the
   * whole file per note — O(N) bytes each, O(N²) for a vault being filled in.
   */
  async registerNote(
    relPath: string,
    title: string | null,
    docId?: string,
  ): Promise<DocMapping | null> {
    if (this.stale()) return null;
    const vaultId = this.serverVaultId;
    if (!vaultId) return null;
    const existing = this.byPath.get(relPath);
    if (existing) return existing;
    try {
      const folderId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createNote({
        vaultId,
        relPath,
        title,
        folderId,
        // Reuse the local index doc_id so the server doesn't fork a second
        // identity for this note (see reconcile's idByPath note).
        docId,
      });
      if (this.stale() || this.serverVaultId !== vaultId) return null;
      const mapping = { vaultId, docId: noteDocId(created) };
      this.setMapping(relPath, mapping.docId, vaultId);
      this.checkpoint?.touch();
      return mapping;
    } catch (e) {
      this.recordFailure({
        kind: "note",
        path: relPath,
        docId: docId ?? null,
        reason: reasonOf(e),
        code: errorCode(e),
      });
      return null;
    }
  }

  /**
   * Register a newly-created folder on the server so teammates see it live and
   * it can be shared. Idempotent (the server adopts an existing path). No-op if
   * the vault isn't reconciled yet.
   */
  async registerFolder(relPath: string, name: string): Promise<string | null> {
    if (this.stale()) return null;
    const vaultId = this.serverVaultId;
    if (!vaultId) return null;
    const existing = this.folderByPath.get(relPath);
    if (existing) return existing;
    try {
      const parentId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createFolder({
        vaultId,
        name,
        path: relPath,
        parentId,
      });
      if (this.stale() || this.serverVaultId !== vaultId) return null;
      this.folderByPath.set(relPath, created.id);
      this.persist();
      return created.id;
    } catch (e) {
      this.recordFailure({
        kind: "folder",
        path: relPath,
        docId: null,
        reason: reasonOf(e),
        code: errorCode(e),
      });
      return null;
    }
  }

  /**
   * Propagate a local rename/move to the server. Handles both a folder (with its
   * whole subtree of paths) and a single note. doc_ids never change — only the
   * path columns move — so open docs and backlinks survive (spec invariant).
   */
  async renamePath(oldPath: string, newPath: string): Promise<void> {
    if (this.stale()) return;
    const vaultId = this.serverVaultId;
    if (!vaultId) return;
    const folderId = this.folderByPath.get(oldPath);
    if (folderId) {
      // Folder move: rewrite the server subtree, then the local prefix maps.
      const parentId = this.folderByPath.get(parentDir(newPath)) ?? null;
      try {
        await this.api.updateFolder(folderId, { name: baseName(newPath), path: newPath, parentId });
      } catch (e) {
        console.error("[registry] updateFolder failed", oldPath, e);
        return;
      }
      // The maps may belong to a different vault by now — remapping them would
      // rewrite that vault's paths with this one's move.
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.folderByPath = remapPrefix(this.folderByPath, oldPath, newPath);
      this.byPath = remapPrefix(this.byPath, oldPath, newPath);
      this.rebuildByDocId();
      this.persist();
      this.notifyMapChanged();
      return;
    }
    const mapping = this.byPath.get(oldPath);
    if (mapping) {
      const newFolderId = this.folderByPath.get(parentDir(newPath)) ?? null;
      try {
        await this.api.updateNote(mapping.docId, { relPath: newPath, folderId: newFolderId });
      } catch (e) {
        console.error("[registry] updateNote failed", oldPath, e);
        return;
      }
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.byPath.delete(oldPath);
      this.byPath.set(newPath, mapping);
      this.byDocId.set(mapping.docId, newPath);
      this.persist();
      this.notifyMapChanged();
    }
  }

  /** Propagate a local delete of a folder subtree or a note to the server. */
  async deletePath(path: string): Promise<void> {
    if (this.stale()) return;
    const vaultId = this.serverVaultId;
    if (!vaultId) return;
    const folderId = this.folderByPath.get(path);
    if (folderId) {
      try {
        await this.api.deleteFolder(folderId);
      } catch (e) {
        console.error("[registry] deleteFolder failed", path, e);
        return;
      }
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.folderByPath = dropPrefix(this.folderByPath, path);
      this.byPath = dropPrefix(this.byPath, path);
      this.rebuildByDocId();
      this.prunePushed();
      this.persist();
      this.notifyMapChanged();
      return;
    }
    const mapping = this.byPath.get(path);
    if (mapping) {
      try {
        await this.api.deleteNote(mapping.docId);
      } catch (e) {
        console.error("[registry] deleteNote failed", path, e);
        return;
      }
      if (this.stale() || this.serverVaultId !== vaultId) return;
      this.byPath.delete(path);
      this.byDocId.delete(mapping.docId);
      this.pushed.delete(mapping.docId);
      this.persist();
      this.notifyMapChanged();
    }
  }

  /** Rebuild byDocId from byPath after a bulk prefix remap/drop. */
  private rebuildByDocId(): void {
    this.byDocId.clear();
    for (const [rp, m] of this.byPath) this.byDocId.set(m.docId, rp);
  }

  /** Drop push-checkpoint entries for docs we no longer track. */
  private prunePushed(): void {
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId)) this.pushed.delete(docId);
    }
  }

  /** Queue a write of the current in-memory maps to `.context/config.json`.
   *  Batched by the checkpointer — never a synchronous read-modify-write. */
  private persist(): void {
    if (this.stale()) return;
    if (!this.serverVaultId) return;
    this.checkpoint?.touch();
  }
}

/** Is `err` the server's doc-id-belongs-to-another-vault conflict? */
function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/** basename of a vault-relative path. */
function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Rewrite every key at `oldPrefix` (exact or `oldPrefix/…`) to `newPrefix`. */
function remapPrefix<V>(map: Map<string, V>, oldPrefix: string, newPrefix: string): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of map) {
    if (k === oldPrefix) out.set(newPrefix, v);
    else if (k.startsWith(oldPrefix + "/")) out.set(newPrefix + k.slice(oldPrefix.length), v);
    else out.set(k, v);
  }
  return out;
}

/** Drop every key at `prefix` (exact or `prefix/…`). */
function dropPrefix<V>(map: Map<string, V>, prefix: string): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of map) {
    if (k === prefix || k.startsWith(prefix + "/")) continue;
    out.set(k, v);
  }
  return out;
}
