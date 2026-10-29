// W3 transport: the vault key rides `hello.vk` and the per-doc token, and a
// `key_required` refusal is NEVER read as lost access or an empty server.

import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api";
import { isKeyRequired, withVaultKey } from "../sync/syncManager";
import {
  VaultSyncEngine,
  WS_CLOSE_KEY_REQUIRED,
  type DocUpdateSink,
  type WebSocketLike,
} from "../sync/vaultSyncEngine";
import { decideSeed } from "../sync/startup";

function tokenApi(): ApiClient {
  const impl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ token: "vault-tok", vaultId: "v1" }),
  })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "http://localhost:3010", token: "sess", fetchImpl: impl });
}

class FakeWs implements WebSocketLike {
  binaryType = "";
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  hello(): Record<string, unknown> | null {
    const s = this.sent.find((x) => typeof x === "string") as string | undefined;
    return s ? JSON.parse(s) : null;
  }
}

class EmptySink implements DocUpdateSink {
  applied = 0;
  dropped: string[] = [];
  knownDocs() {
    return [];
  }
  async stateVector() {
    return null;
  }
  recentDocs() {
    return [];
  }
  async applyUpdate() {
    this.applied++;
  }
  drop(docId: string) {
    this.dropped.push(docId);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function awaitHello(ws: FakeWs) {
  for (let i = 0; i < 40 && ws.hello() === null; i++) await tick();
}

function engine(api: ApiClient, sink = new EmptySink()) {
  const created: FakeWs[] = [];
  const scheduled: Array<() => void> = [];
  const statuses: string[] = [];
  const empties: string[][] = [];
  const e = new VaultSyncEngine({
    api,
    vaultId: "v1",
    sink,
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w;
    },
    onStatus: (s) => statuses.push(s),
    onServerEmpty: (ids: string[]) => empties.push(ids),
    random: () => 0,
    setTimeoutImpl: (fn) => {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutImpl: () => {},
  } as ConstructorParameters<typeof VaultSyncEngine>[0]);
  return { e, created, scheduled, statuses, empties, sink };
}

describe("vault key on the wire", () => {
  it("hello carries vk only for a vault whose key is verified", async () => {
    const api = tokenApi();
    api.setVaultKeyResolver((id) => (id === "v1" ? "S0VZ" : null));
    const { e, created } = engine(api);
    e.start();
    created[0].onopen?.(null);
    await awaitHello(created[0]);
    expect(created[0].hello()!.vk).toBe("S0VZ");
    e.stop();

    const plain = tokenApi();
    const t = engine(plain);
    t.e.start();
    t.created[0].onopen?.(null);
    await awaitHello(t.created[0]);
    expect("vk" in t.created[0].hello()!).toBe(false);
    t.e.stop();
  });

  it("the per-doc token gains a `.vk` suffix only when a key is held", () => {
    expect(withVaultKey("a.b.c", "S0VZ")).toBe("a.b.c.S0VZ");
    expect(withVaultKey("a.b.c", null)).toBe("a.b.c");
    expect(withVaultKey("", "S0VZ")).toBe("");
    expect(isKeyRequired("key_required")).toBe(true);
    expect(isKeyRequired("permission-denied")).toBe(false);
    expect(isKeyRequired(undefined)).toBe(false);
  });

  it("close 4409 asks for the key and reconnects: never no-access, never empty", async () => {
    const api = tokenApi();
    let asked = 0;
    api.setKeyRequiredHandler(async () => {
      asked++;
      return true;
    });
    const { e, created, scheduled, statuses, empties, sink } = engine(api);
    e.start();
    created[0].onopen?.(null);
    await awaitHello(created[0]);
    created[0].onclose?.({ code: WS_CLOSE_KEY_REQUIRED, reason: "key_required" });
    await tick();
    expect(asked).toBe(1);
    expect(statuses).not.toContain("no-access");
    expect(scheduled).toHaveLength(1); // the ordinary reconnect
    expect(empties).toEqual([]);
    expect(sink.dropped).toEqual([]);
    scheduled[0]();
    await tick();
    expect(created).toHaveLength(2);
    e.stop();
  });

  it("4409 never reconnects before the key is ready, and backs off (no spin)", async () => {
    const api = tokenApi();
    let asked = 0;
    const answers: Array<(ok: boolean) => void> = [];
    api.setKeyRequiredHandler(() => {
      asked++;
      return new Promise<boolean>((r) => answers.push(r));
    });
    const { e, created, scheduled } = engine(api);
    e.start();
    created[0].onopen?.(null);
    await awaitHello(created[0]);
    created[0].onclose?.({ code: WS_CLOSE_KEY_REQUIRED, reason: "key_required" });
    expect(scheduled).toHaveLength(1);
    // The reconnect timer fires while the key is still being fetched: no socket.
    scheduled[0]();
    await tick();
    expect(created).toHaveLength(1);
    // Key not ready: ask again on a backed-off lap, still no socket.
    answers[0](false);
    await tick();
    expect(created).toHaveLength(1);
    expect(scheduled).toHaveLength(2);
    expect(asked).toBe(2);
    scheduled[1]();
    await tick();
    expect(created).toHaveLength(1);
    // Key ready: exactly one connect.
    answers[1](true);
    await tick();
    expect(created).toHaveLength(2);
    expect(scheduled).toHaveLength(2);
    e.stop();
  });

  it("an err frame `key_required` is the same: key, reconnect, nothing dropped", async () => {
    const api = tokenApi();
    let asked = 0;
    api.setKeyRequiredHandler(async () => {
      asked++;
      return true;
    });
    const { e, created, scheduled, statuses, empties, sink } = engine(api);
    e.start();
    created[0].onopen?.(null);
    await awaitHello(created[0]);
    created[0].onmessage?.({ data: JSON.stringify({ t: "err", message: "key_required" }) });
    await tick();
    expect(asked).toBe(1);
    expect(statuses).not.toContain("no-access");
    expect(scheduled.length).toBeGreaterThan(0);
    expect(empties).toEqual([]);
    expect(sink.dropped).toEqual([]);
    // Never a completed server sync, so nothing seeds over local content.
    expect(decideSeed({ signedIn: true, serverSynced: false, docEmpty: true, fileHasContent: true }).action).toBe(
      "wait-for-server",
    );
    e.stop();
  });
});

describe("startup ordering: the channel opens early only on a known key state", () => {
  it("unknown or keyed-without-key waits for the gate; unkeyed or key held opens", async () => {
    const { earlyVaultChannelAllowed } = await import("./runtime");
    expect(earlyVaultChannelAllowed(null, false)).toBe(false);
    expect(earlyVaultChannelAllowed({ state: "waiting-for-teammate" }, false)).toBe(false);
    expect(earlyVaultChannelAllowed({ state: "ready", generation: 1 }, false)).toBe(false);
    expect(earlyVaultChannelAllowed({ state: "unkeyed" }, false)).toBe(true);
    expect(earlyVaultChannelAllowed({ state: "disabled" }, false)).toBe(true);
    expect(earlyVaultChannelAllowed(null, true)).toBe(true);
  });

  it("vaultKeysEarlyChannel: no `vault-keys` opens; unknown or a vault-keys server waits", async () => {
    const { vaultKeysEarlyChannel } = await import("./runtime");
    const { api } = await import("../auth/authManager");
    const health = vi.spyOn(api, "getHealth");
    const base = vi.spyOn(api, "getBaseUrl");
    try {
      base.mockReturnValue("http://no-keys.test");
      health.mockResolvedValue({ ok: true, version: "x", features: ["notes-with-state"] });
      expect(await vaultKeysEarlyChannel("v-a")).toBe(true);
      base.mockReturnValue("http://unknown.test");
      health.mockResolvedValue(null);
      expect(await vaultKeysEarlyChannel("v-a")).toBe(false);
      health.mockRejectedValue(new Error("offline"));
      expect(await vaultKeysEarlyChannel("v-a")).toBe(false);
      base.mockReturnValue("http://keys.test");
      health.mockResolvedValue({ ok: true, version: "x", features: ["vault-keys"] });
      expect(await vaultKeysEarlyChannel("v-a")).toBe(false);
    } finally {
      health.mockRestore();
      base.mockRestore();
    }
  });
});
