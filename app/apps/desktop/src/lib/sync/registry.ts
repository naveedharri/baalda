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

import {
  ApiClient,
  noteDocId,
  noteRelPath,
  vaultOrgId,
  type RegisteredFolder,
} from "../api";
import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";
import { seedWelcomeContent } from "../vault/seed";

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
}

export interface ReconcileInput {
  /** Active organization to create the vault under (required to create). */
  organizationId: string;
  /** Display name for a newly created server vault. */
  vaultName: string;
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

export class VaultRegistry {
  private serverVaultId: string | null = null;
  private byPath = new Map<string, DocMapping>();
  /** Reverse of byPath: docId → relPath, for the vault sync engine (spec 05). */
  private byDocId = new Map<string, string>();
  private folderByPath = new Map<string, string>();

  constructor(private readonly api: ApiClient) {}

  get vaultId(): string | null {
    return this.serverVaultId;
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

  /** Server folder id for a folder's vault-relative path, if registered. */
  getFolderId(relPath: string): string | null {
    return this.folderByPath.get(relPath) ?? null;
  }

  private async loadConfig(): Promise<VaultSyncConfig> {
    try {
      const raw = await ipc.getVaultConfig();
      if (!raw) return {};
      return JSON.parse(raw) as VaultSyncConfig;
    } catch {
      return {};
    }
  }

  private async saveConfig(cfg: VaultSyncConfig): Promise<void> {
    await ipc.setVaultConfig(JSON.stringify(cfg, null, 2));
  }

  /**
   * Ensure the server knows this vault's folders + notes; adopt existing ids,
   * create missing rows, and persist the mapping. Idempotent.
   *
   * Returns `{ seeded }` — true only when this call wrote first-run starter
   * content into a brand-new, empty vault (so the caller can open it).
   */
  async reconcile(
    input: ReconcileInput,
    tree: TreeNode,
  ): Promise<{ seeded: boolean }> {
    const cfg = await this.loadConfig();

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
    const inOrg = vaults.filter((v) => vaultOrgId(v) === input.organizationId);
    let vaultId = cfg.serverVaultId ?? null;
    if (vaultId && !inOrg.some((v) => v.id === vaultId)) vaultId = null;
    if (!vaultId) {
      const vault =
        inOrg[0] ??
        (await this.api.createVault({
          name: input.vaultName,
          organizationId: input.organizationId,
        }));
      vaultId = vault.id;
    }
    this.serverVaultId = vaultId;

    // 1b. First-run seeding. A brand-new vault — nothing on the server AND
    //     an empty local folder — gets welcome/starter content so the vault
    //     isn't an empty void. We seed BEFORE flattening so the files register
    //     as ordinary server docs in steps 2–4. Skipped when the server already
    //     has notes (joining/rejoining a populated vault) or the folder
    //     already has content — those paths adopt/materialize instead.
    const serverNotes = await this.api.listNotes(vaultId);
    let workingTree = tree;
    let seeded = false;
    const localFlat = flattenTree(tree);
    if (
      serverNotes.length === 0 &&
      localFlat.notes.length === 0 &&
      localFlat.folders.length === 0
    ) {
      await seedWelcomeContent();
      workingTree = await ipc.listTree();
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
    if (!this.serverVaultId) return;
    const tree = await ipc.listTree();
    await this.syncStructure(this.serverVaultId, tree);
  }

  /**
   * The shared core of reconcile/pull: make the server + this device agree on the
   * folder/note set. Adopts existing rows by path, creates missing ones (reusing
   * local doc_ids), materializes server-only notes onto disk, and persists the
   * {relPath → docId} + {folderPath → id} maps to `.context/config.json`.
   */
  private async syncStructure(vaultId: string, workingTree: TreeNode): Promise<void> {
    const serverFolders = await this.api.listFolders(vaultId);
    const serverNotes = await this.api.listNotes(vaultId);
    const { folders, notes } = flattenTree(workingTree);

    // 2. Folders: adopt by path, create missing (parents first).
    const folderIdByPath = new Map<string, string>();
    for (const f of serverFolders) folderIdByPath.set(f.path, f.id);

    for (const f of folders) {
      if (folderIdByPath.has(f.path)) continue;
      const parentPath = parentDir(f.path);
      const parentId = parentPath ? (folderIdByPath.get(parentPath) ?? null) : null;
      try {
        const created: RegisteredFolder = await this.api.createFolder({
          vaultId,
          name: f.name,
          path: f.path,
          parentId,
        });
        folderIdByPath.set(f.path, created.id);
      } catch (e) {
        console.error("[registry] createFolder failed", f.path, e);
      }
    }
    this.folderByPath = folderIdByPath;

    // 3. Notes: adopt by relPath, create missing. Any first-run seeding happened
    //    in reconcile before this runs; the seeded files register here as docs.
    const docIdByPath = new Map<string, string>();
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp) docIdByPath.set(rp, noteDocId(n));
    }

    const titles = await ipc.listNoteTitles();
    const titleByPath = new Map(titles.map((t) => [t.path, t.title] as const));
    // The local index already keyed each note by a stable doc_id. Supply it as
    // the server id so a note has ONE identity across the .md file, the local
    // CRDT store, and the server (the invariant: key by doc_id, never by path).
    // Omitting it lets the server mint a *different* random id, which forks the
    // note — the editor's bridge persists CRDT under the local id while sync
    // reads/writes the server id, so content silently fails to appear.
    const idByPath = new Map(titles.map((t) => [t.path, t.id] as const));

    for (const note of notes) {
      const rp = note.path;
      if (docIdByPath.has(rp)) continue;
      const folderId = folderIdByPath.get(parentDir(rp)) ?? null;
      try {
        const created = await this.api.createNote({
          vaultId,
          relPath: rp,
          title: titleByPath.get(rp) ?? note.name,
          folderId,
          docId: idByPath.get(rp),
        });
        docIdByPath.set(rp, noteDocId(created));
      } catch (e) {
        console.error("[registry] createNote failed", rp, e);
      }
    }

    // 4. Build the in-memory map + persist config.
    this.byPath.clear();
    this.byDocId.clear();
    const docs: Record<string, string> = {};
    for (const [rp, docId] of docIdByPath) {
      this.byPath.set(rp, { vaultId, docId });
      this.byDocId.set(docId, rp);
      docs[rp] = docId;
    }
    const folderCfg: Record<string, string> = {};
    for (const [rp, id] of folderIdByPath) folderCfg[rp] = id;

    await this.saveConfig({ serverVaultId: vaultId, docs, folders: folderCfg });

    // 5. Materialize server-only notes locally. This is what makes a folder
    //    that's empty on this device (a just-joined vault, or a fresh
    //    per-vault folder) actually show the vault's notes. We write an
    //    empty file — `write_note` creates any missing parent folders — and the
    //    real content hydrates lazily when the note is opened (pull-before-seed
    //    in docSession, which never seeds a non-empty server doc from an empty
    //    file, so this can't clobber anything).
    const localNotePaths = new Set(notes.map((n) => n.path));
    for (const rp of docIdByPath.keys()) {
      if (localNotePaths.has(rp)) continue;
      try {
        await ipc.writeNote(rp, "");
      } catch (e) {
        console.warn("[registry] materialize failed", rp, e);
      }
    }
  }

  /**
   * Register a single newly-created note on demand (e.g. after ⌘N) and return
   * its mapping, or null if the vault isn't reconciled yet.
   */
  async registerNote(
    relPath: string,
    title: string | null,
    docId?: string,
  ): Promise<DocMapping | null> {
    if (!this.serverVaultId) return null;
    const existing = this.byPath.get(relPath);
    if (existing) return existing;
    try {
      const folderId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createNote({
        vaultId: this.serverVaultId,
        relPath,
        title,
        folderId,
        // Reuse the local index doc_id so the server doesn't fork a second
        // identity for this note (see reconcile's idByPath note).
        docId,
      });
      const mapping = { vaultId: this.serverVaultId, docId: noteDocId(created) };
      this.byPath.set(relPath, mapping);
      this.byDocId.set(mapping.docId, relPath);
      const cfg = await this.loadConfig();
      cfg.docs = { ...(cfg.docs ?? {}), [relPath]: mapping.docId };
      cfg.serverVaultId = this.serverVaultId;
      await this.saveConfig(cfg);
      return mapping;
    } catch (e) {
      console.error("[registry] registerNote failed", relPath, e);
      return null;
    }
  }

  /**
   * Register a newly-created folder on the server so teammates see it live and
   * it can be shared. Idempotent (the server adopts an existing path). No-op if
   * the vault isn't reconciled yet.
   */
  async registerFolder(relPath: string, name: string): Promise<string | null> {
    if (!this.serverVaultId) return null;
    const existing = this.folderByPath.get(relPath);
    if (existing) return existing;
    try {
      const parentId = this.folderByPath.get(parentDir(relPath)) ?? null;
      const created = await this.api.createFolder({
        vaultId: this.serverVaultId,
        name,
        path: relPath,
        parentId,
      });
      this.folderByPath.set(relPath, created.id);
      await this.persist();
      return created.id;
    } catch (e) {
      console.error("[registry] registerFolder failed", relPath, e);
      return null;
    }
  }

  /**
   * Propagate a local rename/move to the server. Handles both a folder (with its
   * whole subtree of paths) and a single note. doc_ids never change — only the
   * path columns move — so open docs and backlinks survive (spec invariant).
   */
  async renamePath(oldPath: string, newPath: string): Promise<void> {
    if (!this.serverVaultId) return;
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
      this.folderByPath = remapPrefix(this.folderByPath, oldPath, newPath);
      this.byPath = remapPrefix(this.byPath, oldPath, newPath);
      this.rebuildByDocId();
      await this.persist();
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
      this.byPath.delete(oldPath);
      this.byPath.set(newPath, mapping);
      this.byDocId.set(mapping.docId, newPath);
      await this.persist();
    }
  }

  /** Propagate a local delete of a folder subtree or a note to the server. */
  async deletePath(path: string): Promise<void> {
    if (!this.serverVaultId) return;
    const folderId = this.folderByPath.get(path);
    if (folderId) {
      try {
        await this.api.deleteFolder(folderId);
      } catch (e) {
        console.error("[registry] deleteFolder failed", path, e);
        return;
      }
      this.folderByPath = dropPrefix(this.folderByPath, path);
      this.byPath = dropPrefix(this.byPath, path);
      this.rebuildByDocId();
      await this.persist();
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
      this.byPath.delete(path);
      this.byDocId.delete(mapping.docId);
      await this.persist();
    }
  }

  /** Rebuild byDocId from byPath after a bulk prefix remap/drop. */
  private rebuildByDocId(): void {
    this.byDocId.clear();
    for (const [rp, m] of this.byPath) this.byDocId.set(m.docId, rp);
  }

  /** Write the current in-memory maps back to `.context/config.json`. */
  private async persist(): Promise<void> {
    if (!this.serverVaultId) return;
    const docs: Record<string, string> = {};
    for (const [rp, m] of this.byPath) docs[rp] = m.docId;
    const folders: Record<string, string> = {};
    for (const [rp, id] of this.folderByPath) folders[rp] = id;
    await this.saveConfig({ serverVaultId: this.serverVaultId, docs, folders });
  }
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
