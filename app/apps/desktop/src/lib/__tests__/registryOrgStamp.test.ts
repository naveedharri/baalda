// The vault folder must be able to prove which vault (org) it belongs to: the
// org→folder binding lives in webview localStorage, which is per-device and
// loseable, and `setActiveOrganization`'s rediscovery pass re-derives it from
// `.context/config.json`. These tests pin that reconcile stamps the org id into
// the config it persists — the whole rediscovery mechanism hangs off this field.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({
    id: "root",
    name: "",
    path: "",
    isDir: true,
    children: [],
    childrenLoaded: true,
  })),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
  writeNoteIfMissing: vi.fn(async () => true),
}));
vi.mock("../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../api";
import * as ipc from "../ipc";
import { VaultRegistry } from "../sync/registry";

const ORG = "org-1";
const VAULT = { id: "vault-1", name: "V", organization_id: ORG };

function fakeApi() {
  return {
    listVaults: vi.fn(async () => [VAULT]),
    createVault: vi.fn(async () => VAULT),
    listFolders: vi.fn(async () => []),
    listFolderRegistry: vi.fn(async () => ({ folders: [], tombstones: [] })),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => []),
    listNoteRegistry: vi.fn(async () => ({ notes: [], tombstones: [] as string[] })),
    createNote: vi.fn(async (input: { relPath: string }) => ({
      id: `note-${input.relPath}`,
      rel_path: input.relPath,
    })),
  } as unknown as ApiClient;
}

function lastWrittenConfig(): Record<string, unknown> {
  const calls = vi.mocked(ipc.setVaultConfig).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(ipc.setVaultConfig).mockClear();
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
});

describe("VaultRegistry — organizationId stamp in .context/config.json", () => {
  it("stamps the reconciling org id alongside the collection id", async () => {
    const reg = new VaultRegistry(fakeApi());
    await reg.reconcile({ organizationId: ORG, vaultName: "V" });

    const cfg = lastWrittenConfig();
    expect(cfg.organizationId).toBe(ORG);
    expect(cfg.serverVaultId).toBe("vault-1");
  });

  it("re-stamps a legacy config that predates the field (silent in-place upgrade)", async () => {
    // A folder written by a pre-stamp version: serverVaultId only. One
    // reconcile under the new version must add organizationId — no migration.
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "vault-1", docs: {}, folders: {} }),
    );
    const reg = new VaultRegistry(fakeApi());
    await reg.reconcile({ organizationId: ORG, vaultName: "V" });

    expect(lastWrittenConfig().organizationId).toBe(ORG);
  });
});
