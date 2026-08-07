import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { decodeWsUpdate } from "../src/sync/vault-protocol.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { appendUpdate } from "../src/yjs/persistence.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault } from "./helpers/seed.js";

// End-to-end against a REAL Postgres + real deps (ACL resolver, loadDocDiff,
// token verify) through a fake socket: proves the channel backfills a doc's
// actual server state, fans out live updates, and honours per-doc ACL
// (spec 05 §3.1). Requires db:up + migrate; resets the DB per test.

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ text?: unknown; bytes?: Uint8Array }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (opts?.binary) this.sent.push({ bytes: data as Uint8Array });
    else this.sent.push({ text: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string): void {
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest: {} })), false);
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
}

const tick = () => new Promise((r) => setTimeout(r, 15));
async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await tick();
  }
}

/** Apply a doc's frames onto a fresh Y.Doc and read the "content" text. */
function textFrom(frames: Array<{ update: Uint8Array }>): string {
  const doc = new Y.Doc();
  for (const f of frames) Y.applyUpdate(doc, f.update);
  const t = doc.getText("content").toString();
  doc.destroy();
  return t;
}

describe("VaultChannel end-to-end (spec 05 §3.1)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("backfills a doc's real server state to an authorized subscriber", async () => {
    const org = await seedOrg("Acme", "acme-e2e1");
    const owner = await seedUser("owner@e2e.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");

    // Persist real Yjs state for the doc.
    const src = new Y.Doc();
    src.getText("content").insert(0, "hello backfill");
    await appendUpdate(docId, Y.encodeStateAsUpdate(src));
    src.destroy();

    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: owner, vaultId: vault }));

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    const frames = ws.frames().filter((f) => f.docId === docId);
    expect(frames.length).toBeGreaterThan(0);
    expect(textFrom(frames)).toBe("hello backfill");
  });

  it("fans out a live update after backfill", async () => {
    const org = await seedOrg("Acme", "acme-e2e2");
    const owner = await seedUser("owner2@e2e.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "n.md");

    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: owner, vaultId: vault }));
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    const src = new Y.Doc();
    src.getText("content").insert(0, "live!");
    await channel.publishDocUpdate(vault, docId, Y.encodeStateAsUpdate(src));
    src.destroy();

    await waitFor(() => ws.frames().some((f) => f.docId === docId));
    expect(textFrom(ws.frames().filter((f) => f.docId === docId))).toBe("live!");
  });

  it("stops streaming to a member who has just been removed", async () => {
    // The leak this closes, proved end to end rather than by asserting a callback
    // fired. `disconnectDoc` only kills per-doc Hocuspocus sockets — the
    // vault-channel socket below survives it, holding a `readable` set frozen at
    // connect time. Before `acl-changed` was wired into member removal, this
    // connection kept receiving every doc update in the vault until its token
    // expired (SYNC_TOKEN_TTL_SECONDS, 600s by default).
    const org = await seedOrg("Acme", "acme-e2e-revoke");
    const owner = await seedUser("owner@revoke.com");
    const member = await seedUser("member@revoke.com");
    await seedMember(org, owner, "owner");
    const memberRow = await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "team.md", owner);
    // Shared with the team, so the member can read it while they're a member.
    await pool.query(
      `INSERT INTO shares
         (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ($1, $2, 'vault', $2, 'org', $2, 'edit')`,
      [randomUUID(), org],
    );

    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: member, vaultId: vault }));
    await waitFor(() => ws.controls().some((c) => c.t === "ready"));

    // While still a member, live updates arrive.
    const before = new Y.Doc();
    before.getText("content").insert(0, "while a member");
    await channel.publishDocUpdate(vault, docId, Y.encodeStateAsUpdate(before));
    before.destroy();
    await waitFor(() => ws.frames().some((f) => f.docId === docId));

    // Now they're removed — the row goes, and the vault channel is told.
    await pool.query(`DELETE FROM member WHERE id = $1`, [memberRow]);
    await channel.publishAclChanged(vault);
    // The channel answers by re-resolving and dropping every doc it can no longer
    // read; the token is still perfectly valid, which is the whole point.
    await waitFor(() => ws.controls().some((c) => c.t === "drop" && c.docId === docId));

    const framesBefore = ws.frames().length;
    const after = new Y.Doc();
    after.getText("content").insert(0, "AFTER REMOVAL — must not arrive");
    await channel.publishDocUpdate(vault, docId, Y.encodeStateAsUpdate(after));
    after.destroy();
    await tick();
    await tick();

    expect(ws.frames().length).toBe(framesBefore);
    expect(textFrom(ws.frames().filter((f) => f.docId === docId))).not.toContain("AFTER REMOVAL");
  });

  it("sends no backfill for a doc the subscriber can't read", async () => {
    const org = await seedOrg("Acme", "acme-e2e3");
    const member = await seedUser("m@e2e.com");
    await seedMember(org, member, "member"); // no share on any note
    const vault = await seedVault(org);
    const docId = await seedNote(vault, null, "secret.md");
    const src = new Y.Doc();
    src.getText("content").insert(0, "secret");
    await appendUpdate(docId, Y.encodeStateAsUpdate(src));
    src.destroy();

    const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
    const ws = new FakeWs();
    channel.handleConnection(ws as never);
    ws.hello(await mintVaultToken({ userId: member, vaultId: vault }));

    await waitFor(() => ws.controls().some((c) => c.t === "ready"));
    expect(ws.frames()).toHaveLength(0);
  });
});
