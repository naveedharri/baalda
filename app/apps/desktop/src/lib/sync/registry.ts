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
  noteLastEdited,
  noteRelPath,
  vaultOrgId,
  type NoteLastEdited,
  type RegisteredFolder,
  type RegisteredNote,
} from "../api";
import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";
import { seedWelcomeContent } from "../vault/seed";
import { Checkpointer, checkpointBatchFor } from "./checkpoint";
import { planInbound } from "./inbound";
import { REGISTRY_CONCURRENCY, runPool, withRetry } from "./pool";
import { nullProgressSink, type SyncProgressSink } from "./progress";
import { toast } from "../toast";
import { vaultScopes, type VaultScope, type VaultScopeSource } from "./vaultScope";

export interface DocMapping {
  vaultId: string;
  docId: string;
}

interface VaultSyncConfig {
  /**
   * The vault (Better Auth org) this folder was last reconciled under. The
   * org→folder binding itself lives in webview localStorage (`context.orgVaults`),
   * which can be lost (reinstall, cleared storage, another device); this field is
   * what lets `store.setActiveOrganization` REDISCOVER the folder instead of
   * auto-creating a duplicate under the vaults root.
   */
  organizationId?: string;
  serverVaultId?: string;
  /** relPath → server docId (notes). */
  docs?: Record<string, string>;
  /** folder relPath → server folder id. */
  folders?: Record<string, string>;
  /**
   * docIds whose CONTENT this device has confirmed on the server (the bulk
   * upload's resume point — see `ContentUploader`).
   *
   * Purely an optimization ("nothing local left to send"), NEVER a correctness
   * gate — the vault channel's `ready.empty` is the authority on what the server
   * actually holds. Correctness never depends on this list, because the upload
   * path is idempotent by construction (pull-before-seed; it only ever transmits
   * CRDT state that already exists locally, never re-inserts text). A missing
   * entry costs a round trip; a WRONG one (a crashed run, a wiped `.context/`,
   * a restored backup) would strand a note forever if anything treated it as
   * proof — which is why the server re-states the truth on every connect.
   */
  pushed?: string[];
  /**
   * docId → relPath as of the last AGREED reconciliation, for THIS collection.
   *
   * The one piece of memory that makes inbound reconciliation possible: without a
   * prior agreement, "the server moved this note" and "we have never seen this
   * note" are indistinguishable, and so are "the server deleted it" and "it's new
   * here". `docs` can't serve — it's keyed by path (so a rename produces two
   * entries with no way to tell which is stale) and it's rewritten from scratch
   * every pass.
   *
   * Accumulates rather than mirroring `docs`: a doc whose access was revoked stays
   * here on purpose, so we keep recognising it as "was ours, now unreadable" and
   * keep leaving it alone. Dropping it would make the next pass see a brand-new
   * local note and re-register it — the ghost, back every other pull.
   */
  baseline?: Record<string, string>;
}

/**
 * A tree that came from `ipc.listTree` — the FULL recursive walk.
 *
 * The brand is unforgeable outside this module, so no caller can hand the LAZY
 * sidebar tree (`store.refreshTree` → `ipc.listChildren`, where unexpanded
 * folders carry placeholder children) to anything that mutates the disk. That
 * exact confusion is what once materialized empty files over 428 real notes, and
 * inbound reconciliation raises the stakes: a short tree would read as "the
 * server deleted everything I can't see".
 */
type FullTree = TreeNode & { readonly __fullTree: unique symbol };

/**
 * Rust stamps `childrenLoaded: true` on every directory in `list_tree` and
 * `false`/absent only on `list_children` placeholders, so this is a real check
 * rather than a formality.
 */
function assertFullTree(node: TreeNode): void {
  if (node.isDir && node.childrenLoaded !== true) {
    throw new Error(`[registry] partial tree at "${node.path}" — refusing to reconcile`);
  }
  for (const child of node.children ?? []) assertFullTree(child);
}

/**
 * How the registry asks the layers above it to let go of a doc before its path
 * moves or disappears.
 *
 * Injected rather than imported so this module stays free of the editor and the
 * background doc store (and unit-testable without either).
 */
export interface InboundHost {
  /**
   * Resolve only once NOTHING can still write to `docId`'s current path — the
   * editor's bridge, the background hot bridge, and any in-flight cold apply.
   *
   * Without this, a bridge that still holds the OLD path egests after the move and
   * RECREATES the file. Worse than a stray copy: the watcher then indexes it as a
   * new file and mints a fresh docId, so the note is resurrected *and* forked into
   * a second server row.
   */
  releaseDoc(docId: string): Promise<void>;
  /** The file moved: re-point anything showing it (e.g. the open editor). */
  notePathChanged(docId: string, from: string, to: string): void;
  /** The file is gone: close anything showing it. */
  noteRemoved(docId: string, path: string, trashedTo: string | null): void;
}

export interface ReconcileInput {
  /** Active organization to create the vault under (required to create). */
  organizationId: string;
  /** Display name for a newly created server vault. */
  vaultName: string;
  /** True only when the user JUST created this vault. Gates first-run seeding:
   *  without it an empty vault stays empty — adopting an existing folder,
   *  joining a team vault, or reopening one must never invent content. */
  seedIfEmpty?: boolean;
}

/** A folder/note that could NOT be registered, after retries. Surfaced so the
 *  vault is never reported fully synced while an arbitrary subset is local-only. */
export interface RegistryFailure {
  kind: "folder" | "note" | "materialize" | "inbound" | "orphan";
  /** Vault-relative path. */
  path: string;
  /** Intended docId, when known (notes) — phase 3 keys its badge by this. */
  docId: string | null;
  reason: string;
  /** Server error code when it carried one (`vault_limit_reached`, …). */
  code: string | null;
}

/** Paths already toasted about a frozen-root refusal — reconcile re-runs and
 *  retry clicks re-hit the same 403, and one sticky explanation is enough. */
const frozenRootNotified = new Set<string>();

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

/**
 * One folder name per inbound pass, so everything a single remote delete removed
 * can be found (and put back) together. Supplied by the caller rather than
 * generated in Rust, which has no date crate and would otherwise scatter a
 * multi-note delete across timestamps.
 */
function trashStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
  /** The org this registry is reconciling under (see `VaultSyncConfig.organizationId`). */
  private organizationId: string | null = null;
  private byPath = new Map<string, DocMapping>();
  /** Reverse of byPath: docId → relPath, for the vault sync engine (spec 05). */
  private byDocId = new Map<string, string>();
  /** Lazy case-folded view of `byPath` (lowercased path → the path as mapped).
   *  Null = not built / invalidated; see `canonicalNotePath`. */
  private byPathCi: Map<string, string> | null = null;
  private folderByPath = new Map<string, string>();
  /** docIds whose content this device has confirmed on the server. See
   *  `VaultSyncConfig.pushed` for why this is an optimization, not a guarantee. */
  private pushed = new Set<string>();
  /** Last agreed docId → relPath (see `VaultSyncConfig.baseline`). */
  private baselineDocs = new Map<string, string>();
  /**
   * The collection `baselineDocs` describes. A baseline recorded against ANOTHER
   * collection must never decide that a file moved or died, so a mismatch
   * disables inbound reconciliation for the pass — degrading to the outbound-only
   * behaviour we had before, never to a guess.
   */
  private baselineVaultId: string | null = null;
  /** Set by `SyncManager`; absent in unit tests, where inbound is a no-op host. */
  private host: InboundHost | null = null;
  /** Local note paths the current pass must not re-register (see `InboundPlan.suppress`). */
  private inboundSuppressed = new Set<string>();
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

  /**
   * Notified with the {docId → last-edit} map every time a pull tells us who
   * last touched each note.
   *
   * Liveness rides the registry re-pull rather than a protocol frame of its own:
   * the server already fires `registry-changed` when it stamps an edit, and that
   * pull is coalesced (120ms/250ms), so "edited by X just now" converges on the
   * same round trip that moves/renames use. Owned for the process lifetime like
   * {@link onMapChanged} — a vault switch must *publish* an empty map, not go
   * silent.
   */
  private onNoteMeta: ((meta: Record<string, NoteLastEdited>) => void) | null = null;

  /**
   * Notified with the {relPath → color id} map on every pull.
   *
   * Item colors used to be a localStorage preference keyed by path, so a folder
   * you tinted was grey on every other machine and for every teammate. They are
   * a fact about the folder, not about this computer, so they live on the row
   * (keyed by id, surviving renames) and ride the registry pull that already
   * fires whenever the structure changes. Keyed by PATH on the way out because
   * that is what the sidebar draws with.
   */
  private onColors: ((colors: Record<string, string>) => void) | null = null;

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

  /** Subscribe to per-note last-edit metadata (see {@link onNoteMeta}). */
  setNoteMetaListener(cb: ((meta: Record<string, NoteLastEdited>) => void) | null): void {
    this.onNoteMeta = cb;
  }

  /** Subscribe to the vault's shared item colors (see {@link onColors}). */
  setColorListener(cb: ((colors: Record<string, string>) => void) | null): void {
    this.onColors = cb;
  }

  /** Provide the editor/doc-store coupling inbound reconciliation needs. Without
   *  a host, inbound still runs but nothing is released — safe only in tests,
   *  where no bridge is open. */
  setInboundHost(host: InboundHost | null): void {
    this.host = host;
  }

  /** Announce a change to the path→docId map. Fired freely (once per adopted or
   *  created note); the listener is responsible for coalescing. */
  private notifyMapChanged(): void {
    // Every `byPath` mutation funnels through here, which makes it the one place
    // the case-folded view has to be dropped. See `canonicalNotePath`.
    this.byPathCi = null;
    this.onMapChanged?.();
  }

  /**
   * The path this vault already uses for `relPath`, compared case-insensitively,
   * or null if nothing is mapped there yet.
   *
   * macOS and Windows cannot distinguish `Projects/Community/x.md` from
   * `Projects/community/x.md` — they are one file. If this device maps its disk
   * spelling to a second doc_id while the server holds another, the two docs
   * write over each other through that one file forever (the 2026-09-04 runaway;
   * `samePath` in the server's tree-ops.ts has the full account). The server now
   * adopts case-insensitively and answers with its canonical spelling, so this
   * is the client half: recognise that we already track the file and reuse the
   * mapping instead of registering a twin.
   *
   * Exact hits skip the folded map entirely, so the common path is one Map.get
   * and nothing is built during a reconcile that finds everything already
   * mapped. The lazy index is rebuilt at most once per mutation batch.
   */
  private canonicalNotePath(relPath: string): string | null {
    if (this.byPath.has(relPath)) return relPath;
    if (!this.byPathCi) {
      this.byPathCi = new Map();
      // Insertion order = first writer wins, so a vault that still holds
      // pre-migration-023 twins resolves to one of them consistently rather
      // than alternating between passes.
      for (const rp of this.byPath.keys()) {
        const k = rp.toLowerCase();
        if (!this.byPathCi.has(k)) this.byPathCi.set(k, rp);
      }
    }
    return this.byPathCi.get(relPath.toLowerCase()) ?? null;
  }

  /** Folder twin of {@link canonicalNotePath}. Scanned rather than indexed:
   *  `folderByPath` is a fraction of `byPath` and this runs only when a folder
   *  is genuinely missing from the map. */
  private canonicalFolderPath(relPath: string): string | null {
    if (this.folderByPath.has(relPath)) return relPath;
    const want = relPath.toLowerCase();
    for (const rp of this.folderByPath.keys()) {
      if (rp.toLowerCase() === want) return rp;
    }
    return null;
  }

  /**
   * Publish the last-edit stamps carried by a registry pull, keyed by **docId**
   * (the sidebar joins it back to a row through the path→docId map). Notes the
   * server has no stamp for are simply absent, so the whole map replaces the
   * previous one rather than merging into it.
   */
  private publishNoteMeta(serverNotes: RegisteredNote[]): void {
    const cb = this.onNoteMeta;
    if (!cb) return;
    const meta: Record<string, NoteLastEdited> = {};
    for (const n of serverNotes) {
      const edited = noteLastEdited(n);
      if (edited) meta[noteDocId(n)] = edited;
    }
    cb(meta);
  }

  /**
   * Publish the server's item colors, keyed by vault-relative path.
   *
   * Whole-map replacement, like {@link publishNoteMeta}: a folder whose color was
   * cleared by a teammate has no row here, and merging would keep it tinted
   * forever on this machine.
   */
  private publishColors(
    serverFolders: RegisteredFolder[],
    serverNotes: RegisteredNote[],
  ): void {
    const cb = this.onColors;
    if (!cb) return;
    const colors: Record<string, string> = {};
    for (const f of serverFolders) if (f.color) colors[f.path] = f.color;
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp && n.color) colors[rp] = n.color;
    }
    cb(colors);
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
    this.organizationId = null;
    this.byPath.clear();
    this.byDocId.clear();
    this.byPathCi = null;
    this.folderByPath.clear();
    this.pushed.clear();
    // A surviving baseline is exactly the cross-vault confusion this method
    // exists to prevent — it would tell vault B that vault A's notes moved.
    this.baselineDocs.clear();
    this.baselineVaultId = null;
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

  /**
   * Persist an item's accent color on the server row behind `relPath`.
   *
   * Resolves folder-first, then note. Returns false when the path isn't mapped
   * (a local-only vault, or a file registered a moment ago) — the caller keeps
   * its optimistic local value rather than reporting a failure the user can do
   * nothing about.
   */
  async setColor(relPath: string, colorId: string | null): Promise<boolean> {
    const folderId = this.folderByPath.get(relPath);
    if (folderId) {
      await this.api.updateFolder(folderId, { color: colorId });
      return true;
    }
    const mapping = this.byPath.get(relPath);
    if (mapping) {
      await this.api.updateNote(mapping.docId, { color: colorId });
      return true;
    }
    return false;
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
    // A frozen-root refusal is the user's problem to fix (move the item into a
    // folder), not a transient sync error — so say so, once per path. Without
    // this the item just counts toward "N not synced" forever with no reason.
    if (f.code === "root_frozen" && !frozenRootNotified.has(f.path)) {
      frozenRootNotified.add(f.path);
      toast(
        `"${f.path}" can't sync — this vault's root is frozen. Move it into a folder to sync it.`,
        "error",
      );
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
    const baseline: Record<string, string> = {};
    for (const [docId, rp] of this.baselineDocs) baseline[docId] = rp;
    return {
      organizationId: this.organizationId ?? undefined,
      serverVaultId: this.serverVaultId ?? undefined,
      docs,
      folders,
      pushed: [...this.pushed],
      baseline,
    };
  }

  /**
   * Bring local disk into line with the server's structure: create folders that
   * only exist server-side, apply remote renames/moves, and move notes to the
   * vault's trash when the server says they were deleted OR when they left this
   * user's readable set (access revoked — see `InboundTrash.reason`).
   *
   * Every mutation below is guarded, and the guards are the point:
   *   - a persisted baseline for THIS collection must exist (else we can't tell a
   *     remote move from a note we've simply never seen);
   *   - the tree must be the full walk (enforced by the `FullTree` brand);
   *   - the scope is re-checked immediately before each call, and every IPC is
   *     epoch-pinned so Rust refuses anything that outlives the vault;
   *   - the doc is RELEASED first, so no bridge can egest to the old path and
   *     recreate the file we just moved;
   *   - and `planInbound` caps how much one pass may change.
   */
  private async applyInbound(
    vaultId: string,
    args: {
      folders: TreeNode[];
      notes: TreeNode[];
      titles: Array<{ path: string; id: string }>;
      serverFolders: Array<{ id: string; path: string }>;
      serverNotes: RegisteredNote[];
      tombstones: string[] | null;
      folderTombstones: string[] | null;
    },
  ): Promise<{ changedDisk: boolean; suppress: Set<string> }> {
    const none = { changedDisk: false, suppress: new Set<string>() };
    // No baseline for this collection ⇒ no inbound. A first run, a config written
    // by another vault, or a wiped `.context` all land here, and all of them mean
    // "we have no idea what moved" — which must degrade to outbound-only, never to
    // a guess about what to delete.
    if (this.baselineVaultId !== vaultId) return none;

    const localNotePaths = new Set(args.notes.map((n) => n.path));
    // What docId does this device believe each on-disk note has?
    //
    // The registry's OWN map answers first, and it has to: a note this device
    // MATERIALIZED from the server got its file written by `writeNoteIfMissing`,
    // and Rust's indexer mints a fresh local UUID for any file it hasn't seen
    // before. That local id never equals the server's `doc_id` — `byPath` is the
    // only place the two identities are joined (see viewingDocId.ts, which says
    // the same thing for presence).
    //
    // Keying this map on index ids alone therefore made every remote delete of a
    // materialized note a no-op: `local.get(serverDocId)` came back undefined, the
    // plan read that as "already gone locally" and suppressed nothing, and the
    // outbound half below re-registered the still-present file under its LOCAL id
    // — resurrecting the note on the server as a brand-new row with a brand-new
    // docId. Deleting it again just repeated the cycle, which is what made a
    // deleted note look undeletable.
    //
    // The index id stays as the fallback for paths the registry doesn't map yet
    // (a note created locally and not yet registered). One docId per path either
    // way — `claimed` stops a mapped path also entering under its index id, which
    // would let one file be both renamed and trashed in a single pass.
    const local = new Map<string, string>();
    const claimed = new Set<string>();
    for (const path of localNotePaths) {
      const m = this.byPath.get(path);
      // `byPath` can still hold another collection's entries at this point (they
      // are pruned after inbound runs), and those ids mean nothing here.
      if (m && m.vaultId === vaultId) {
        local.set(m.docId, path);
        claimed.add(path);
      }
    }
    // Only notes that are BOTH in the tree and in the index have a docId we can
    // match on. (The index covers `.md`; a `.txt`/`.canvas` note therefore never
    // gets inbound-renamed or trashed, only materialized — the safe direction.)
    for (const t of args.titles) {
      if (localNotePaths.has(t.path) && !claimed.has(t.path)) local.set(t.id, t.path);
    }
    const server = new Map<string, string>();
    for (const n of args.serverNotes) {
      const rp = noteRelPath(n);
      if (rp) server.set(noteDocId(n), rp);
    }

    const plan = planInbound({
      server,
      tombstones: args.tombstones ? new Set(args.tombstones) : null,
      baseline: this.baselineDocs,
      local,
      serverFolders: new Set(args.serverFolders.map((f) => f.path)),
      serverFolderIds: new Map(args.serverFolders.map((f) => [f.id, f.path] as const)),
      localFolders: new Set(args.folders.map((f) => f.path)),
      folderTombstones: args.folderTombstones ? new Set(args.folderTombstones) : null,
      // The persisted path → server-folder-id join: an id match against a
      // tombstone is proof the local folder IS the deleted one.
      localFolderIds: new Map(this.folderByPath),
    });

    for (const r of plan.rejected) {
      this.recordFailure({
        kind: "inbound",
        path: r.path,
        docId: r.docId,
        reason: r.reason,
        code: null,
      });
    }

    let changedDisk = false;

    // Folders first: a rename or materialize below may need one as a parent.
    // `ensureFolder` is idempotent, so a folder that already exists costs nothing
    // and a second pull is a no-op.
    for (const path of plan.createFolders) {
      if (this.stopRun()) break;
      try {
        await ipc.ensureFolder(path, this.epoch());
        changedDisk = true;
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return none;
        this.recordFailure({
          kind: "inbound",
          path,
          docId: null,
          reason: reasonOf(e),
          code: null,
        });
      }
    }

    for (const move of plan.renames) {
      if (this.stopRun()) break;
      // Nothing may still hold the old path when we move it.
      await this.host?.releaseDoc(move.docId);
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      try {
        // Rust refuses a rename onto an existing file, so this cannot overwrite
        // content — we lean on that rather than pre-checking and racing.
        await ipc.renamePath(move.from, move.to, this.epoch());
        changedDisk = true;
        this.host?.notePathChanged(move.docId, move.from, move.to);
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        this.recordFailure({
          kind: "inbound",
          path: move.to,
          docId: move.docId,
          reason: reasonOf(e),
          code: null,
        });
      }
    }

    // One stamp per pass, so everything a single remote delete removed lands in
    // one recoverable folder.
    const stamp = trashStamp();
    for (const gone of plan.trash) {
      if (this.stopRun()) break;
      // A note whose content this device never confirmed upstream may hold local
      // edits that exist NOWHERE else, so removing it could lose the only copy.
      // Read `pushed` before the prune below has a chance to drop it. This
      // matters most for `revoked`: access can be taken away mid-edit, and the
      // one thing a permission change must never do is destroy work that only
      // exists here.
      if (!this.pushed.has(gone.docId) && !(await this.isEmptyOnDisk(gone.path))) {
        this.recordFailure({
          kind: "orphan",
          path: gone.path,
          docId: gone.docId,
          reason:
            gone.reason === "revoked"
              ? "access was removed, but this device never confirmed its content upstream — left on disk"
              : "deleted on the server, but this device never confirmed its content — left on disk",
          code: null,
        });
        // Stop claiming the path, so the file can re-register on a later pass.
        //
        // Without this the baseline keeps naming this docId at this path, the
        // plan suppresses the path on every pass, and the file is stranded:
        // visible in the sidebar, never counted, never uploaded, while the header
        // reads "Synced". For a note whose content this device never confirmed
        // upstream that is the worst possible outcome — the local copy is the ONLY
        // copy, and we were leaving it unsyncable on purpose. Re-registering it
        // gets that work onto the server instead.
        //
        // NOT for a revocation: there the server still holds the content and the
        // user has lost write access, so re-registering would only 403 in a loop.
        if (gone.reason !== "revoked") this.baselineDocs.delete(gone.docId);
        continue;
      }
      await this.host?.releaseDoc(gone.docId);
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      try {
        const dest = await ipc.trashNote(gone.path, stamp, this.epoch());
        changedDisk = true;
        // The file left, so the baseline entry goes with it — otherwise every
        // later pass would keep trying to trash a path that isn't there.
        this.baselineDocs.delete(gone.docId);
        this.host?.noteRemoved(gone.docId, gone.path, dest);
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        this.recordFailure({
          kind: "inbound",
          path: gone.path,
          docId: gone.docId,
          reason: reasonOf(e),
          code: null,
        });
      }
    }

    // Paths the plan suppressed WITHOUT trashing: a tombstoned note whose file
    // is still on disk under an identity the index no longer ties to the
    // tombstone (a materialized placeholder whose mapping was pruned). The plan
    // cannot prove that file IS the deleted note, so it leaves it — rightly, for
    // a file with text in it. An EMPTY file is different: there is no work in it
    // to lose, and left alone it sits unmapped, uncounted and unsyncable forever
    // (21 zero-byte stubs under re-created "… 2/" folders in one vault). So the
    // empty ones go to the trash like any other tombstoned note.
    // (`plan.stubs` is only ever filled for notes the server confirmed deleted —
    // never for revocations or a listing that didn't report tombstones, where
    // "I don't know" must remove nothing.)
    for (const path of plan.stubs) {
      if (this.stopRun()) break;
      if (!(await this.isEmptyOnDisk(path))) {
        // A file WITH content at a path the server says was deleted, and no
        // docId match to prove it is that note (the `dead && loc === undefined`
        // branch in `planInbound`). We will not trash it — we cannot prove whose
        // it is — but we must also stop claiming it, or the baseline suppresses
        // this path on every pass forever and the user's content becomes
        // permanently unsyncable while the header still reads "Synced".
        //
        // That is exactly what re-dropping a previously-synced folder did: 176
        // `Daily/*` tombstones still held baseline entries, the re-imported files
        // landed on those same paths under fresh local index ids, and all 176 were
        // suppressed — `0/174`, nothing queued, no error, and only opening a note
        // synced it (the editor calls `registerNote` directly, bypassing
        // `suppress`). Releasing the claim lets the NEXT pass register it as the
        // new local note it is.
        //
        // The trade this makes, deliberately: a file that really IS the deleted
        // note — same path, new local identity — re-registers under a fresh docId
        // instead of staying dead (the resurrect this branch was written to
        // prevent). That case is visible and re-deletable; silent permanent
        // divergence is neither, and `.md` on disk is the source of truth. The
        // device that performed the delete removes its own file, so it never
        // reaches here. Recorded rather than done silently.
        for (const [docId, rp] of [...this.baselineDocs]) {
          if (rp !== path) continue;
          this.baselineDocs.delete(docId);
          this.recordFailure({
            kind: "inbound",
            path,
            docId,
            reason:
              "deleted on the server but still on disk with content — re-registering it as a new local note",
            code: "resurrected_local_note",
          });
        }
        continue;
      }
      if (this.stale()) return { changedDisk, suppress: plan.suppress };
      try {
        await ipc.trashNote(path, stamp, this.epoch());
        changedDisk = true;
        // Nothing is at that path any more, so no baseline entry may keep
        // claiming it (which would suppress a genuinely new file there later).
        for (const [docId, rp] of [...this.baselineDocs]) {
          if (rp === path) this.baselineDocs.delete(docId);
        }
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        // Left on disk; it stays suppressed and harmless, as before.
      }
    }

    // Folders the server has deleted, children before parents, AFTER the trash
    // loop above has moved their notes out. Empty-only removal (`remove_dir`,
    // never recursive): a folder still holding anything stays on disk and — its
    // dead mapping dropped below — re-registers under a fresh id, because
    // content must live somewhere. Either way the stale id leaves the map, so
    // nothing can later rename/color/re-register against a deleted server row.
    for (const path of plan.removeFolders) {
      if (this.stopRun()) break;
      try {
        const removed = await ipc.deleteFolderIfEmpty(path, this.epoch());
        if (removed) changedDisk = true;
      } catch (e) {
        if (ipc.isVaultMismatch(e)) return { changedDisk, suppress: plan.suppress };
        this.recordFailure({
          kind: "inbound",
          path,
          docId: null,
          reason: reasonOf(e),
          code: null,
        });
      }
      this.folderByPath.delete(path);
    }
    // Drop EVERY mapping whose id is tombstoned, not just the ones whose dir
    // still existed: a surviving dead entry would make `registerFolder` at the
    // same path adopt the deleted row's id and silently skip creating.
    if (args.folderTombstones) {
      const dead = new Set(args.folderTombstones);
      for (const [rp, id] of [...this.folderByPath]) {
        if (dead.has(id)) this.folderByPath.delete(rp);
      }
    }

    return { changedDisk, suppress: plan.suppress };
  }

  /**
   * Is this note empty on disk (nothing but whitespace)? Public for the session's
   * `ready.empty` probe: a doc the server has no content for AND whose file here
   * is empty has nothing to push, so it must not be queued (see
   * `SyncManager.settleServerEmpty`). Epoch-pinned like every read here.
   */
  isNoteEmptyOnDisk(relPath: string): Promise<boolean> {
    return this.isEmptyOnDisk(relPath);
  }

  /** Is this note empty on disk? Used to decide whether an unconfirmed note is
   *  safe to remove — an empty file can't be holding the only copy of anything. */
  private async isEmptyOnDisk(relPath: string): Promise<boolean> {
    try {
      const text = await ipc.readNote(relPath, this.epoch());
      return text.trim().length === 0;
    } catch {
      // Unreadable ⇒ treat as non-empty, i.e. refuse to remove it.
      return false;
    }
  }

  /** Read the FULL tree (never the lazy sidebar one) — see {@link FullTree}. */
  private async readFullTree(): Promise<FullTree> {
    const tree = await ipc.listTree(this.epoch());
    assertFullTree(tree);
    return tree as FullTree;
  }

  private async writeConfig(cfg: VaultSyncConfig): Promise<void> {
    // Never write another vault's doc map into this folder's config.
    if (this.stale()) return;
    if (!cfg.serverVaultId) return; // nothing meaningful to persist yet
    // Compact, not pretty-printed. This file is rewritten whole on every
    // checkpoint and holds three entries per note; two-space indentation added
    // ~35% to every one of those writes for the benefit of nobody — it is derived
    // state, not something a person edits.
    await ipc.setVaultConfig(JSON.stringify(cfg), this.epoch());
  }

  private newCheckpointer(): Checkpointer<VaultSyncConfig> {
    this.checkpoint?.dispose();
    const cp = new Checkpointer<VaultSyncConfig>({
      write: (cfg) => this.writeConfig(cfg),
      snapshot: () => this.configSnapshot(),
      // Starts at the default and is retuned by `tuneCheckpointBatch` the moment
      // we know how many notes this vault has (see `checkpointBatchFor`).
      everyItems: checkpointBatchFor(this.byPath.size),
    });
    this.checkpoint = cp;
    return cp;
  }

  /** Size the config.json flush batch to this vault: one write per
   *  `checkpointBatchFor(n)` notes, so the write COUNT stays flat as the file
   *  itself grows. */
  private tuneCheckpointBatch(mapped: number): void {
    this.checkpoint?.setEveryItems(checkpointBatchFor(mapped));
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
    this.organizationId = input.organizationId;
    this.failed = [];
    this.limitReached = null;
    this.newCheckpointer();
    this.sink.phase("registering", 0);
    // Epoch-pinned like every other read here: a vault switch mid-walk makes Rust
    // reject it, which `stale()` then turns into a clean drop.
    const tree = await this.readFullTree();
    if (this.stale()) return { seeded: false };
    const cfg = await this.loadConfig();
    if (this.stale()) return { seeded: false };
    this.tuneCheckpointBatch(Object.keys(cfg.docs ?? {}).length);

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
    // killed backfill resume instead of re-walking the whole vault. Guarded on
    // the collection matching, like everything else read back from config: a
    // pushed-set recorded against another collection says nothing about this one.
    this.pushed = new Set(cfg.serverVaultId === vaultId ? (cfg.pushed ?? []) : []);
    // Adopt the baseline ONLY if the config we just read describes the collection
    // we actually resolved. Anything else (a first run, a config from another
    // vault, a rewritten `.context`) leaves it empty, which disables inbound for
    // this pass — outbound-only, i.e. exactly the old behaviour.
    this.baselineDocs = new Map<string, string>();
    this.baselineVaultId = null;
    if (cfg.serverVaultId === vaultId && cfg.baseline) {
      for (const [docId, rp] of Object.entries(cfg.baseline)) {
        if (typeof rp === "string" && rp) this.baselineDocs.set(docId, rp);
      }
      this.baselineVaultId = vaultId;
    }
    // Restore the path → server-docId join too, under the same collection guard.
    //
    // `docs` was written every pass and read back by nobody, so after a relaunch
    // the ONE link between a file and its server identity was gone until the
    // server's listing rebuilt it in step 3. For a note the server has since
    // DELETED that listing never comes, so inbound could not recognise the file
    // as the deleted doc and the note lingered on disk (and, before the inbound
    // fix, got re-registered under a new docId).
    //
    // Safe to trust for exactly the reason it can't serve as the baseline: it is
    // rewritten from scratch each pass and maintained by `registerNote` /
    // `deletePath`, so it describes what this device believes NOW. A note the
    // user deleted and recreated at the same path carries the new docId here, not
    // the old one — so a stale tombstone still fails to match, which is what
    // stops inbound removing a file it can't prove the identity of. Step 3
    // overwrites these entries from the server and step 4 prunes whatever the
    // server no longer lists, so nothing survives the pass unconfirmed.
    if (cfg.serverVaultId === vaultId && cfg.docs) {
      for (const [rp, docId] of Object.entries(cfg.docs)) {
        if (typeof docId === "string" && docId) this.setMapping(rp, docId, vaultId);
      }
    }
    // Restore the folder path → server-id join too (same collection guard). It
    // was written every pass and read back by nobody — so after a relaunch a
    // folder the server had DELETED could not be recognised as the deleted one
    // (the tombstone match is by id), and the outbound half re-registered it.
    if (cfg.serverVaultId === vaultId && cfg.folders) {
      for (const [rp, id] of Object.entries(cfg.folders)) {
        if (typeof id === "string" && id) this.folderByPath.set(rp, id);
      }
    }

    // 1b. First-run seeding. A vault the user JUST created (`seedIfEmpty`) —
    //     with nothing on the server AND an empty local folder — gets
    //     welcome/starter content so the vault isn't an empty void. We seed
    //     BEFORE flattening so the files register as ordinary server docs in
    //     steps 2–4. Skipped when the server already has notes (joining/
    //     rejoining a populated vault) or the folder already has content —
    //     those paths adopt/materialize instead. And skipped WITHOUT the
    //     caller's explicit creation intent: turning on sync for a folder the
    //     user opened, or joining an empty team vault, must never invent
    //     content in it.
    const serverNotes = await this.api.listNotes(vaultId);
    if (this.stale()) return { seeded: false };
    let workingTree = tree;
    let seeded = false;
    const localFlat = flattenTree(tree);
    if (
      input.seedIfEmpty === true &&
      serverNotes.length === 0 &&
      localFlat.notes.length === 0 &&
      localFlat.folders.length === 0
    ) {
      await seedWelcomeContent(this.epoch());
      if (this.stale()) return { seeded: false };
      workingTree = await this.readFullTree();
      seeded = true;
    }

    await this.syncStructure(vaultId, workingTree, { inbound: true });
    return { seeded };
  }

  /**
   * The tail of the pull chain. Pulls are SERIALIZED: two interleaved
   * `syncStructure` passes feed the shared progress reporter from both sides at
   * once (each resets the denominator the other is still counting against),
   * which is how the header once read "Syncing 585/164".
   */
  private pullChain: Promise<boolean> = Promise.resolve(false);

  /**
   * Re-pull the server's folder/note set and reconcile it against the current
   * local tree WITHOUT re-resolving the vault or seeding. Called when the vault
   * channel signals a `registry` change (a teammate created/renamed/moved/
   * deleted something) so this device's tree catches up live. Idempotent, and
   * serialized — a pull that arrives while one is running waits its turn.
   *
   * Resolves TRUE only when the pass actually changed something this device can
   * see (disk moved, rows created, notes materialized), so callers can skip a
   * sidebar refresh — and the re-render flicker it causes — for the common
   * "nothing new" pull.
   */
  pull(): Promise<boolean> {
    const run = this.pullChain.then(
      () => this.pullOnce(),
      () => this.pullOnce(),
    );
    this.pullChain = run.catch(() => false);
    return run;
  }

  private async pullOnce(): Promise<boolean> {
    // Scope-guarded because this is THE historical corruption path: a debounced
    // pull that survived a vault switch still held vault A's `serverVaultId`
    // while `listTree()` returned vault B's tree, so B's folders/notes were
    // created under A and A's doc map was written into B's config.json.
    if (this.stale()) return false;
    if (!this.serverVaultId) return false;
    const vaultId = this.serverVaultId;
    const tree = await this.readFullTree();
    if (this.stale()) return false;
    // The vault id must not have moved on either (a reconcile for another vault
    // could have re-pointed it while we were reading the tree).
    if (this.serverVaultId !== vaultId) return false;
    return this.syncStructure(vaultId, tree, { inbound: true });
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
  private async syncStructure(
    vaultId: string,
    workingTree: FullTree,
    opts: { inbound: boolean },
  ): Promise<boolean> {
    if (this.stale()) return false;
    // Did this pass change anything the sidebar can see? Returned so a pull
    // that found nothing new can skip the tree refresh (and its flicker).
    let mutated = false;
    // Failures describe THIS pass. They used to accumulate across pulls — every
    // registry signal re-recorded the same refusals, so a vault could never come
    // back from "N not synced" even after the underlying cause was gone.
    this.failed = [];
    this.limitReached = null;
    const [folderRegistry, noteRegistry] = await Promise.all([
      this.api.listFolderRegistry(vaultId),
      this.api.listNoteRegistry(vaultId),
    ]);
    if (this.stale()) return false;
    const serverFolders = folderRegistry.folders;
    let serverNotes = noteRegistry.notes;
    let { folders, notes } = flattenTree(workingTree);
    const checkpoint = this.checkpoint ?? this.newCheckpointer();
    // A pull can be the first thing to touch a big vault's map (a reconnect
    // catch-up), so retune here too rather than trusting the construction-time
    // guess.
    this.tuneCheckpointBatch(this.byPath.size);

    // The local index's docId per note path, read BEFORE any decision so inbound
    // can match by docId rather than by path (a rename changes the path, which is
    // exactly why path-matching produced duplicates).
    let titles = await ipc.listNoteTitles(this.epoch());
    if (this.stale()) return false;

    // 1. Inbound: apply the server's structural changes to disk. Runs first so the
    //    outbound steps below see a tree that already agrees about paths.
    if (opts.inbound) {
      const applied = await this.applyInbound(vaultId, {
        folders,
        notes,
        titles,
        serverFolders,
        serverNotes,
        tombstones: noteRegistry.tombstones,
        folderTombstones: folderRegistry.tombstones,
      });
      if (this.stale()) return false;
      if (applied.changedDisk) {
        mutated = true;
        // One re-read, only when we actually moved something. Without it the steps
        // below still see the OLD path as a local note missing from the server (so
        // they re-register it) and the NEW path as server-only (so they materialize
        // an empty file over it) — the duplicate we just fixed, reintroduced.
        // Patching the in-memory lists by hand instead is the dual-bookkeeping that
        // caused this class of bug in the first place.
        const reread = await this.readFullTree();
        if (this.stale()) return false;
        ({ folders, notes } = flattenTree(reread));
        titles = await ipc.listNoteTitles(this.epoch());
        if (this.stale()) return false;
        // Re-read the server's notes too: `move_note` bumps rows we may have just
        // raced, and a stale list here would undo the move we just applied.
        const fresh = await this.api.listNoteRegistry(vaultId);
        if (this.stale()) return false;
        serverNotes = fresh.notes;
      }
      this.inboundSuppressed = applied.suppress;
    } else {
      this.inboundSuppressed = new Set();
    }

    // Published from the FINAL note list (the inbound branch above may have
    // re-read it), so the "edited by" tags reflect the same rows the rest of this
    // pass reconciles against.
    this.publishNoteMeta(serverNotes);
    this.publishColors(serverFolders, serverNotes);

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
    //
    // The path → id map is RE-DERIVED from the server's listing, not merely added
    // to. A folder the server moved keeps its id under a new path, and the old
    // path's entry used to survive here forever. This device then believed the
    // old directory — still on disk, e.g. holding a `.txt` the index doesn't key
    // and so the per-note rename never carried — was registered, never re-created
    // it, and registered any note inside it with the MOVED folder's id. The server
    // rightly refused that as `path_folder_mismatch`, on every pull, forever:
    // "1 not synced" with nothing the user could do about it.
    const serverFolderByPath = new Map(serverFolders.map((f) => [f.path, f.id] as const));
    for (const [rp, id] of [...this.folderByPath]) {
      if (serverFolderByPath.get(rp) !== id) this.folderByPath.delete(rp);
    }
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
    // `inboundSuppressed` is what stops the ghost. A note the server has DELETED
    // (or that we've lost access to) is still on disk, so it looks "missing from
    // the server" here and used to be re-created — which the server answers 201 to
    // without clearing `deleted_at`, leaving a sidebar entry that can never sync.
    const missingNotes = notes.filter(
      (n) => !resolvedNotePaths.has(n.path) && !this.inboundSuppressed.has(n.path),
    );

    this.sink.phase("registering", missingFolders.length + missingNotes.length);

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
            mutated = true;
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
    if (this.stale()) return mutated;

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
          mutated = true;
          this.sink.item("ok");
          return;
        }
        // 409 = this note's local doc_id is already a note in a DIFFERENT vault
        // (e.g. this folder was previously synced to another vault whose ids the
        // local index still carries). Deliberately leave it UNMAPPED: the note
        // keeps working locally, whereas mapping it would point sync at a doc the
        // user has no grant on, which only yields a permanent 403. Rotating the
        // local doc_id to rejoin such a note to this vault is not implemented.
        const code = errorCode(out.error) ?? (isConflict(out.error) ? "doc_id_conflict" : null);
        // The server says the folder id we sent is not the folder at this path:
        // our mapping for the parent is stale (see step 2). Drop it so the next
        // pass re-creates the folder and this note registers — belt to step 2's
        // braces, for a listing that changed between the two reads of one pass.
        if (code === "path_folder_mismatch") this.folderByPath.delete(parentDir(rp));
        this.recordFailure({
          kind: "note",
          path: rp,
          docId,
          reason: reasonOf(out.error),
          code,
        });
        this.sink.item("failed");
      },
      { concurrency: REGISTRY_CONCURRENCY, shouldStop: () => this.stopRun() },
    );
    if (this.stale()) return mutated;

    // 4. Prune mappings for notes that no longer exist anywhere (deleted on the
    //    server AND absent locally), then checkpoint the map.
    for (const [rp, m] of [...this.byPath]) {
      if (!resolvedNotePaths.has(rp)) {
        this.byPath.delete(rp);
        this.byDocId.delete(m.docId);
        this.notifyMapChanged();
      }
    }
    // The push checkpoint describes docs we still track OR still remember in the
    // baseline. The baseline part is load-bearing: a note deleted remotely leaves
    // the server listing (and hence `byDocId`) on the pass that LEARNS about the
    // delete, but its file may only be trashed on a LATER pass — and the trash
    // executor refuses any doc whose content was never confirmed upstream.
    // Pruning `pushed` by `byDocId` alone erased that confirmation in between,
    // which is how already-synced notes turned into permanent "left on disk"
    // orphans with an error badge that never cleared.
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.pushed.delete(docId);
      }
    }
    checkpoint.touch();
    await checkpoint.flush();
    if (this.stale()) return mutated;

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
          mutated = true;
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

    // 6. Record what we now agree on, for the NEXT pass to compare against.
    //
    //    Accumulative, not a mirror of `byDocId`: entries for docs we've lost
    //    access to are kept deliberately. They're pruned from `byPath` above, so
    //    without keeping them here the next pass would see a brand-new local note
    //    and re-register it — the ghost returning on every other pull. Entries only
    //    leave when the file leaves (see `applyInbound`).
    for (const [docId, rp] of this.byDocId) this.baselineDocs.set(docId, rp);
    this.baselineVaultId = vaultId;
    // Flushed, not just touched: the baseline is only useful to the NEXT run, so
    // one that never reaches disk is one inbound reconciliation that silently
    // can't happen after a relaunch.
    checkpoint.touch();
    await checkpoint.flush();
    return mutated;
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
    // Case-insensitive, because on macOS/Windows a case-variant of a path we
    // already track is the SAME FILE — registering it would map one file to two
    // doc_ids and start the ping-pong (see `canonicalNotePath`).
    const mappedAs = this.canonicalNotePath(relPath);
    if (mappedAs) return this.byPath.get(mappedAs) ?? null;
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
      // Key by the path the SERVER says this doc lives at. It adopts by path
      // case-insensitively, so when its spelling differs from ours this is how
      // the two converge — keying by our own `relPath` instead would leave the
      // server's spelling unmapped and re-register it on every pass.
      this.setMapping(noteRelPath(created) ?? relPath, mapping.docId, vaultId);
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
    // Case-insensitive for the same reason as `registerNote`: one directory on
    // disk must not become two folder rows whose subtrees then fork.
    const mappedAs = this.canonicalFolderPath(relPath);
    if (mappedAs) return this.folderByPath.get(mappedAs) ?? null;
    try {
      const parentId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createFolder({
        vaultId,
        name,
        path: relPath,
        parentId,
      });
      if (this.stale() || this.serverVaultId !== vaultId) return null;
      // The server's canonical spelling, as in `registerNote`.
      this.folderByPath.set(created.path ?? relPath, created.id);
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

  /**
   * Propagate a delete of a folder subtree or a note to the server.
   *
   * THROWS when the server refused (offline, 403): callers run server-first —
   * `deletePaths` only removes the local files once the server rows are gone —
   * so a swallowed failure here would let the local delete proceed and the next
   * pull resurrect the item as an empty ghost. A 404 is treated as success: the
   * row is already gone, which is the goal state.
   */
  async deletePath(path: string): Promise<void> {
    if (this.stale()) return;
    const vaultId = this.serverVaultId;
    if (!vaultId) return;
    const folderId = this.folderByPath.get(path);
    if (folderId) {
      try {
        await this.api.deleteFolder(folderId);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
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
        if (!(e instanceof ApiError && e.status === 404)) throw e;
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

  /** Drop push-checkpoint entries for docs we neither track nor remember in the
   *  baseline (see the pass-end prune in `syncStructure` for why the baseline
   *  keeps a confirmation alive until the file actually leaves). */
  private prunePushed(): void {
    for (const docId of [...this.pushed]) {
      if (!this.byDocId.has(docId) && !this.baselineDocs.has(docId)) {
        this.pushed.delete(docId);
      }
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
