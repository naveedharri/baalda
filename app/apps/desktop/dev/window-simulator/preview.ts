// SPDX-License-Identifier: Apache-2.0
import {
  initialStore,
  previewFetch,
  notes,
  files,
  folders,
  unknownRequests,
  VAULT,
} from "./fixture-api";
import { fixtureIpc } from "./fixture-ipc";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
const params = new URLSearchParams(location.search);
Object.defineProperty(navigator, "userAgent", {
  configurable: true,
  value:
    params.get("platform") === "macos"
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
});
localStorage.setItem("cbk-theme", params.get("theme") || "light");
localStorage.setItem("context.sidebarWidth", "328");
localStorage.setItem(
  "context.sidebarHidden",
  params.get("sidebarHidden") || "false",
);
const vault = {
  path:
    params.get("platform") === "macos"
      ? "/Users/kamil/Baalda/Product team"
      : "C:\\Users\\Kamil\\Baalda\\Product team",
  name: "Product team",
  epoch: 1,
};
localStorage.setItem(
  "context.orgVaults",
  JSON.stringify({ "preview-org": vault.path }),
);
const note =
  "Three bets this quarter: a simpler Share dialog, a calmer sidebar, and faster sync. Each one has an owner and a date. See [Pricing experiments](Specs/Pricing%20experiments.md) for the numbers behind the second.\n\n## Getting started\n\n- [How Baalda works](https://baalda.com)\n- [Keyboard shortcuts](https://baalda.com)\n- [Collaborating with your team](https://baalda.com)\n";
const item = (path: string, isDir = false, children?: any[]) => ({
  id: path,
  path,
  name: path.split("/").pop(),
  isDir,
  ...(isDir ? { children: children ?? [], childrenLoaded: true } : {}),
});
const kids = [
  ...folders.map((f) =>
    item(f.path, true, [
      ...notes.filter((n) => n.folderId === f.id).map((n) => item(n.relPath)),
      ...files.filter((n) => n.folderId === f.id).map((n) => item(n.path)),
    ]),
  ),
  ...notes.filter((n) => !n.folderId).map((n) => item(n.relPath)),
];
const tree = {
  id: "",
  path: "",
  name: "Product team",
  isDir: true,
  children: kids,
  childrenLoaded: true,
};
const titles = notes.map((n) => ({
  id: n.id,
  path: n.relPath,
  title: n.title,
}));
const noteBytes = new Map(
  notes.map((n) => [
    n.relPath,
    n.relPath === "Q3 plan.md"
      ? note
      : `Sample content for ${n.title}.\n\nThis note is part of the local interface simulator.\n`,
  ]),
);
let maximized = false;
mockWindows("main");
mockIPC(
  (cmd, args: any) => {
    const fixture = fixtureIpc(cmd, args);
    if (fixture.handled) return fixture.value;
    switch (cmd) {
      case "get_last_vault":
      case "open_vault":
        return vault;
      case "get_recent_vaults":
        return [{ ...vault, openedAt: Date.now() }];
      case "get_vaults_root":
        return params.get("platform") === "macos"
          ? "/Users/kamil/Baalda"
          : "C:\\Users\\Kamil\\Baalda";
      case "get_server_url":
        return "http://preview.invalid";
      case "list_tree":
        return tree;
      case "list_children":
        return args.path
          ? (kids.find((x) => x.path === args.path)?.children ?? [])
          : kids;
      case "list_note_titles":
        return titles;
      case "get_note_meta":
        return {
          id: notes.find((n) => n.relPath === args.path)?.id ?? args.path,
          path: args.path,
          title: args.path.replace(/\.md$/, ""),
          mtime: Date.now(),
          sha256: "",
          frontmatter: null,
          tags: [],
        };
      case "read_note":
        return noteBytes.get(args.path) ?? "";
      case "load_yjs_state":
        return new ArrayBuffer(9);
      case "append_yjs_update":
        return 1;
      case "write_note":
        noteBytes.set(args.path, args.content);
        return "written";
      case "get_backlinks":
        return [];
      case "graph_edges":
      case "graph_edges_for":
        return [
          { source: "preview-note", target: "preview-note-3" },
          { source: "preview-note-2", target: "preview-note" },
        ];
      case "vault_root_state":
        return { exists: true, isDir: true };
      case "note_exists":
      case "folder_exists":
        return true;
      case "plugin:app|version":
        return "0.1.79";
      case "plugin:window|is_maximized":
        return maximized;
      case "plugin:window|toggle_maximize":
        maximized = !maximized;
        return null;
      case "plugin:window|is_focused":
        return true;
      case "plugin:window|inner_size":
        return { width: 1600, height: 1000 };
      case "list_yjs_state_vectors":
        return new ArrayBuffer(4);
      case "keychain_get":
      case "peek_vault_stamp":
      case "get_disk_base":
      case "get_note_ui_state":
      case "plugin:deep-link|get_current":
        return null;
      case "list_tags":
      case "list_trash_copies":
      case "get_vault_types":
      case "list_property_keys":
      case "list_binaries":
      case "list_attachments":
      case "list_file_rows":
      case "list_disk_drift":
      case "list_vaults_root_dirs":
        return [];
      default:
        console.debug("[preview IPC]", cmd);
        return null;
    }
  },
  { shouldMockEvents: true },
);
// Every backend request is handled locally; live WebSocket connections are refused.
window.fetch = previewFetch;
const NativeWebSocket = window.WebSocket;
window.WebSocket = new Proxy(NativeWebSocket, {
  construct(Target, args) {
    const url = new URL(String(args[0]), location.href);
    // Vite's same-host HMR socket is local infrastructure, not app synchronization.
    if (
      url.host === location.host &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    )
      return Reflect.construct(Target, args);
    console.info("[simulator] backend WebSocket blocked", url.href);
    const socket = new EventTarget();
    return Object.assign(socket, {
      url: url.href,
      readyState: 3,
      bufferedAmount: 0,
      extensions: "",
      protocol: "",
      binaryType: "blob",
      onclose: null,
      onerror: null,
      onopen: null,
      onmessage: null,
      close() {},
      send() {
        throw new Error("Live connections are disabled in the simulator.");
      },
    });
  },
});
const { authManager } = await import("/src/lib/auth/authManager.ts");
await authManager.setServerUrl("http://preview.invalid");
// ApiClient checks for a token before reading its mocked session response.
// This deliberately invalid marker never leaves the in-memory fetch fixture.
authManager.api.setToken("DEMO_ONLY_NOT_A_VALID_SESSION_TOKEN");
const { syncManager } = await import("/src/lib/sync/docSession.ts");
Object.defineProperty(syncManager.registry, "vaultId", {
  configurable: true,
  get: () => VAULT,
});
const { useStore } = await import("/src/store.ts");
useStore.setState({
  ...initialStore,
  initAuth: async () => {},
  openNoteByPath: async (path: string) => {
    const n = notes.find((n) => n.relPath === path);
    if (!n) return;
    useStore.setState({
      openNote: { path, id: n.id, title: n.title },
      openTabs: [...new Set([...useStore.getState().openTabs, path])],
      activeVirtualTab: null,
    });
  },
  refreshVault: async () => {
    useStore.setState({ ...initialStore });
  },
  vault,
  tree,
  openNote: { path: "Q3 plan.md", id: "preview-note", title: "Q3 plan" },
  openTabs: ["Q3 plan.md"],
  authStatus: "signed-in",

  syncEnabled: true,

  syncStatus: "synced",
  vaultSyncStatus: "synced",
  vaultReadySeen: true,
  lastSyncedAt: Date.now(),
  openFolderIsSynced: null,
  editorMeasure: "full",
});
(window as any).previewStore = useStore;
(window as any).previewUnknownRequests = unknownRequests;
await import("/src/main.tsx");
