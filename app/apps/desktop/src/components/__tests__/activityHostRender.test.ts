// @vitest-environment jsdom
// The Activity host is mounted inside <App>; a render loop there takes the
// whole window down ("Maximum update depth exceeded"). These render it under a
// parent that subscribes exactly like App (the unread count) and like the feed
// (the whole snapshot), and assert the render count settles.
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  vaultId: null as string | null,
  api: {
    listTrash: vi.fn(),
    listShrinkEvents: vi.fn(),
  },
}));

vi.mock("../../lib/auth/authManager", () => ({ authManager: { api: h.api } }));
vi.mock("../../lib/sync/docSession", () => ({
  syncManager: {
    registry: {
      get vaultId() {
        return h.vaultId;
      },
    },
    syncFailures: () => ({
      registry: [],
      content: [{ docId: "d1", relPath: "x.md", reason: "network" }],
      limitCode: null,
    }),
  },
}));
vi.mock("../../lib/ipc", () => ({ listTrashCopies: vi.fn(async () => []) }));
vi.mock("../../store", async () => {
  const { create } = await import("zustand");
  const useStore = create<Record<string, unknown>>(() => ({}));
  return { useStore };
});

import { useStore } from "../../store";
import { ActivityHost, useActivitySnapshot, useActivityUnread } from "../activitySource";

const setStore = (useStore as unknown as { setState: (s: Record<string, unknown>, replace?: boolean) => void })
  .setState;

let root: Root;
let host: HTMLDivElement;
let renders = 0;
/** A loop blocks the event loop, so a test would hang rather than fail:
 *  throw from render past a hard ceiling to turn it into a failure. */
const RUNAWAY = 500;
let runaway = false;
function bump() {
  renders++;
  if (renders > RUNAWAY) {
    runaway = true;
    throw new Error("runaway render loop");
  }
}

function AppLike() {
  const unread = useActivityUnread();
  const n = useRef(0);
  n.current++;
  bump();
  return createElement("div", { "data-unread": unread }, createElement(ActivityHost), createElement(FeedLike));
}

/** Worst case: the host's PARENT re-renders on every publish (what App did
 *  before it subscribed to the count only). The snapshot must still settle. */
function WholeSnapshotParent() {
  const snap = useActivitySnapshot();
  bump();
  return createElement("div", { "data-n": snap.rows.length }, createElement(ActivityHost));
}

function FeedLike() {
  const snap = useActivitySnapshot();
  bump();
  return createElement("span", { "data-rows": snap.rows.length });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  renders = 0;
  runaway = false;
  h.vaultId = null;
  h.api.listTrash.mockResolvedValue({ items: [], truncated: false });
  h.api.listShrinkEvents.mockResolvedValue({ items: [], truncated: false, afterIsCurrent: true });
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

it("settles for a local vault with sync off (the crash case)", async () => {
  // An OLDER persisted store shape too: no accessEvents, no structureNotice.
  setStore({ syncEnabled: false, session: null, vaultSyncStatus: "idle", vault: { path: "/v", epoch: 1 }, rightPanel: null }, true);
  await act(async () => root.render(createElement(AppLike)));
  await settle();
  expect(runaway).toBe(false);
  expect(renders).toBeLessThan(30);
});

it("settles for a synced vault with rows, and stays still on unrelated store churn", async () => {
  h.vaultId = "vault-1";
  h.api.listTrash.mockResolvedValue({
    items: [
      {
        docId: "t1",
        relPath: "gone.md",
        deletedAt: new Date().toISOString(),
        deletedBy: null,
        purgeAfter: new Date(Date.now() + 86_400_000).toISOString(),
        sizeBytes: 1,
        hasUnsyncedContributions: false,
      },
    ],
    truncated: false,
  });
  setStore(
    {
      syncEnabled: true,
      session: { token: "x" },
      vaultSyncStatus: "synced",
      vault: { path: "/v2", epoch: 1 },
      rightPanel: null,
      structureNotice: { rootMissing: false, pendingDelete: { count: 12 }, closedAppChanges: false },
      accessEvents: [{ kind: "granted", at: Date.now(), vaultId: "vault-1", count: 2, paths: ["a.md", "b.md"] }],
      docSyncState: {},
      syncProgress: null,
    },
    true,
  );
  await act(async () => root.render(createElement(AppLike)));
  await settle();
  expect(runaway).toBe(false);
  const afterLoad = renders;
  expect(afterLoad).toBeLessThan(60);
  expect(Number(host.querySelector("span")?.getAttribute("data-rows"))).toBeGreaterThan(0);

  // Unrelated store writes must not snowball.
  for (let i = 0; i < 10; i++) await act(async () => setStore({ unrelated: i }));
  await settle();
  expect(renders - afterLoad).toBeLessThan(10);
});

it("settles even when the host's parent re-renders on every publish", async () => {
  setStore({ syncEnabled: false, session: null, vaultSyncStatus: "idle", vault: { path: "/v3", epoch: 1 }, rightPanel: null }, true);
  await act(async () => root.render(createElement(WholeSnapshotParent)));
  await settle();
  expect(runaway).toBe(false);
  expect(renders).toBeLessThan(30);
});
