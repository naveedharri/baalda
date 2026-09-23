import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// The three auth decisions a per-note provider makes, driven through a fake
// HocuspocusProvider: no socket, no server, no DB.
//
// All three come from one live incident (#93). The user deleted the OPEN note's
// file from disk; the delete propagated, so the server soft-deleted the row; and
// from then on the note's provider re-minted a token the server could not issue,
// connected with an empty one, was rejected, and did it again about once a second
// for as long as the note stayed open — filling the server log with
// `[onAuthenticate] rejected … (token length 0)` and strobing the sync badge,
// which follows the open note's provider.

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
import { DocSync, isTerminalSyncStatus, mintFailureStatus } from "../syncManager";
import { TerminalSyncError } from "../contentUpload";

/** An ApiClient whose `POST /api/sync-token` answers with `status`. */
function api(status: number, body: unknown = { token: "tok", readOnly: false }): ApiClient {
  const impl = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://localhost:3010", token: "sess", fetchImpl: impl });
}

function docSync(client: ApiClient): DocSync {
  return new DocSync({ api: client, doc: new Y.Doc(), docId: "d1", vaultId: "v1" });
}

beforeEach(() => {
  captured.handlers = null;
  captured.instance = null;
  captured.connects = 0;
  captured.disconnects = 0;
});

describe("mintFailureStatus", () => {
  it("maps a doc the server no longer has to a TERMINAL status", () => {
    // 404 is the deleted note: `POST /api/sync-token` filters
    // `deleted_at IS NULL`, so a soft-deleted doc can never mint again. Treating
    // it as `error` (the old default) made it retry forever.
    expect(mintFailureStatus(404)).toBe("deleted");
    expect(isTerminalSyncStatus("deleted")).toBe(true);
  });

  it("keeps the refusal terminal and the session/transport faults retryable", () => {
    expect(mintFailureStatus(403)).toBe("no-access");
    expect(isTerminalSyncStatus("no-access")).toBe(true);
    expect(mintFailureStatus(401)).toBe("offline"); // a re-login fixes it, not a reopen
    expect(mintFailureStatus(500)).toBe("error");
    expect(mintFailureStatus(undefined)).toBe("error"); // network, not HTTP
    for (const s of ["offline", "error"] as const) expect(isTerminalSyncStatus(s)).toBe(false);
  });
});

describe("DocSync — a doc the server cannot mint for", () => {
  it("goes terminal on 404 and stops the provider instead of cycling", async () => {
    const sync = docSync(api(404, { error: "Unknown document" }));
    // The provider asks for a token on every (re)connect.
    await captured.handlers!.token();

    expect(sync.status).toBe("deleted");
    expect(isTerminalSyncStatus(sync.status)).toBe(true);
    // Taking the socket down is the load-bearing half: the status alone would not
    // stop HocuspocusProvider's own reconnect schedule.
    expect(captured.disconnects).toBeGreaterThan(0);

    // …and a rejection arriving after that schedules no retry.
    vi.useFakeTimers();
    captured.handlers!.onAuthenticationFailed?.({ reason: "invalid" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(captured.connects).toBe(0);
    vi.useRealTimers();
    sync.destroy();
  });

  // Prod 2026-09-23: the 404 lands AFTER the uploader starts waiting. A waiter
  // that only checked the status at call time sat out its full 10 s and then
  // reported a transient failure — so the doc was re-queued every pass.
  it("rejects a pending whenSynced the moment the doc turns terminal", async () => {
    vi.useFakeTimers();
    const sync = docSync(api(404, { error: "Unknown document" }));
    const settled = vi.fn();
    const waiting = sync.whenSynced(10_000).then(
      () => settled("resolved"),
      (e: unknown) => settled(e),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled(); // still waiting: not terminal yet

    await captured.handlers!.token(); // the mint 404s → "deleted"
    await waiting;
    expect(settled).toHaveBeenCalledTimes(1);
    const err = settled.mock.calls[0][0] as TerminalSyncError;
    expect(err).toBeInstanceOf(TerminalSyncError);
    expect(err.status).toBe("deleted");

    // …and a later call rejects straight away too, without waiting out a timer.
    await expect(sync.whenSynced(10_000)).rejects.toBeInstanceOf(TerminalSyncError);
    vi.useRealTimers();
    sync.destroy();
  });
});

describe("DocSync — an open socket is not an authenticated one", () => {
  it("does not report synced when the transport connects", async () => {
    // Hocuspocus authenticates IN-BAND, after the socket opens. Reporting
    // "synced" here painted a green "Synced · just now" on every lap of a
    // rejection loop.
    const sync = docSync(api(200));
    captured.handlers!.onStatus?.({ status: "connected" });
    expect(sync.status).toBe("connecting");

    // The honest success edges do report it.
    captured.handlers!.onAuthenticated?.();
    captured.handlers!.onSynced?.();
    expect(sync.status).toBe("synced");
    sync.destroy();
  });

  it("keeps the auth backoff growing across laps", async () => {
    // Each lap of the loop is: socket connects, server rejects the token. The
    // socket connect used to reset the failure streak, which pinned the backoff
    // at its first step — a reject/reconnect cycle roughly once a second, forever.
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(1); // no jitter: delay == backoff
    const sync = docSync(api(200));

    const lap = async (expectedDelayMs: number) => {
      const before = captured.connects;
      captured.handlers!.onStatus?.({ status: "connected" }); // transport up
      captured.handlers!.onAuthenticationFailed?.({ reason: "invalid" }); // …then refused
      // Nothing yet just before the deadline…
      await vi.advanceTimersByTimeAsync(expectedDelayMs - 1);
      expect(captured.connects).toBe(before);
      // …and exactly one reconnect at it.
      await vi.advanceTimersByTimeAsync(2);
      expect(captured.connects).toBe(before + 1);
    };

    await lap(500);
    await lap(1_000);
    await lap(2_000);

    random.mockRestore();
    vi.useRealTimers();
    sync.destroy();
  });

  it("forgets the streak once a connection really authenticates", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    const sync = docSync(api(200));

    captured.handlers!.onStatus?.({ status: "connected" });
    captured.handlers!.onAuthenticationFailed?.({ reason: "invalid" });
    await vi.advanceTimersByTimeAsync(600);
    expect(captured.connects).toBe(1);

    // A token that had merely expired: the next connect is accepted, so the next
    // failure after it must start from the quick first step again.
    captured.handlers!.onAuthenticated?.();
    captured.handlers!.onAuthenticationFailed?.({ reason: "invalid" });
    await vi.advanceTimersByTimeAsync(501);
    expect(captured.connects).toBe(2);

    random.mockRestore();
    vi.useRealTimers();
    sync.destroy();
  });
});

describe("DocSync — pending means an edit, not the handshake", () => {
  it("ignores unsynced counts before the initial sync, then takes over real edits", () => {
    const pending: boolean[] = [];
    const sync = new DocSync({
      api: api(200),
      doc: new Y.Doc(),
      docId: "d1",
      vaultId: "v1",
      onPending: (p) => pending.push(p),
    });
    // Opening a note: the provider queues its sync-step and awareness messages
    // and reports them as "unsynced changes" before the socket has answered.
    // That used to paint "Syncing…" on every note open.
    captured.handlers!.onUnsyncedChanges?.({ number: 2 });
    expect(pending).toEqual([]);
    expect(sync.pending).toBe(false);

    // Handshake done, nothing outstanding: still quiet.
    captured.instance!.isSynced = true;
    captured.handlers!.onUnsyncedChanges?.({ number: 0 });
    captured.handlers!.onSynced?.();
    expect(pending).toEqual([]);

    // A real edit after the initial sync is pending until acked.
    captured.handlers!.onUnsyncedChanges?.({ number: 1 });
    expect(pending).toEqual([true]);
    sync.destroy();
  });

  it("stays quiet on the real wire order: synced fires while the handshake unit is still unacked", () => {
    // What the provider actually does on a clean open (@hocuspocus/provider
    // 4.x): `startSync` resets the count to 1 for the sync-step it sends; the
    // server's sync-step-2 flips `synced` while that unit is STILL outstanding,
    // and only the ack of our own step 2 brings it to 0. Reading "count > 0" at
    // `onSynced` therefore said "Syncing…" on every note open, with nothing to
    // send — the third-cause fix moved the flash rather than removing it.
    const pending: boolean[] = [];
    const flushed: number[] = [];
    const sync = new DocSync({
      api: api(200),
      doc: new Y.Doc(),
      docId: "d1",
      vaultId: "v1",
      onPending: (p) => pending.push(p),
      onFlushed: () => flushed.push(1),
      settleDelayMs: 0,
    });
    captured.handlers!.onUnsyncedChanges?.({ number: 1 }); // startSync's reset
    captured.instance!.isSynced = true;
    captured.handlers!.onSynced?.(); // server's step 2, count still 1
    expect(pending).toEqual([]);
    expect(sync.pending).toBe(false);
    captured.handlers!.onUnsyncedChanges?.({ number: 0 }); // SyncStatus ack
    expect(pending).toEqual([]);
    // No pending→settled edge happened, so "Synced · just now" is not re-stamped
    // either: opening a note is not a sync event.
    expect(flushed).toEqual([]);
    sync.destroy();
  });

  it("does not lose an edit typed while the socket was still connecting", () => {
    const pending: boolean[] = [];
    const doc = new Y.Doc();
    const sync = new DocSync({
      api: api(200),
      doc,
      docId: "d1",
      vaultId: "v1",
      onPending: (p) => pending.push(p),
    });
    captured.handlers!.onUnsyncedChanges?.({ number: 1 }); // startSync's reset
    // A keystroke lands before the server has answered: a LOCAL document update
    // (origin: the editor), which the provider also counts.
    doc.getText("content").insert(0, "x", "editor");
    captured.handlers!.onUnsyncedChanges?.({ number: 2 });
    expect(pending).toEqual([]);
    captured.instance!.isSynced = true;
    // The count is still above zero when the initial sync lands AND we saw a
    // local edit during the handshake, so the indicator picks it up.
    captured.handlers!.onSynced?.();
    expect(pending).toEqual([true]);
    sync.destroy();
  });

  it("does not count the updates the provider itself applies as handshake edits", () => {
    const pending: boolean[] = [];
    const doc = new Y.Doc();
    const sync = new DocSync({
      api: api(200),
      doc,
      docId: "d1",
      vaultId: "v1",
      onPending: (p) => pending.push(p),
    });
    captured.handlers!.onUnsyncedChanges?.({ number: 1 });
    // The server's step 2 carries the doc's content; the provider applies it
    // with itself as the transaction origin. That is a download, not an edit.
    doc.transact(() => doc.getText("content").insert(0, "remote"), captured.instance);
    captured.instance!.isSynced = true;
    captured.handlers!.onSynced?.();
    expect(pending).toEqual([]);
    sync.destroy();
  });
});
