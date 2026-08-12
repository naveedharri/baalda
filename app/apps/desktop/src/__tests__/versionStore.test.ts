// The versioning view-state: the nine actions the UI is built against, and the
// invariant that every one of the five new fields is vault-scoped (a version list
// or checkpoint list from the vault we left would offer a revert that writes the
// wrong content into the wrong note).

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listNoteVersions: vi.fn(async (_docId: string) => [] as unknown[]),
  getNoteVersion: vi.fn(async (_docId: string, _id: number) => ({ content: "" }) as unknown),
  revertNoteToVersion: vi.fn(async (_docId: string, _id: number) => ({
    ok: true,
    preRevertVersionId: 9,
  })),
  listCheckpoints: vi.fn(async (_vaultId: string) => [] as unknown[]),
  createCheckpoint: vi.fn(async (_vaultId: string, _label?: string) => ({}) as unknown),
  deleteCheckpoint: vi.fn(async (_vaultId: string, _id: string) => {}),
  revertToCheckpoint: vi.fn(async (_vaultId: string, _id: string) => ({
    ok: true,
    docsChanged: 2,
    docsRestored: 1,
    docsDeleted: 0,
    foldersCreated: 1,
    preRevertCheckpointId: "cp-0",
  })),
}));

vi.mock("../lib/auth/authManager", () => ({
  authManager: { api, getServerUrl: () => "http://localhost:3010" },
  api,
}));

const sync = vi.hoisted(() => ({
  registry: { vaultId: null as string | null, getMapping: () => null },
  disable: vi.fn(),
  setViewing: vi.fn(),
  handleRegistryChanged: vi.fn(),
  setStatusListener: vi.fn(),
  setActivityListeners: vi.fn(),
  setRegistryListener: vi.fn(),
  setInboundListeners: vi.fn(),
  setMemberJoinedListener: vi.fn(),
  setVaultPresenceListener: vi.fn(),
  setVoiceListener: vi.fn(),
  setSyncProgressListener: vi.fn(),
  setDocStateListener: vi.fn(),
  setRegistryMapListener: vi.fn(),
  setNoteMetaListener: vi.fn(),
}));

vi.mock("../lib/sync/docSession", () => ({ syncManager: sync }));

import { useStore } from "../store";

const VERSION = {
  id: 7,
  createdAt: "2026-08-11T10:00:00.000Z",
  cause: "idle" as const,
  authorId: "u1",
  authorName: "Ada",
  sha256: "abc",
  size: 12,
};

const CHECKPOINT = {
  id: "cp-1",
  kind: "manual" as const,
  label: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  createdBy: "u1",
  createdByName: "Ada",
  noteCount: 2,
};

/** Pretend a synced vault is open (what every server-backed action needs). */
function synced(): void {
  sync.registry.vaultId = "vault-1";
  useStore.setState({ syncEnabled: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listNoteVersions.mockResolvedValue([]);
  api.listCheckpoints.mockResolvedValue([]);
  sync.registry.vaultId = null;
  useStore.setState({
    syncEnabled: false,
    noteLastEdited: {},
    versionPanelDocId: null,
    noteVersions: null,
    versionPreview: null,
    checkpoints: null,
  });
});

describe("version panel actions", () => {
  it("opens a panel, loads the note's versions, and closes cleanly", async () => {
    synced();
    api.listNoteVersions.mockResolvedValue([VERSION]);

    await useStore.getState().openVersionPanel("doc-a");

    expect(api.listNoteVersions).toHaveBeenCalledWith("doc-a");
    expect(useStore.getState().versionPanelDocId).toBe("doc-a");
    expect(useStore.getState().noteVersions).toEqual([VERSION]);

    useStore.getState().closeVersionPanel();
    expect(useStore.getState()).toMatchObject({
      versionPanelDocId: null,
      noteVersions: null,
      versionPreview: null,
    });
  });

  it("clears the previous note's list before the new one loads", async () => {
    synced();
    useStore.setState({ versionPanelDocId: "doc-a", noteVersions: [VERSION] });
    let duringLoad: unknown = "unset";
    api.listNoteVersions.mockImplementation(async () => {
      duringLoad = useStore.getState().noteVersions;
      return [];
    });

    await useStore.getState().openVersionPanel("doc-b");

    // A stale list of the same shape reads as this note's history.
    expect(duringLoad).toBeNull();
  });

  it("drops a late response for a note whose panel has since been replaced", async () => {
    synced();
    api.listNoteVersions.mockImplementation(async (docId: string) => {
      if (docId === "doc-a") useStore.setState({ versionPanelDocId: "doc-b" });
      return [VERSION];
    });

    await useStore.getState().openVersionPanel("doc-a");

    expect(useStore.getState().versionPanelDocId).toBe("doc-b");
    expect(useStore.getState().noteVersions).toBeNull();
  });

  it("does not call the server for a local vault (versions are server-side)", async () => {
    await useStore.getState().openVersionPanel("doc-a");
    expect(api.listNoteVersions).not.toHaveBeenCalled();
    expect(useStore.getState().noteVersions).toEqual([]);
  });

  it("shows an empty list rather than an endless spinner when the list fails", async () => {
    synced();
    api.listNoteVersions.mockRejectedValue(new Error("offline"));
    await useStore.getState().openVersionPanel("doc-a");
    expect(useStore.getState().noteVersions).toEqual([]);
  });
});

describe("version preview", () => {
  it("loads a version's markdown for the read-only overlay", async () => {
    synced();
    useStore.setState({ versionPanelDocId: "doc-a" });
    api.getNoteVersion.mockResolvedValue({ ...VERSION, content: "# old" });

    await useStore.getState().previewVersion(7);

    expect(api.getNoteVersion).toHaveBeenCalledWith("doc-a", 7);
    expect(useStore.getState().versionPreview).toEqual({ versionId: 7, content: "# old" });

    useStore.getState().clearVersionPreview();
    expect(useStore.getState().versionPreview).toBeNull();
  });

  it("does nothing when no panel is open", async () => {
    await useStore.getState().previewVersion(7);
    expect(api.getNoteVersion).not.toHaveBeenCalled();
  });

  it("leaves no preview behind when the fetch fails", async () => {
    synced();
    useStore.setState({ versionPanelDocId: "doc-a" });
    api.getNoteVersion.mockRejectedValue(new Error("403"));
    await useStore.getState().previewVersion(7);
    expect(useStore.getState().versionPreview).toBeNull();
  });
});

describe("revertToVersion", () => {
  it("exits the preview, reverts the panel's note, and refreshes the list", async () => {
    synced();
    useStore.setState({
      versionPanelDocId: "doc-a",
      versionPreview: { versionId: 7, content: "# old" },
      noteVersions: [VERSION],
    });
    const previewAtRevert: unknown[] = [];
    api.revertNoteToVersion.mockImplementation(async () => {
      previewAtRevert.push(useStore.getState().versionPreview);
      return { ok: true as const, preRevertVersionId: 9 };
    });
    api.listNoteVersions.mockResolvedValue([{ ...VERSION, id: 9, cause: "pre-revert" }, VERSION]);

    await useStore.getState().revertToVersion(7);

    // The overlay must be gone before the write lands — the editor the user is
    // looking at has to be the live one that is about to change.
    expect(previewAtRevert).toEqual([null]);
    expect(api.revertNoteToVersion).toHaveBeenCalledWith("doc-a", 7);
    expect(useStore.getState().noteVersions).toHaveLength(2);
  });

  it("propagates the failure (a locked share 403s) instead of silently no-oping", async () => {
    synced();
    useStore.setState({ versionPanelDocId: "doc-a" });
    api.revertNoteToVersion.mockRejectedValue(new Error("Read-only"));
    await expect(useStore.getState().revertToVersion(7)).rejects.toThrow("Read-only");
  });

  it("throws when no note is open", async () => {
    synced();
    await expect(useStore.getState().revertToVersion(7)).rejects.toThrow(/no note/i);
  });
});

describe("checkpoints", () => {
  it("stays null (the sync gate) for a vault that isn't synced", async () => {
    useStore.setState({ checkpoints: [CHECKPOINT] });
    await useStore.getState().refreshCheckpoints();
    expect(useStore.getState().checkpoints).toBeNull();
    expect(api.listCheckpoints).not.toHaveBeenCalled();
  });

  it("lists the collection's checkpoints", async () => {
    synced();
    api.listCheckpoints.mockResolvedValue([CHECKPOINT]);
    await useStore.getState().refreshCheckpoints();
    expect(api.listCheckpoints).toHaveBeenCalledWith("vault-1");
    expect(useStore.getState().checkpoints).toEqual([CHECKPOINT]);
  });

  it("drops a response for a collection that is no longer the open one", async () => {
    synced();
    api.listCheckpoints.mockImplementation(async () => {
      sync.registry.vaultId = "vault-2";
      return [CHECKPOINT];
    });
    await useStore.getState().refreshCheckpoints();
    expect(useStore.getState().checkpoints).toBeNull();
  });

  it("creates a checkpoint, trimming the label, then refreshes", async () => {
    synced();
    await useStore.getState().createCheckpoint("  Before the rewrite  ");
    expect(api.createCheckpoint).toHaveBeenCalledWith("vault-1", "Before the rewrite");
    expect(api.listCheckpoints).toHaveBeenCalled();
  });

  it("treats a blank label as no label", async () => {
    synced();
    await useStore.getState().createCheckpoint("   ");
    expect(api.createCheckpoint).toHaveBeenCalledWith("vault-1", undefined);
  });

  it("deletes a checkpoint, then refreshes", async () => {
    synced();
    await useStore.getState().deleteCheckpoint("cp-1");
    expect(api.deleteCheckpoint).toHaveBeenCalledWith("vault-1", "cp-1");
    expect(api.listCheckpoints).toHaveBeenCalled();
  });

  it("refuses the write actions without a synced vault", async () => {
    await expect(useStore.getState().createCheckpoint()).rejects.toThrow(/sync/i);
    await expect(useStore.getState().deleteCheckpoint("cp-1")).rejects.toThrow(/sync/i);
    await expect(useStore.getState().revertVaultToCheckpoint("cp-1")).rejects.toThrow(/sync/i);
    expect(api.createCheckpoint).not.toHaveBeenCalled();
  });

  it("reverts the vault, returns the tally, and pulls the new structure locally", async () => {
    synced();
    const result = await useStore.getState().revertVaultToCheckpoint("cp-1");

    expect(api.revertToCheckpoint).toHaveBeenCalledWith("vault-1", "cp-1");
    expect(result).toMatchObject({ docsChanged: 2, preRevertCheckpointId: "cp-0" });
    // The pre-revert checkpoint the server just took has to show up in the list…
    expect(api.listCheckpoints).toHaveBeenCalled();
    // …and the restored/tombstoned notes have to converge on this device without
    // waiting for the server's own registry broadcast to come back to us.
    expect(sync.handleRegistryChanged).toHaveBeenCalled();
  });
});

describe("vault scoping", () => {
  it("closing the vault clears every versioning field", () => {
    synced();
    useStore.setState({
      noteLastEdited: { "doc-a": { userId: "u1", name: "Ada", at: "2026-08-11T10:00:00.000Z" } },
      versionPanelDocId: "doc-a",
      noteVersions: [VERSION],
      versionPreview: { versionId: 7, content: "# old" },
      checkpoints: [CHECKPOINT],
    });

    useStore.getState().closeLocalVault();

    expect(useStore.getState()).toMatchObject({
      noteLastEdited: {},
      versionPanelDocId: null,
      noteVersions: null,
      versionPreview: null,
      checkpoints: null,
      syncEnabled: false,
    });
  });

  it("hands out a fresh noteLastEdited object per reset (no shared mutable map)", () => {
    useStore.getState().closeLocalVault();
    const first = useStore.getState().noteLastEdited;
    first["leaked"] = { userId: "u1", name: "Ada", at: "2026-08-11T10:00:00.000Z" };
    useStore.getState().closeLocalVault();
    expect(useStore.getState().noteLastEdited).toEqual({});
  });
});
