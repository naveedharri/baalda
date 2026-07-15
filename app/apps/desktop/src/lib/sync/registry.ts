// Vault ↔ server registry reconciliation (spec 03 §5 "doc registry mapping").
//
// On vault-connect (signed in, with an active org) we make the server aware of
// this vault's folders and notes so that `doc_id`s are STABLE and SHARED across
// devices. The server is the source of truth for ids: we adopt existing rows by
// path and create only what's missing. The resulting {relPath → {vaultId, docId}}
// map is what the sync layer uses to name Hocuspocus documents.
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

/** Flatten a tree into folder paths and note paths (both vault-relative). */
export function flattenTree(root: TreeNode): { folders: TreeNode[]; notes: TreeNode[] } {
  const folders: TreeNode[] = [];
  const notes: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.isDir) {
      if (n.path) folders.push(n); // skip the root (empty path)
      for (const c of n.children ?? []) walk(c);
    } else {
      notes.push(n);
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
   * content into a brand-new, empty workspace (so the caller can open it).
   */
  async reconcile(
    input: ReconcileInput,
    tree: TreeNode,
  ): Promise<{ seeded: boolean }> {
    const cfg = await this.loadConfig();

    // 1. Ensure a server vault. Prefer the one recorded in config; verify it
    //    still exists; otherwise create a fresh one.
    let vaultId = cfg.serverVaultId ?? null;
    if (vaultId) {
      const vaults = await this.api.listVaults();
      if (!vaults.some((v) => v.id === vaultId)) vaultId = null;
    }
    if (!vaultId) {
      // Reuse a same-named vault in this org if present, else create.
      const vaults = await this.api.listVaults();
      const existing = vaults.find(
        (v) => v.name === input.vaultName && vaultOrgId(v) === input.organizationId,
      );
      const vault =
        existing ??
        (await this.api.createVault({
          name: input.vaultName,
          organizationId: input.organizationId,
        }));
      vaultId = vault.id;
    }
    this.serverVaultId = vaultId;

    // 1b. First-run seeding. A brand-new workspace — nothing on the server AND
    //     an empty local folder — gets welcome/starter content so the vault
    //     isn't an empty void. We seed BEFORE flattening so the files register
    //     as ordinary server docs in steps 2–4. Skipped when the server already
    //     has notes (joining/rejoining a populated workspace) or the folder
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

    const { folders, notes } = flattenTree(workingTree);

    // 2. Folders: adopt by path, create missing (parents first).
    const serverFolders = await this.api.listFolders(vaultId);
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

    // 3. Notes: adopt by relPath, create missing. (`serverNotes` was listed
    //    above, before any seeding — still accurate, since seeding only writes
    //    to disk; the seeded files are created on the server by this loop.)
    const docIdByPath = new Map<string, string>();
    for (const n of serverNotes) {
      const rp = noteRelPath(n);
      if (rp) docIdByPath.set(rp, noteDocId(n));
    }

    const titles = await ipc.listNoteTitles();
    const titleByPath = new Map(titles.map((t) => [t.path, t.title] as const));

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
    //    that's empty on this device (a just-joined workspace, or a fresh
    //    per-workspace folder) actually show the workspace's notes. We write an
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

    return { seeded };
  }

  /**
   * Register a single newly-created note on demand (e.g. after ⌘N) and return
   * its mapping, or null if the vault isn't reconciled yet.
   */
  async registerNote(relPath: string, title: string | null): Promise<DocMapping | null> {
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
}
