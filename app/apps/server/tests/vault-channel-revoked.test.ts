import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createApp } from "../src/http/app.js";
import { REVOKED_CAP, VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedFolder, seedMember, seedNote, seedShare, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * `ready.revoked` — the server STATING which docs a client holds that it may no
 * longer read.
 *
 * Everywhere else on this path a revocation is INFERRED by the client, from a
 * registry listing that came back short. The desktop cannot safely act on that
 * alone (a server fault looks identical), so it removes files wholesale only
 * when an access change was announced — and the live announcement
 * (`acl-changed` -> `reauth`) reaches only a client that was connected when the
 * owner changed the rules. Set a vault to Private while a member's app is shut
 * and their next launch had nothing behind it. This frame rides every `ready`.
 *
 * Bound: the list is the client's OWN manifest minus its readable set, so a
 * private-by-default vault full of docs the member never had names none of them.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

/** A state vector the server will happily base64-decode (empty Y.Doc). */
const EMPTY_SV = (() => {
  const doc = new Y.Doc();
  const sv = Buffer.from(Y.encodeStateVector(doc)).toString("base64");
  doc.destroy();
  return sv;
})();

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
  hello(token: string, docIds: string[]): void {
    const manifest: Record<string, string> = {};
    for (const d of docIds) manifest[d] = EMPTY_SV;
    this.emit("message", Buffer.from(JSON.stringify({ t: "hello", token, manifest })), false);
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.text).map((s) => s.text as Record<string, unknown>);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 15));
async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await tick();
  }
}

/** Connect one client with the given manifest and return its `ready` frame. */
async function readyFor(
  userId: string,
  vaultId: string,
  manifest: string[],
): Promise<Record<string, unknown>> {
  const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(await mintVaultToken({ userId, vaultId }), manifest);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws.controls().find((c) => c.t === "ready")!;
}

function put(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "PUT",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

describe("vault channel — ready.revoked", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let rootNote: string;
  let folder: string;
  let folderNote: string;
  let ownNote: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@ready-revoked.test");
    orgId = (await createOrg(owner, "Ready Revoked Co", "ready-revoked-co")).id;
    member = await signUp("member@ready-revoked.test");
    await seedMember(orgId, member.userId, "member");

    vault = await seedVault(orgId, "V");
    rootNote = await seedNote(vault, null, "Root.md", owner.userId);
    folder = await seedFolder(vault, null, "Docs", "Docs");
    folderNote = await seedNote(vault, folder, "Docs/D.md", owner.userId);
    // The member's OWN note: authorship keeps it readable, by design.
    ownNote = await seedNote(vault, null, "Mine.md", member.userId);

    // Start from a shared vault — the state a team is normally in.
    await seedVaultGrant(orgId, "edit");
  });

  it("names nothing while the vault is shared", async () => {
    const ready = await readyFor(member.userId, vault, [rootNote, folderNote, ownNote]);
    // Omitted, not empty: the common frame stays byte-identical to what every
    // shipped client already parses.
    expect(ready.revoked).toBeUndefined();
    expect(ready.revokedTruncated).toBeUndefined();
  });

  it("names exactly the docs the member holds but may no longer read", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );

    const ready = await readyFor(member.userId, vault, [rootNote, folderNote, ownNote]);
    expect(new Set(ready.revoked as string[])).toEqual(new Set([rootNote, folderNote]));
    // The member's own note is authored by them, so it never leaves their
    // readable set and must never be named.
    expect(ready.revoked as string[]).not.toContain(ownNote);
    expect(ready.revokedTruncated).toBeUndefined();
  });

  it("is bounded by the manifest — a doc the client does not hold is never named", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );

    // The client holds only ONE of the two revoked notes. The other is just as
    // unreadable, and just as absent from the frame: the list describes this
    // client's copies, not the vault.
    const ready = await readyFor(member.userId, vault, [rootNote]);
    expect(ready.revoked).toEqual([rootNote]);
  });

  it("names nothing for an owner, who reads everything", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );

    const ready = await readyFor(owner.userId, vault, [rootNote, folderNote, ownNote]);
    expect(ready.revoked).toBeUndefined();
  });

  it("caps the list and flags it, rather than framing an unbounded one", async () => {
    // The list is already bounded by the client's manifest, but a manifest is
    // whatever the client sent — so one frame still gets a ceiling. The residue
    // is named on a later connect; the client keeps what it was given as its
    // allow-list rather than treating truncation as licence to remove
    // everything, which would leave the largest revocations the least guarded.
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );
    // Ids the client CLAIMS to hold. They need no rows: unreadable is unreadable,
    // and this is the client's own manifest being differenced against its
    // readable set.
    const held = Array.from({ length: REVOKED_CAP + 25 }, (_, i) => `held-${i}`);

    const ready = await readyFor(member.userId, vault, held);
    expect((ready.revoked as string[]).length).toBe(REVOKED_CAP);
    expect(ready.revokedTruncated).toBe(true);
  });

  it("names nothing a surviving folder share still covers", async () => {
    expect((await put(owner, `/api/orgs/${orgId}/team-access`, { mode: "private" })).status).toBe(
      200,
    );
    // Per-USER rows survive the vault-level control, so the member keeps this
    // folder — and with it every note inside.
    await seedShare(orgId, "folder", folder, member.userId, "view");

    const ready = await readyFor(member.userId, vault, [rootNote, folderNote, ownNote]);
    expect(ready.revoked).toEqual([rootNote]);
  });
});
