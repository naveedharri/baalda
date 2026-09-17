import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { VaultChannel } from "../src/sync/vault-channel.js";
import { InMemoryPubSub } from "../src/sync/pubsub.js";
import { mintVaultToken } from "../src/tokens/vault-token.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import {
  seedBlob,
  seedFile,
  seedFolder,
  seedItemPrivate,
  seedMember,
  seedNote,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * A tree binary (a `files` row) set to **Private** has to leave the disk of
 * everyone who can no longer read it, exactly as a note does.
 *
 * It did not. Three separate things had to hold and only one of them did:
 *   - the client had to be able to ANNOUNCE that it holds the file, so the
 *     channel could name it on `ready.revoked` — binaries have no CRDT and so no
 *     state-vector manifest entry, hence `hello.files`;
 *   - `POST /vaults/:id/access-check` had to ANSWER for a `files` id, or the
 *     desktop's second opinion came back unanswered and it kept the file;
 *   - the blob listing had to stop offering the bytes, or the file came straight
 *     back down on the next mirror pass.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

afterAll(async () => {
  await pool.end();
});

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ text?: unknown }> = [];
  send(data: unknown, opts?: { binary?: boolean }): void {
    if (!opts?.binary) this.sent.push({ text: JSON.parse(data as string) });
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  hello(token: string, files: string[]): void {
    // An EMPTY manifest with a populated `files`: exactly the shape a device
    // holding binaries and no notes sends, and the one that used to name nothing.
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ t: "hello", token, manifest: {}, files })),
      false,
    );
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

async function readyFor(userId: string, vaultId: string, files: string[]) {
  const channel = new VaultChannel({ pubsub: new InMemoryPubSub() });
  const ws = new FakeWs();
  channel.handleConnection(ws as never);
  ws.hello(await mintVaultToken({ userId, vaultId }), files);
  await waitFor(() => ws.controls().some((c) => c.t === "ready"));
  return ws.controls().find((c) => c.t === "ready")!;
}

function post(user: TestUser, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

function get(user: TestUser, path: string) {
  return app.fetch(new Request(`http://local${path}`, { headers: authHeaders(user) }));
}

describe("a file set to Private", () => {
  let owner: TestUser;
  let member: TestUser;
  let orgId: string;
  let vault: string;
  let folder: string;
  let pdf: string;
  let keptPdf: string;
  let note: string;

  beforeEach(async () => {
    await resetDb();
    rec.reset();
    owner = await signUp("owner@file-revoke.test");
    orgId = (await createOrg(owner, "File Revoke Co", "file-revoke-co")).id;
    member = await signUp("member@file-revoke.test");
    await seedMember(orgId, member.userId, "member");

    vault = await seedVault(orgId, "V");
    folder = await seedFolder(vault, null, "Team", "Team");
    note = await seedNote(vault, folder, "Team/Notes.md", owner.userId);
    pdf = await seedFile(vault, folder, "Team/guide.pdf");
    keptPdf = await seedFile(vault, folder, "Team/keep.pdf");
    await seedVaultGrant(orgId, "edit");
  });

  it("is named on ready.revoked from hello.files alone", async () => {
    await seedItemPrivate(orgId, "file", pdf);

    const ready = await readyFor(member.userId, vault, [pdf, keptPdf]);
    // Only the private one. The list is the client's own claim minus its
    // readable set, and `listReadableDocsInVault` unions `files` — which is the
    // whole reason a `.pdf` leaves that set at all.
    expect(ready.revoked).toEqual([pdf]);
  });

  it("is named for the OWNER too — an item's Private is not a setting they sit above", async () => {
    await seedItemPrivate(orgId, "file", pdf);
    const ready = await readyFor(owner.userId, vault, [pdf, keptPdf]);
    expect(ready.revoked).toEqual([pdf]);
  });

  it("names nothing while the file is shared", async () => {
    const ready = await readyFor(member.userId, vault, [pdf, keptPdf]);
    expect(ready.revoked).toBeUndefined();
  });

  it("is ANSWERED by the access check, not left out of it", async () => {
    // The desktop's rule for an unanswered id is to keep the file — and to keep
    // the whole group with it. While this route queried `notes` only, every
    // revoked binary came back unanswered and nothing was ever removed.
    await seedItemPrivate(orgId, "file", pdf);

    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: [pdf, keptPdf, note],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).none).toEqual([pdf]);
  });

  it("leaves an id from no vault of ours unanswered", async () => {
    // Unchanged by the `files` UNION: "not here" must never read as "confirmed
    // unreadable" on the one route whose whole job is to be a second opinion.
    const res = await post(member, `/api/vaults/${vault}/access-check`, {
      docIds: ["not-a-doc-in-this-vault"],
    });
    expect((await res.json()).none).toEqual([]);
  });

  it("stops being offered by the blob listing, so it cannot be downloaded back", async () => {
    await seedBlob(vault, orgId, "Team/guide.pdf", { docId: pdf });
    await seedBlob(vault, orgId, "Team/keep.pdf", { docId: keptPdf });

    const before = await (await get(member, `/api/vaults/${vault}/blobs`)).json();
    expect(before.blobs.map((b: { relPath: string }) => b.relPath).sort()).toEqual([
      "Team/guide.pdf",
      "Team/keep.pdf",
    ]);

    await seedItemPrivate(orgId, "file", pdf);

    const after = await (await get(member, `/api/vaults/${vault}/blobs`)).json();
    expect(after.blobs.map((b: { relPath: string }) => b.relPath)).toEqual(["Team/keep.pdf"]);
    // …and the listing carries the `files` id, which is how a downloaded binary
    // gets a doc id on the receiving device at all — and so how a LATER
    // revocation of it can be announced.
    expect(after.blobs[0].docId).toBe(keptPdf);
  });
});
