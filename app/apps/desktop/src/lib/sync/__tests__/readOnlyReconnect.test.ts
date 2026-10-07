import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// A view-only note must stay view-only through a reconnect.
//
// Every re-mint of the open note's token (the TTL refresher ~9 min, a `reauth`
// for ANY access change in the vault, a network blip) drops its provider to
// "connecting" until the new token lands. The app-wide status used to fall back
// to the vault channel's "synced" for that window, and the editor reads
// "synced" as an edit grant: the view-only banner vanished, the note flickered
// and keystrokes were accepted for up to ~2 s, then rolled forward as a local
// fork the server had already refused.

/** The provider config DocSync hands to Hocuspocus, captured per instance. */
type Handlers = {
  token: () => Promise<string>;
  onAuthenticated?: () => void;
  onAuthenticationFailed?: (p: { reason?: string }) => void;
  onStatus?: (p: { status: string }) => void;
  onSynced?: () => void;
  onClose?: (p: { event: { code: number } }) => void;
  onUnsyncedChanges?: (p: { number: number }) => void;
};

const captured = vi.hoisted(() => ({
  handlers: null as Handlers | null,
  /** The fake provider itself, so a test can flip `isSynced`. */
  instance: null as { isSynced: boolean } | null,
  /** `websocketProvider.connect()` calls — one per reconnect attempt. */
  connects: 0,
  /** `websocketProvider.disconnect()` calls — how a terminal state stops the
   *  provider's own retry loop instead of merely painting a colour. */
  disconnects: 0,
}));

vi.mock("@hocuspocus/provider", () => {
  class FakeHocuspocusProvider {
    readonly awareness = { setLocalStateField() {}, destroy() {}, on() {}, off() {} };
    isSynced = false;
    readonly configuration: { websocketProvider: unknown };
    constructor(config: Handlers) {
      captured.handlers = config;
      captured.instance = this;
      this.configuration = {
        websocketProvider: {
          status: "disconnected",
          connect: () => {
            captured.connects++;
          },
          disconnect: () => {
            captured.disconnects++;
          },
          on() {},
          off() {},
          webSocket: undefined,
        },
      };
    }
    on() {}
    off() {}
    disconnect() {}
    destroy() {}
  }
  return {
    HocuspocusProvider: FakeHocuspocusProvider,
    WebSocketStatus: { Disconnected: "disconnected", Connecting: "connecting", Connected: "connected" },
  };
});

import { ApiClient } from "../../api";
import { DocSync } from "../syncManager";
import { SyncManager } from "../docSession";
import { markReadOnlyDoc, resetReadOnlyDocs } from "../../bridge/readOnlyDocs";

function api(readOnly: boolean): ApiClient {
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ token: "tok", readOnly }),
  })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://localhost:3010", token: "sess", fetchImpl: impl });
}

beforeEach(() => {
  captured.handlers = null;
  captured.instance = null;
  captured.connects = 0;
  captured.disconnects = 0;
  resetReadOnlyDocs();
});

describe("DocSync keeps a view-only grant across a reconnect", () => {
  it("stays readOnly while the re-mint is in flight", async () => {
    const sync = new DocSync({ api: api(true), doc: new Y.Doc(), docId: "d1", vaultId: "v1" });
    await captured.handlers!.token();
    captured.handlers!.onSynced?.();
    expect(sync.status).toBe("read-only");
    // The reconnect lap: socket back up, new token not yet minted.
    captured.handlers!.onStatus?.({ status: "connecting" });
    expect(sync.status).toBe("connecting");
    expect(sync.readOnly).toBe(true);
  });

  it("starts read-only when this session already knows the doc is view-only", async () => {
    markReadOnlyDoc("d1", true);
    const sync = new DocSync({ api: api(false), doc: new Y.Doc(), docId: "d1", vaultId: "v1" });
    expect(sync.readOnly).toBe(true);
    // An editable token clears it: a grant that changed since is picked up.
    await captured.handlers!.token();
    expect(sync.readOnly).toBe(false);
  });
});

describe("SyncManager.effectiveStatus for a view-only open note", () => {
  type Fake = {
    vaultStatus: string;
    docStatus: string | null;
    current: { readOnly: boolean; status: string } | null;
  };
  const effective = (f: Fake): string => {
    const self = Object.assign(Object.create(SyncManager.prototype), f);
    return (self as unknown as { effectiveStatus(): string }).effectiveStatus();
  };

  it("reports read-only, never the channel's synced, while the doc reconnects", () => {
    for (const docStatus of ["connecting", "offline", "error", "synced"]) {
      expect(
        effective({ vaultStatus: "synced", docStatus, current: { readOnly: true, status: docStatus } }),
      ).toBe("read-only");
    }
  });

  it("still reports synced for an editable note reconnecting on a healthy channel", () => {
    expect(
      effective({ vaultStatus: "synced", docStatus: "connecting", current: { readOnly: false, status: "connecting" } }),
    ).toBe("synced");
  });

  it("openDocReadOnly follows the open note's grant", () => {
    const self = Object.assign(Object.create(SyncManager.prototype), { current: { readOnly: true } });
    expect((self as SyncManager).openDocReadOnly).toBe(true);
    const none = Object.assign(Object.create(SyncManager.prototype), { current: null });
    expect((none as SyncManager).openDocReadOnly).toBe(false);
  });
});
