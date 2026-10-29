// SPDX-License-Identifier: Apache-2.0
//
// Red team (W3, round 3): an INSIDER over the websockets. A member of a KEYED
// vault who holds the vault key but has No access to folder X must never get a
// restricted doc's content, id or size from the vault channel (hello manifest,
// backfill, live fan-out, presence) or a per-doc socket; losing access or the
// membership mid-connection stops every further frame for that doc.
//
// Real Postgres + real resolver + real Hocuspocus; the vault channel runs on a
// fake socket like `vault-channel-e2e.test.ts`. Three races are driven with
// injected deps: an ACL change during a backfill read, two ACL refreshes that
// resolve out of order, and an ACL change during the hello's own ACL read.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Server } from "@hocuspocus/server";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodeWsUpdate } from "../src/sync/vault-protocol.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { mintSyncToken } from "../src/tokens/sync-token.js";
import { createSyncServer, disconnectDoc, disconnectUserInVault, type SyncContext } from "../src/sync/hocuspocus.js";
import { formatDocName } from "../src/sync/doc-name.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { vaultKeyCache } from "../src/crypto/key-cache.js";
import type { DocCrypto } from "../src/crypto/doc-crypto.js";
import type { DocDiff } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedDeny, seedFolder, seedMember, seedNote, seedOrg, seedUser, seedVault, seedVaultGrant } from "./helpers/seed.js";

const PORT = 3979;
const WS_URL = `ws://127.0.0.1:${PORT}`;
let server: Server<SyncContext>;

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ text?: unknown; raw?: string; bytes?: Uint8Array }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ bytes: data as Uint8Array });
    else this.sent.push({ text: JSON.parse(data as string), raw: data as string });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string, extra: Record<string, unknown> = {}): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {}, ...extra })), false);
  }
  frame(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.text).map((s) => s.text as Record<string, unknown>);
  }
  frames(): Array<{ docId: string; update: Uint8Array }> {
    return this.sent
      .filter((s) => s.bytes)
      .map((s) => decodeWsUpdate(s.bytes!)!)
      .filter(Boolean);
  }
  /** Every byte this socket was sent, as one string (ids, text, sizes). */
  everything(): string {
    return this.sent
      .map((s) => (s.bytes ? Buffer.from(s.bytes).toString("latin1") : (s.raw ?? "")))
      .join("\n");
  }
}

const tick = () => new Promise((r) => setTimeout(r, 15));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await tick();
  }
}

function edit(doc: Y.Doc, text: string): Uint8Array {
  let u: Uint8Array | null = null;
  const h = (x: Uint8Array) => (u = x);
  doc.on("update", h);
  doc.getText("content").insert(doc.getText("content").length, text);
  doc.off("update", h);
  return u!;
}

let SECRET = "";

/** Keyed vault, Everyone can edit, `member` denied on folder X. A at root, S in X. */
async function insiderVault({ deny = true } = {}) {
  const org = await seedOrg("Insider", `ins-${Date.now()}-${Math.random()}`);
  const owner = await seedUser(`owner-${Math.random().toString(36).slice(2)}@ins.test`);
  const member = await seedUser(`member-${Math.random().toString(36).slice(2)}@ins.test`);
  await seedMember(org, owner, "owner");
  const memberRow = await seedMember(org, member, "member");
  const vaultId = await seedVault(org);
  await seedVaultGrant(org, "edit");
  const folderX = await seedFolder(vaultId, null, "X", "X", owner);
  const open = await seedNote(vaultId, null, "open.md", owner);
  const secret = await seedNote(vaultId, folderX, "X/secret.md", owner);
  if (deny) await seedDeny(org, "folder", folderX, member);
  const vk = randomBytes(32);
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = 1 WHERE id = $1", [vaultId, makeVkCheck(vk, vaultId)]);
  await pool.query("INSERT INTO vault_crypto_state (vault_id, phase, generation) VALUES ($1, 'keyed', 1)", [vaultId]);
  const c: DocCrypto = { vaultId, key: Buffer.from(vk), generation: 1 };
  const openDoc = new Y.Doc();
  const secretDoc = new Y.Doc();
  await appendUpdate(open, edit(openDoc, "open text\n"), pool, 1000, { ...c, key: Buffer.from(vk) });
  await appendUpdate(secret, edit(secretDoc, `${SECRET} restricted body\n`), pool, 1000, { ...c, key: Buffer.from(vk) });
  return { org, owner, member, memberRow, vaultId, folderX, open, secret, vk, c, secretDoc };
}

function channel(deps: Partial<ConstructorParameters<typeof VaultChannel>[0]> = {}): VaultChannel {
  return new VaultChannel({ pubsub: new InMemoryPubSub(), registryCoalesceMs: 0, ...deps });
}

async function joinChannel(ch: VaultChannel, userId: string, vaultId: string, vk: Buffer, extra: Record<string, unknown> = {}) {
  const ws = new FakeWs();
  ch.handleConnection(ws as never);
  ws.hello(await mintVaultToken({ userId, vaultId }), { vk: vk.toString("base64"), ...extra });
  await waitFor(() => ws.controls().some((c) => c.t === "ready" || c.t === "err"));
  expect(ws.controls().some((c) => c.t === "err")).toBe(false);
  return ws;
}

function provider(vaultId: string, docId: string, token: string, doc: Y.Doc) {
  const events = { synced: false, closed: 0, authFailed: "" };
  const p = new HocuspocusProvider({
    url: WS_URL,
    name: formatDocName(vaultId, docId),
    token,
    document: doc,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    onSynced: () => (events.synced = true),
    onClose: () => (events.closed += 1),
    onAuthenticationFailed: ({ reason }) => (events.authFailed = reason || "failed"),
  });
  return { p, events };
}

describe("red team: insider over the websockets on a keyed vault", () => {
  beforeAll(async () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    server = createSyncServer(PORT);
    await server.listen();
  });
  beforeEach(async () => {
    await resetDb();
    vaultKeyCache.clear();
    SECRET = `insider${randomBytes(5).toString("hex")}`;
  });
  afterAll(async () => {
    await server.destroy();
    vi.unstubAllEnvs();
    await pool.end();
  });

  it("hello + backfill: the restricted doc's content, id and size never reach the member", async () => {
    const v = await insiderVault();
    const ch = channel();
    const ws = await joinChannel(ch, v.member, v.vaultId, v.vk);
    expect(ws.frames().some((f) => f.docId === v.open)).toBe(true);
    expect(ws.frames().some((f) => f.docId === v.secret)).toBe(false);
    const all = ws.everything();
    expect(all).not.toContain(v.secret);
    expect(all).not.toContain(SECRET);

    // A manifest that CLAIMS the restricted doc (guessed id, any state vector)
    // gets no content: only its own id echoed back as revoked.
    const ws2 = await joinChannel(ch, v.member, v.vaultId, v.vk, {
      manifest: { [v.secret]: "" },
      held: [v.secret],
      priority: [v.secret],
    });
    expect(ws2.frames().some((f) => f.docId === v.secret)).toBe(false);
    expect(ws2.everything()).not.toContain(SECRET);
    const ready = ws2.controls().find((c) => c.t === "ready")!;
    expect(ready.revoked).toContain(v.secret);
    for (const k of ["empty", "behind", "covered", "tombstones"]) {
      expect((ready[k] as string[] | undefined) ?? []).not.toContain(v.secret);
    }
  });

  it("live fan-out and presence for the restricted doc are filtered", async () => {
    const v = await insiderVault();
    const ch = channel();
    const ownerWs = await joinChannel(ch, v.owner, v.vaultId, v.vk);
    const memberWs = await joinChannel(ch, v.member, v.vaultId, v.vk);
    expect(ownerWs.frames().some((f) => f.docId === v.secret)).toBe(true);
    await ch.publishDocUpdate(v.vaultId, v.secret, edit(v.secretDoc, `${SECRET} live\n`));
    ownerWs.frame({ t: "presence", docId: v.secret, name: "Owner", color: "#000", status: "active" });
    await waitFor(() => ownerWs.frames().filter((f) => f.docId === v.secret).length >= 2);
    await tick();
    await tick();
    expect(memberWs.everything()).not.toContain(v.secret);
    expect(memberWs.everything()).not.toContain(SECRET);
  });

  it("access removed mid-connection: drop, then no further frames for the doc", async () => {
    const v = await insiderVault({ deny: false });
    const ch = channel();
    const ws = await joinChannel(ch, v.member, v.vaultId, v.vk);
    expect(ws.frames().some((f) => f.docId === v.secret)).toBe(true);
    await seedDeny(v.org, "folder", v.folderX, v.member);
    await ch.publishAclChanged(v.vaultId);
    await waitFor(() => ws.controls().some((c) => c.t === "drop" && c.docId === v.secret));
    const before = ws.sent.length;
    await ch.publishDocUpdate(v.vaultId, v.secret, edit(v.secretDoc, "AFTER REVOKE\n"));
    await tick();
    await tick();
    const after = ws.sent.slice(before);
    expect(after.some((s) => s.bytes && decodeWsUpdate(s.bytes)?.docId === v.secret)).toBe(false);
  });

  it("an ACL change while a backfill read is in flight: the frame read before it is not sent after the drop", async () => {
    const v = await insiderVault({ deny: false });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const { loadDocDiff, listReadableDocsInVault } = await import("../src/permissions/vault-docs.js").then(async (m) => ({
      listReadableDocsInVault: m.listReadableDocsInVault,
      loadDocDiff: (await import("../src/yjs/persistence.js")).loadDocDiff,
    }));
    const ch = channel({
      backfillConcurrency: 1,
      listReadableDocs: listReadableDocsInVault,
      loadDiff: (async (docId: string, ...rest: unknown[]): Promise<DocDiff> => {
        const out = await (loadDocDiff as (...a: unknown[]) => Promise<DocDiff>)(docId, ...rest);
        if (docId === v.secret) {
          parked = true;
          await gate;
        }
        return out;
      }) as never,
    });
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: v.member, vaultId: v.vaultId }), {
      vk: v.vk.toString("base64"),
      priority: [v.secret],
    });
    await waitFor(() => parked);
    await seedDeny(v.org, "folder", v.folderX, v.member);
    await ch.publishAclChanged(v.vaultId);
    await waitFor(() => ws.controls().some((c) => c.t === "drop" && c.docId === v.secret));
    release();
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(ws.frames().some((f) => f.docId === v.secret)).toBe(false);
    expect(ws.everything()).not.toContain(SECRET);
  });

  it("two ACL refreshes resolving out of order never re-admit a revoked doc", async () => {
    // Fake reads: the first refresh read the OLD set (S readable) but answers last.
    const reads: Array<{ resolve: (s: Set<string>) => void }> = [];
    let calls = 0;
    const ch = channel({
      verifyToken: (async (t: string) => ({ userId: t, vaultId: "v1" })) as never,
      listReadableDocs: (async () => {
        calls++;
        if (calls === 1) return new Set(["A", "S"]);
        return new Promise<Set<string>>((resolve) => reads.push({ resolve }));
      }) as never,
      loadDiff: (async () => ({
        update: new Uint8Array([0, 0]),
        serverStateVector: new Uint8Array(),
        upToDate: false,
        clientAhead: false,
      })) as never,
      listEmpty: (async () => ({ empty: [], truncated: false })) as never,
      listDeletedAmong: (async () => new Set<string>()) as never,
      backfillConcurrency: 1,
    });
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello("u1");
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    await ch.publishAclChanged("v1"); // refresh #1 (stale read)
    await ch.publishAclChanged("v1"); // refresh #2 (fresh read)
    await waitFor(() => reads.length === 2);
    reads[1]!.resolve(new Set(["A"])); // newer answers first: S dropped
    await waitFor(() => ws.controls().some((c) => c.t === "drop" && c.docId === "S"));
    const before = ws.frames().filter((f) => f.docId === "S").length;
    reads[0]!.resolve(new Set(["A", "S"])); // stale answer lands last
    await tick();
    await tick();
    expect(ws.frames().filter((f) => f.docId === "S").length).toBe(before);
    await ch.publishDocUpdate("v1", "S", new Uint8Array([0, 0]));
    await tick();
    expect(ws.frames().filter((f) => f.docId === "S").length).toBe(before);
  });

  it("an ACL change during the hello's own ACL read is not missed", async () => {
    let calls = 0;
    let releaseFirst: (s: Set<string>) => void = () => {};
    const ch = channel({
      verifyToken: (async (t: string) => ({ userId: t, vaultId: "v1" })) as never,
      listReadableDocs: (async () => {
        calls++;
        // The connect read was taken BEFORE the revoke committed...
        if (calls === 1) return new Promise<Set<string>>((r) => (releaseFirst = r));
        return new Set(["A"]);
      }) as never,
      loadDiff: (async () => ({
        update: new Uint8Array([0, 0]),
        serverStateVector: new Uint8Array(),
        upToDate: false,
        clientAhead: false,
      })) as never,
      listEmpty: (async () => ({ empty: [], truncated: false })) as never,
      listDeletedAmong: (async () => new Set<string>()) as never,
    });
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello("u1");
    await waitFor(() => calls === 1);
    // ...and the revoke's announcement lands while that read is in flight.
    await ch.publishAclChanged("v1");
    releaseFirst(new Set(["A", "S"]));
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(ws.frames().some((f) => f.docId === "S")).toBe(false);
    expect(ws.frames().some((f) => f.docId === "A")).toBe(true);
  });

  it("live-only hello: updates heard during the ACL read are delivered for readable docs only", async () => {
    let calls = 0;
    let releaseFirst: (s: Set<string>) => void = () => {};
    const ch = channel({
      verifyToken: (async (t: string) => ({ userId: t, vaultId: "v1" })) as never,
      listReadableDocs: (async () => {
        calls++;
        if (calls === 1) return new Promise<Set<string>>((r) => (releaseFirst = r));
        return new Set(["A"]);
      }) as never,
      listEmpty: (async () => ({ empty: [], truncated: false })) as never,
      listDeletedAmong: (async () => new Set<string>()) as never,
    });
    const ws = new FakeWs();
    ch.handleConnection(ws as never);
    ws.hello("u1", { mode: "live-only" });
    await waitFor(() => calls === 1);
    await ch.publishDocUpdate("v1", "A", new Uint8Array([7, 7]));
    await ch.publishDocUpdate("v1", "S", new Uint8Array([9, 9]));
    releaseFirst(new Set(["A"]));
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(ws.frames().filter((f) => f.docId === "A")).toHaveLength(1);
    expect(ws.frames().some((f) => f.docId === "S")).toBe(false);
  });

  it("per-doc socket: refused for the restricted doc even with the key and a minted token", async () => {
    const v = await insiderVault();
    const jwt = await mintSyncToken({ docId: v.secret, vaultId: v.vaultId, readOnly: false, userId: v.member });
    const doc = new Y.Doc();
    const s = provider(v.vaultId, v.secret, `${jwt}.${v.vk.toString("base64")}`, doc);
    await waitFor(() => s.events.authFailed !== "" || s.events.synced, 8000);
    s.p.destroy();
    expect(s.events.synced).toBe(false);
    expect(doc.getText("content").toString()).not.toContain(SECRET);
  });

  it("per-doc socket: access removed mid-connection closes it and nothing more arrives", async () => {
    const v = await insiderVault({ deny: false });
    const token = (u: string) =>
      mintSyncToken({ docId: v.secret, vaultId: v.vaultId, readOnly: false, userId: u }).then(
        (j) => `${j}.${v.vk.toString("base64")}`,
      );
    const memberDoc = new Y.Doc();
    const m = provider(v.vaultId, v.secret, await token(v.member), memberDoc);
    const ownerDoc = new Y.Doc();
    const o = provider(v.vaultId, v.secret, await token(v.owner), ownerDoc);
    await waitFor(() => m.events.synced && o.events.synced, 8000);
    expect(memberDoc.getText("content").toString()).toContain(SECRET);
    await seedDeny(v.org, "folder", v.folderX, v.member);
    disconnectDoc(server, v.vaultId, v.secret); // what the share route does
    await waitFor(() => m.events.closed > 0, 8000);
    // The owner reconnects (auto) and keeps editing; the member's reconnect is refused.
    await waitFor(() => o.events.synced, 8000);
    await new Promise((r) => setTimeout(r, 300));
    ownerDoc.getText("content").insert(0, "AFTER REVOKE ");
    await new Promise((r) => setTimeout(r, 800));
    expect(memberDoc.getText("content").toString()).not.toContain("AFTER REVOKE");
    m.p.destroy();
    o.p.destroy();
  });

  it("removed member: vault channel and per-doc sockets close and receive nothing more", async () => {
    const v = await insiderVault({ deny: false });
    const ch = channel();
    const ws = await joinChannel(ch, v.member, v.vaultId, v.vk, { caps: ["member-removed"] });
    const jwt = await mintSyncToken({ docId: v.open, vaultId: v.vaultId, readOnly: false, userId: v.member });
    const memberDoc = new Y.Doc();
    const m = provider(v.vaultId, v.open, `${jwt}.${v.vk.toString("base64")}`, memberDoc);
    const ownerJwt = await mintSyncToken({ docId: v.open, vaultId: v.vaultId, readOnly: false, userId: v.owner });
    const ownerDoc = new Y.Doc();
    const o = provider(v.vaultId, v.open, `${ownerJwt}.${v.vk.toString("base64")}`, ownerDoc);
    await waitFor(() => m.events.synced && o.events.synced, 8000);

    await pool.query("DELETE FROM member WHERE id = $1", [v.memberRow]);
    // What the removal publisher does (index.ts setMemberRemovedPublisher).
    expect(disconnectUserInVault(server, v.vaultId, v.member)).toBeGreaterThan(0);
    await ch.publishMemberRemoved(v.vaultId, v.org, v.member, "removed");
    await waitFor(() => ws.readyState === 3 && m.events.closed > 0, 8000);
    const sentBefore = ws.sent.length;
    await ch.publishDocUpdate(v.vaultId, v.open, edit(new Y.Doc(), "AFTER REMOVAL\n"));
    await waitFor(() => o.events.synced, 8000);
    ownerDoc.getText("content").insert(0, "AFTER REMOVAL ");
    await new Promise((r) => setTimeout(r, 800));
    expect(ws.sent.length).toBe(sentBefore);
    expect(memberDoc.getText("content").toString()).not.toContain("AFTER REMOVAL");
    m.p.destroy();
    o.p.destroy();
  });
});
