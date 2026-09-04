// All Tauri `invoke` calls and event subscriptions live here, behind a typed
// surface. The rest of the UI imports from this module only — it never touches
// `@tauri-apps/api` directly. This keeps later phases (a Yjs sync layer) able to
// swap the transport without hunting invoke() calls across components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Open an external URL (markdown links) in the user's default browser. */
export const openExternal = (url: string) => openUrl(url);

/**
 * Show a vault folder in the OS file manager (Finder / Explorer / xdg).
 *
 * `openPath` opens the folder itself — what "open in folder" means to a user —
 * but it's scoped to `$HOME/**` in `capabilities/default.json`, so a vault on
 * an external volume is rejected. `revealItemInDir` carries no scope, so it
 * covers those: the folder is selected in its parent rather than opened, which
 * beats a button that does nothing.
 */
export const openInFileManager = async (path: string): Promise<void> => {
  try {
    await openPath(path);
  } catch {
    await revealItemInDir(path);
  }
};

/**
 * Reveal one note or folder in the OS file manager — selected in its parent,
 * which is what "Reveal in Finder" means everywhere else.
 *
 * The reverse fallback order from {@link openInFileManager}: `revealItemInDir`
 * is the right verb here and carries no path scope, so it works for a vault on
 * an external volume too. `openPath` is the backstop for a platform where
 * revealing isn't wired up — opening a folder still beats a dead menu item, and
 * for a file the OS opens it in its default app.
 */
export const revealInFileManager = async (path: string): Promise<void> => {
  try {
    await revealItemInDir(path);
  } catch {
    await openPath(path);
  }
};

/** What to call "reveal in the file manager" on this platform. */
export function revealLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac|iPhone|iPad/i.test(ua)) return "Reveal in Finder";
  if (/Win/i.test(ua)) return "Show in Explorer";
  return "Show in file manager";
}

// ---- Types (mirror the Rust structs, serialized camelCase) ---------------

export interface VaultInfo {
  path: string;
  name: string;
  /**
   * The Rust vault epoch this info belongs to (see `state::Inner::vault_epoch`).
   * Rust holds ONE global vault slot, so a vault-relative command resolves
   * against whatever vault is open when it *lands*. Every open bumps the epoch;
   * a caller pins the epoch it started under (see `VaultScope.vaultEpoch`) and
   * Rust rejects the call with `vault-mismatch: …` rather than writing vault A's
   * data into vault B. Meaningful only for infos returned by an *open*;
   * `getLastVault` reports the epoch that was current before it opened anything.
   */
  epoch: number;
}

/**
 * The epoch to pin a vault-relative command to, or `null` for "don't enforce"
 * (UI reads and user-driven edits keep the legacy whatever-is-open behaviour).
 */
export type VaultEpoch = number | null | undefined;

/** True if `err` is Rust refusing a call because the vault changed underneath it. */
export function isVaultMismatch(err: unknown): boolean {
  return typeof err === "string"
    ? err.startsWith("vault-mismatch")
    : err instanceof Error && err.message.startsWith("vault-mismatch");
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  /** Directories only: is `children` the real listing, or the lazy placeholder?
   *  `children: []` alone is ambiguous — a folder with no notes and a folder
   *  nobody has expanded look identical — which is why an unexpanded folder used
   *  to be labelled "empty" in the sidebar. Absent ⇒ treat as not loaded. */
  childrenLoaded?: boolean;
  /** Last-modified time in epoch millis (0 when the OS wouldn't say). Drives the
   *  sidebar's "Recently modified" sort. Absent on nodes synthesized client-side
   *  before a refresh lands. */
  modified?: number;
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  snippet: string;
}

export interface Backlink {
  id: string;
  path: string;
  title: string;
  linkText: string;
}

export interface NoteMeta {
  id: string;
  path: string;
  title: string;
  mtime: number;
  sha256: string;
  frontmatter: string | null;
  tags: string[];
}

export interface NoteTitle {
  id: string;
  path: string;
  title: string;
}

export interface ResolvedLink {
  id: string;
  path: string;
}

/** A doc's persisted CRDT state (spec 02 §4). Binary blobs cross IPC as number arrays. */
export interface YjsState {
  snapshot: number[] | null;
  updates: number[][];
  updateCount: number;
}

export interface FileChanged {
  path: string;
  kind: "modified" | "removed" | "tree";
}

/** One attachment file's metadata (mirrors the Rust `AttachmentMeta`). */
export interface AttachmentMeta {
  relPath: string;
  size: number;
  sha256: string;
}

/** Outcome of an import (mirrors the Rust `ImportSummary`). */
export interface ImportSummary {
  /** Vault-relative paths of the created top-level items. */
  imported: string[];
  /** Total files copied (including nested + attachments). */
  files: number;
  /** Files/dirs skipped (ignored names, unreadable sources, …). */
  skipped: number;
}

// ---- Vault ----------------------------------------------------------------

export const pickVault = () => invoke<VaultInfo | null>("pick_vault");
export const openVault = (path: string) => invoke<VaultInfo>("open_vault", { path });
export const getLastVault = () => invoke<VaultInfo | null>("get_last_vault");
/** Forget the launch auto-reopen target so a reload/relaunch lands on the
 *  welcome screen (recents keep listing the vault; the next open re-arms it). */
export const clearLastVault = () => invoke<void>("clear_last_vault");

/** A recently opened vault (newest first); `openedAt` is epoch-ms (0 if unknown). */
export interface RecentVault {
  path: string;
  name: string;
  openedAt: number;
}
/** Recently opened vaults, newest first, pruned to those that still exist. */
export const getRecentVaults = () => invoke<RecentVault[]>("get_recent_vaults");
/** Forget one vault from the recents list (files on disk are kept). */
export const removeRecentVault = (path: string) =>
  invoke<void>("remove_recent_vault", { path });
/** Move a local vault's folder (and all its notes) to the OS trash, then forget
 *  it from recents. Destructive — the on-disk files are the only copy. */
export const deleteVault = (path: string) =>
  invoke<void>("delete_vault", { path });
/** Create a new empty vault folder `<parent>/<name>` and open it. */
export const createVault = (parent: string, name: string) =>
  invoke<VaultInfo>("create_vault", { parent, name });

/** True if a folder already looks like a vault (has `.context/` or `.md` notes). */
export const isVault = (path: string) => invoke<boolean>("is_vault", { path });

// ---- Vaults root + `current` pointer (per-vault folders) -------------------
// The app manages one root dir under which each vault gets a subfolder, and the
// active vault's folder is mirrored to `<root>/current` for external tools.

/** Effective managed vaults root (auto-initialized to ~/Baalda on first call). */
export const getVaultsRoot = () => invoke<string>("get_vaults_root");
export const setVaultsRoot = (path: string) =>
  invoke<void>("set_vaults_root", { path });
/** Native folder picker for the managed vaults root; persists + returns it. */
export const pickVaultsRoot = () => invoke<string | null>("pick_vaults_root");
/** Native folder picker that only returns the path (does not open it). */
export const pickFolder = () => invoke<string | null>("pick_folder");
/** Native multi-file picker; returns chosen absolute paths (null if cancelled). */
export const pickFiles = () => invoke<string[] | null>("pick_files");
/** Native save-file dialog; returns the chosen absolute path (null if cancelled). */
export const saveFile = (defaultName: string) =>
  invoke<string | null>("save_file", { defaultName });
/** Open `path` as the active vault and repoint `<root>/current` to it.
 *  Pass `create: true` ONLY when deliberately minting a new folder (auto-folder
 *  on switch, "start empty") — reopening a remembered binding must not mkdir,
 *  or a folder the user moved in Finder gets silently resurrected empty and the
 *  registry materializes a duplicate copy of the vault into it. */
export const openVaultInRoot = (path: string, opts?: { create?: boolean }) =>
  invoke<VaultInfo>("open_vault_in_root", { path, create: opts?.create ?? false });
/** Does this absolute path exist as a directory? */
export const folderExists = (path: string) =>
  invoke<boolean>("folder_exists", { path });
/** Raw `.context/config.json` of an arbitrary folder WITHOUT opening it (null if
 *  the folder isn't a vault). Rediscovery probe — see `setActiveOrganization`. */
export const peekVaultConfig = (path: string) =>
  invoke<string | null>("peek_vault_config", { path });
/** Immediate subdirectories of the managed vaults root (absolute paths). */
export const listVaultsRootDirs = () =>
  invoke<string[]>("list_vaults_root_dirs");

// ---- Tree + files ---------------------------------------------------------

// The `expectedEpoch` argument on the commands below is the vault-isolation
// guard: pass the epoch your VaultScope was opened under and Rust refuses the
// call once a different vault is open. Omit it (or pass null) for unscoped UI
// work. Reads take it too when their result is used to write (`listTree` and
// `listNoteTitles` feed the registry's server-side structure sync).
export const listTree = (expectedEpoch?: VaultEpoch) =>
  invoke<TreeNode>("list_tree", { expectedEpoch: expectedEpoch ?? null });
/** Lazy sidebar loading: immediate children of one dir ("" = root). */
export const listChildren = (path: string, expectedEpoch?: VaultEpoch) =>
  invoke<TreeNode[]>("list_children", { path, expectedEpoch: expectedEpoch ?? null });
export const readNote = (path: string, expectedEpoch?: VaultEpoch) =>
  invoke<string>("read_note", { path, expectedEpoch: expectedEpoch ?? null });
export const writeNote = (path: string, content: string, expectedEpoch?: VaultEpoch) =>
  invoke<void>("write_note", { path, content, expectedEpoch: expectedEpoch ?? null });
/** Create a note only if the path is free. Resolves true when it was created,
 *  false when a file was already there (untouched). The registry materializes
 *  server-only notes through THIS, never `writeNote`, so a wrong "this device
 *  doesn't have it" decision can't empty a real note. */
export const writeNoteIfMissing = (
  path: string,
  content: string,
  expectedEpoch?: VaultEpoch,
) =>
  invoke<boolean>("write_note_if_missing", {
    path,
    content,
    expectedEpoch: expectedEpoch ?? null,
  });
export const createNote = (parent: string, name: string, expectedEpoch?: VaultEpoch) =>
  invoke<string>("create_note", { parent, name, expectedEpoch: expectedEpoch ?? null });
export const createFolder = (parent: string, name: string, expectedEpoch?: VaultEpoch) =>
  invoke<string>("create_folder", { parent, name, expectedEpoch: expectedEpoch ?? null });
// Pass `expectedEpoch` whenever the call sits behind an await — a multi-select
// loop or a native dialog. A rename/delete that lands after a vault switch would
// otherwise move or destroy the same relative path in the vault the user just
// opened.
export const renamePath = (from: string, to: string, expectedEpoch?: VaultEpoch) =>
  invoke<string>("rename_path", { from, to, expectedEpoch: expectedEpoch ?? null });
/** Idempotent folder create — safe to call on every reconcile. */
export const ensureFolder = (path: string, expectedEpoch?: VaultEpoch) =>
  invoke<void>("ensure_folder", { path, expectedEpoch: expectedEpoch ?? null });
/**
 * Move a note into `.context/trash/<stamp>/…` instead of deleting it, and return
 * the trash-relative destination. Used for remote deletes, so applying a
 * teammate's delete is recoverable rather than final.
 */
export const trashNote = (path: string, stamp: string, expectedEpoch?: VaultEpoch) =>
  invoke<string>("trash_note", { path, stamp, expectedEpoch: expectedEpoch ?? null });
export const deletePath = (path: string, expectedEpoch?: VaultEpoch) =>
  invoke<void>("delete_path", { path, expectedEpoch: expectedEpoch ?? null });
/**
 * Remove a folder the server has deleted — only if it is empty by now. Resolves
 * true when removed (or already gone); false when anything still lives inside,
 * in which case the folder stays, deliberately.
 */
export const deleteFolderIfEmpty = (path: string, expectedEpoch?: VaultEpoch) =>
  invoke<boolean>("delete_folder_if_empty", { path, expectedEpoch: expectedEpoch ?? null });

/** Import external files/folders (absolute host paths) into `dest` (vault-relative). */
export const importPaths = (dest: string, sources: string[], expectedEpoch?: VaultEpoch) =>
  invoke<ImportSummary>("import_paths", {
    dest,
    sources,
    expectedEpoch: expectedEpoch ?? null,
  });
/** Export a note, folder subtree, or the whole vault (`rel === ""`) to `dest`. */
export const exportPath = (rel: string, dest: string, expectedEpoch?: VaultEpoch) =>
  invoke<void>("export_path", { rel, dest, expectedEpoch: expectedEpoch ?? null });

// ---- Queries --------------------------------------------------------------

export const searchNotes = (query: string) =>
  invoke<SearchResult[]>("search_notes", { query });
export const getBacklinks = (noteId: string) =>
  invoke<Backlink[]>("get_backlinks", { noteId });
/** Every resolved graph edge (source id -> target id) in one call — backs the
 *  Graph view instead of one getBacklinks per note. */
export const getGraphEdges = () =>
  invoke<{ source: string; target: string }[]>("graph_edges");
/** Only the edges touching `noteIds` — the Graph view's per-change delta (#83). */
export const getGraphEdgesFor = (noteIds: string[]) =>
  invoke<{ source: string; target: string }[]>("graph_edges_for", { noteIds });
export const getNoteMeta = (path: string) =>
  invoke<NoteMeta | null>("get_note_meta", { path });
export const resolveWikilink = (name: string) =>
  invoke<ResolvedLink | null>("resolve_wikilink", { name });
export const listNoteTitles = (expectedEpoch?: VaultEpoch) =>
  invoke<NoteTitle[]>("list_note_titles", { expectedEpoch: expectedEpoch ?? null });

// ---- CRDT persistence (Phase 1, spec 02 §4) ------------------------------
// Binary Yjs updates are marshalled as plain number arrays over the IPC bridge.

export const appendYjsUpdate = (
  docId: string,
  update: Uint8Array,
  expectedEpoch?: VaultEpoch,
) =>
  invoke<void>("append_yjs_update", {
    docId,
    update: Array.from(update),
    expectedEpoch: expectedEpoch ?? null,
  });

export const loadYjsState = (docId: string, expectedEpoch?: VaultEpoch) =>
  invoke<YjsState>("load_yjs_state", { docId, expectedEpoch: expectedEpoch ?? null });

export const saveYjsSnapshot = (
  docId: string,
  snapshot: Uint8Array,
  stateVector: Uint8Array,
  expectedEpoch?: VaultEpoch,
) =>
  invoke<void>("save_yjs_snapshot", {
    docId,
    snapshot: Array.from(snapshot),
    stateVector: Array.from(stateVector),
    expectedEpoch: expectedEpoch ?? null,
  });

/**
 * Persist a batch of per-doc Yjs state vectors — the DURABLE form of the vault
 * sync engine's `hello` manifest.
 *
 * Without this the manifest came from an in-memory cache, so it was empty on
 * every launch and the server re-sent the FULL state of every readable doc,
 * forever. Batched (one IPC call + one SQLite transaction) because the vault-wide
 * feed touches many docs at once.
 */
export const saveYjsStateVectors = (
  entries: Array<[docId: string, stateVector: Uint8Array]>,
  expectedEpoch?: VaultEpoch,
) =>
  invoke<void>("save_yjs_state_vectors", {
    entries: entries.map(([docId, sv]) => [docId, Array.from(sv)]),
    expectedEpoch: expectedEpoch ?? null,
  });

/** Every state vector this vault holds, to rebuild the manifest on launch. */
export const listYjsStateVectors = (expectedEpoch?: VaultEpoch) =>
  invoke<{ docId: string; stateVector: number[] }[]>("list_yjs_state_vectors", {
    expectedEpoch: expectedEpoch ?? null,
  }).then((rows) =>
    rows.map((r) => ({ docId: r.docId, stateVector: Uint8Array.from(r.stateVector) })),
  );

// ---- Attachment binary I/O (Phase 3 blob store, spec 02 §2) ---------------
// Raw bytes are marshalled as plain number arrays over the IPC bridge, like the
// Yjs updates above. All paths are validated inside the vault by Rust.

export const readBinaryFile = (relPath: string, expectedEpoch?: VaultEpoch) =>
  invoke<number[]>("read_binary_file", {
    relPath,
    expectedEpoch: expectedEpoch ?? null,
  }).then((a) => Uint8Array.from(a));

export const writeBinaryFile = (
  relPath: string,
  bytes: Uint8Array,
  expectedEpoch?: VaultEpoch,
) =>
  invoke<void>("write_binary_file", {
    relPath,
    bytes: Array.from(bytes),
    expectedEpoch: expectedEpoch ?? null,
  });

export const listAttachments = (expectedEpoch?: VaultEpoch) =>
  invoke<AttachmentMeta[]>("list_attachments", { expectedEpoch: expectedEpoch ?? null });

/** Read a dropped/picked host file by absolute path (not vault-scoped). */
export const readExternalFile = (path: string) =>
  invoke<number[]>("read_external_file", { path }).then((a) => Uint8Array.from(a));

// ---- OS keychain (Phase 2 auth, spec 04 §7) -------------------------------
// Session tokens live in the OS keychain, never in localStorage/plaintext.
// `serviceKey` namespaces the secret (e.g. `session:<serverUrl>`).

export const keychainSet = (serviceKey: string, value: string) =>
  invoke<void>("keychain_set", { serviceKey, value });

export const keychainGet = (serviceKey: string) =>
  invoke<string | null>("keychain_get", { serviceKey });

export const keychainDelete = (serviceKey: string) =>
  invoke<void>("keychain_delete", { serviceKey });

// ---- Google OAuth loopback (spec 04 §7) -----------------------------------
// The Rust core runs a one-shot 127.0.0.1 listener that catches the browser
// redirect at the end of Google sign-in. `listen` returns the ephemeral port
// (so the caller can build the callback URL); `await` blocks until the redirect
// lands and resolves with the one-time handoff code.

/** Loopback port + the single-use `state` nonce to embed in the callback URL. */
export interface OauthListen {
  port: number;
  state: string;
}
export const googleOauthListen = () => invoke<OauthListen>("google_oauth_listen");
export const googleOauthAwait = () => invoke<string>("google_oauth_await");

// ---- Sync server URL (app config, next to last-vault) ----------------------

export const getServerUrl = () => invoke<string | null>("get_server_url");
export const setServerUrl = (url: string | null) =>
  invoke<void>("set_server_url", { url });

// ---- Per-vault sync registry config (.context/config.json) ----------------
// Raw JSON string; the TS sync layer owns the schema (server vault id + doc-id
// map) so it travels with the vault across devices (spec 03 §5).

export const getVaultConfig = (expectedEpoch?: VaultEpoch) =>
  invoke<string | null>("get_vault_config", { expectedEpoch: expectedEpoch ?? null });
export const setVaultConfig = (content: string, expectedEpoch?: VaultEpoch) =>
  invoke<void>("set_vault_config", { content, expectedEpoch: expectedEpoch ?? null });

/** Epoch of the currently-open vault (0 if none). Used to start a VaultScope for
 *  a vault this call site didn't open itself (e.g. enabling sync on the folder
 *  that is already open). */
export const getVaultEpoch = () => invoke<number>("get_vault_epoch");

// ---- Events ---------------------------------------------------------------

/**
 * One watcher debounce batch (the Rust `FilesChanged` payload).
 *
 * The watcher emits ONE event per batch rather than one per file: a vault import
 * or an AI writing 200 notes used to cross the IPC boundary 200 times, each
 * costing a full round of listeners, a registry-pull re-arm and a sidebar
 * refresh re-arm.
 */
export interface FilesChanged {
  changes: FileChanged[];
}

/** Subscribe to whole watcher batches — what the sync layer wants, because a
 *  batch has exactly ONE structural conclusion to draw. */
export const onFilesChanged = (
  cb: (changes: FileChanged[]) => void,
): Promise<UnlistenFn> =>
  listen<FilesChanged>("files-changed", (event) => cb(event.payload?.changes ?? []));

/** Per-item adapter over {@link onFilesChanged}, for callers that only care that
 *  *something* changed (the graph, the HTML view, the open note's bridge). */
export const onFileChanged = (cb: (e: FileChanged) => void): Promise<UnlistenFn> =>
  onFilesChanged((changes) => {
    for (const change of changes) cb(change);
  });

export const onVaultOpened = (cb: (v: VaultInfo) => void): Promise<UnlistenFn> =>
  listen<VaultInfo>("vault-opened", (event) => cb(event.payload));

/** The background index rebuild `open_vault` starts has committed (#84). */
export interface IndexReady {
  path: string;
  epoch: number;
  ok: boolean;
  ms: number;
}
export const onIndexReady = (cb: (e: IndexReady) => void): Promise<UnlistenFn> =>
  listen<IndexReady>("index-ready", (event) => cb(event.payload));
