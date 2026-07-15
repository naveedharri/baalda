// All Tauri `invoke` calls and event subscriptions live here, behind a typed
// surface. The rest of the UI imports from this module only — it never touches
// `@tauri-apps/api` directly. This keeps later phases (a Yjs sync layer) able to
// swap the transport without hunting invoke() calls across components.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Open an external URL (markdown links) in the user's default browser. */
export const openExternal = (url: string) => openUrl(url);

// ---- Types (mirror the Rust structs, serialized camelCase) ---------------

export interface VaultInfo {
  path: string;
  name: string;
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
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

// ---- Vault ----------------------------------------------------------------

export const pickVault = () => invoke<VaultInfo | null>("pick_vault");
export const openVault = (path: string) => invoke<VaultInfo>("open_vault", { path });
export const getLastVault = () => invoke<VaultInfo | null>("get_last_vault");

// ---- Workspace root + `current` pointer (per-workspace folders) ------------
// The app manages one root dir; each workspace gets a subfolder, and the active
// workspace's folder is mirrored to `<root>/current` for external tools.

/** Effective managed root (auto-initialized to ~/Baalda on first call). */
export const getWorkspaceRoot = () => invoke<string>("get_workspace_root");
export const setWorkspaceRoot = (path: string) =>
  invoke<void>("set_workspace_root", { path });
/** Native folder picker for the managed root; persists + returns it. */
export const pickWorkspaceRoot = () => invoke<string | null>("pick_workspace_root");
/** Native folder picker that only returns the path (does not open it). */
export const pickFolder = () => invoke<string | null>("pick_folder");
/** Ensure `path` exists, repoint `<root>/current` to it, and open it as vault. */
export const openWorkspaceFolder = (path: string) =>
  invoke<VaultInfo>("open_workspace_folder", { path });

// ---- Tree + files ---------------------------------------------------------

export const listTree = () => invoke<TreeNode>("list_tree");
export const readNote = (path: string) => invoke<string>("read_note", { path });
export const writeNote = (path: string, content: string) =>
  invoke<void>("write_note", { path, content });
export const createNote = (parent: string, name: string) =>
  invoke<string>("create_note", { parent, name });
export const createFolder = (parent: string, name: string) =>
  invoke<string>("create_folder", { parent, name });
export const renamePath = (from: string, to: string) =>
  invoke<string>("rename_path", { from, to });
export const deletePath = (path: string) => invoke<void>("delete_path", { path });

// ---- Queries --------------------------------------------------------------

export const searchNotes = (query: string) =>
  invoke<SearchResult[]>("search_notes", { query });
export const getBacklinks = (noteId: string) =>
  invoke<Backlink[]>("get_backlinks", { noteId });
export const getNoteMeta = (path: string) =>
  invoke<NoteMeta | null>("get_note_meta", { path });
export const resolveWikilink = (name: string) =>
  invoke<ResolvedLink | null>("resolve_wikilink", { name });
export const listNoteTitles = () => invoke<NoteTitle[]>("list_note_titles");

// ---- CRDT persistence (Phase 1, spec 02 §4) ------------------------------
// Binary Yjs updates are marshalled as plain number arrays over the IPC bridge.

export const appendYjsUpdate = (docId: string, update: Uint8Array) =>
  invoke<void>("append_yjs_update", { docId, update: Array.from(update) });

export const loadYjsState = (docId: string) =>
  invoke<YjsState>("load_yjs_state", { docId });

export const saveYjsSnapshot = (
  docId: string,
  snapshot: Uint8Array,
  stateVector: Uint8Array,
) =>
  invoke<void>("save_yjs_snapshot", {
    docId,
    snapshot: Array.from(snapshot),
    stateVector: Array.from(stateVector),
  });

// ---- Attachment binary I/O (Phase 3 blob store, spec 02 §2) ---------------
// Raw bytes are marshalled as plain number arrays over the IPC bridge, like the
// Yjs updates above. All paths are validated inside the vault by Rust.

export const readBinaryFile = (relPath: string) =>
  invoke<number[]>("read_binary_file", { relPath }).then((a) => Uint8Array.from(a));

export const writeBinaryFile = (relPath: string, bytes: Uint8Array) =>
  invoke<void>("write_binary_file", { relPath, bytes: Array.from(bytes) });

export const listAttachments = () => invoke<AttachmentMeta[]>("list_attachments");

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

export const googleOauthListen = () => invoke<number>("google_oauth_listen");
export const googleOauthAwait = () => invoke<string>("google_oauth_await");

// ---- Sync server URL (app config, next to last-vault) ----------------------

export const getServerUrl = () => invoke<string | null>("get_server_url");
export const setServerUrl = (url: string | null) =>
  invoke<void>("set_server_url", { url });

// ---- Per-vault sync registry config (.context/config.json) ----------------
// Raw JSON string; the TS sync layer owns the schema (server vault id + doc-id
// map) so it travels with the vault across devices (spec 03 §5).

export const getVaultConfig = () => invoke<string | null>("get_vault_config");
export const setVaultConfig = (content: string) =>
  invoke<void>("set_vault_config", { content });

// ---- Events ---------------------------------------------------------------

export const onFileChanged = (cb: (e: FileChanged) => void): Promise<UnlistenFn> =>
  listen<FileChanged>("file-changed", (event) => cb(event.payload));

export const onVaultOpened = (cb: (v: VaultInfo) => void): Promise<UnlistenFn> =>
  listen<VaultInfo>("vault-opened", (event) => cb(event.payload));
