// End-to-end client↔server integration (spec 03/04). Env-gated: it needs the
// real server running (`pnpm --filter server dev`, with Docker Postgres up + migrated)
// on :3010 (HTTP) / :3011 (Hocuspocus). Enable with CONTEXT_IT=1.
//
//   CONTEXT_IT=1 pnpm --filter desktop test -- integration
//
// It exercises the actual client modules: ApiClient (auth token capture, org,
// vault, note registration, sync-token minting) and DocSync (HocuspocusProvider
// wiring, readOnly gating, convergence). Registry reconciliation is Tauri-bound
// (ipc), so this drives the server registry through ApiClient directly.

import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { ApiClient } from "../../api";
import { DocSync } from "../syncManager";

const RUN = process.env.CONTEXT_IT === "1";
const SERVER = process.env.CONTEXT_SERVER ?? "http://localhost:3010";

function waitFor(cond: () => boolean, timeoutMs = 8000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const created: DocSync[] = [];
afterAll(() => {
  for (const s of created) s.destroy();
});

describe.skipIf(!RUN)("client↔server integration", () => {
  it("signup → org → vault → note → two providers converge; view-only rejected", async () => {
    const stamp = Date.now();
    const wsPoly = WebSocket as unknown;

    // ---- User A (owner) ----
    const a = new ApiClient({ baseUrl: SERVER });
    await a.signUp({ email: `a-${stamp}@it.test`, password: "password123", name: "Owner A" });
    const org = await a.createOrganization({ name: `IT ${stamp}`, slug: `it-${stamp}` });
    await a.setActiveOrganization(org.id);
    const vault = await a.createVault({ name: `Vault ${stamp}`, organizationId: org.id });
    const note = await a.createNote({ vaultId: vault.id, relPath: "shared/doc.md", title: "Doc" });
    const docId = note.docId ?? note.id;

    // ---- User B (member, view-only) ----
    const b = new ApiClient({ baseUrl: SERVER });
    const { user: bUser } = await b.signUp({
      email: `b-${stamp}@it.test`,
      password: "password123",
      name: "Member B",
    });
    // A invites B; B accepts. (Invitee-side `list-user-invitations` requires a
    // verified email — deferred in MVP — so we take the id from the admin's
    // pending list, mirroring the signed accept-link the invitee gets by email.)
    await a.inviteMember({ email: `b-${stamp}@it.test`, role: "member", organizationId: org.id });
    const pending = await a.listInvitations(org.id);
    const invite = pending.find((i) => i.email === `b-${stamp}@it.test`) ?? pending[0];
    expect(invite).toBeTruthy();
    await b.acceptInvitation(invite.id);
    // Private-by-default: a new vault grants members nothing, so B starts with
    // NO access. A shares this file with B read-only the way the Access panel
    // does — a user-scope `view` grant (not a lock, which alone grants nothing).
    await a.createShare({
      resourceType: "file",
      resourceId: docId,
      principalId: bUser.id,
      principalType: "user",
      permission: "view",
    });

    // ---- sync-token gating ----
    const aTok = await a.syncToken(docId);
    expect(aTok.readOnly).toBe(false);
    const bTok = await b.syncToken(docId);
    expect(bTok.readOnly).toBe(true);

    // ---- two providers on the same doc converge ----
    const docA = new Y.Doc();
    const syncA = new DocSync({
      api: a,
      doc: docA,
      docId,
      vaultId: vault.id,
      webSocketPolyfill: wsPoly,
    });
    created.push(syncA);
    await syncA.whenSynced();

    const textA = docA.getText("content");
    textA.insert(0, "Hello from A");

    const docB = new Y.Doc();
    const syncB = new DocSync({
      api: b,
      doc: docB,
      docId,
      vaultId: vault.id,
      webSocketPolyfill: wsPoly,
    });
    created.push(syncB);
    await syncB.whenSynced();
    const textB = docB.getText("content");

    await waitFor(() => textB.toString() === "Hello from A", 8000, "B sees A");
    expect(textB.toString()).toBe("Hello from A");
    expect(syncB.readOnly).toBe(true);

    // ---- live view: the read-only client keeps receiving A's edits ----
    textA.insert(textA.length, " world");
    await waitFor(() => textB.toString() === "Hello from A world", 8000, "B sees A#2");

    // ---- view-only client's edits are rejected by the server ----
    // (In the real app the editor is non-editable for a viewer; here we force a
    // write to prove the server drops it and A never sees it.)
    const before = textA.toString();
    textB.insert(0, "HACK ");
    await new Promise((r) => setTimeout(r, 1000));
    expect(textA.toString()).toBe(before); // A never sees B's rejected write
  }, 40_000);

  it("DocSync reports pending on a local edit and flushes to synced", async () => {
    const stamp = Date.now();
    const wsPoly = WebSocket as unknown;

    const a = new ApiClient({ baseUrl: SERVER });
    await a.signUp({ email: `flush-${stamp}@it.test`, password: "password123", name: "Flush A" });
    const org = await a.createOrganization({ name: `FL ${stamp}`, slug: `fl-${stamp}` });
    await a.setActiveOrganization(org.id);
    const vault = await a.createVault({ name: `FlVault ${stamp}`, organizationId: org.id });
    const note = await a.createNote({ vaultId: vault.id, relPath: "n/flush.md", title: "F" });
    const docId = note.docId ?? note.id;

    let pending = false;
    let flushes = 0;
    const doc = new Y.Doc();
    const sync = new DocSync({
      api: a,
      doc,
      docId,
      vaultId: vault.id,
      webSocketPolyfill: wsPoly,
      onPending: (p) => {
        pending = p;
      },
      onFlushed: () => {
        flushes += 1;
      },
    });
    created.push(sync);
    await sync.whenSynced();

    const flushesBefore = flushes;
    doc.getText("content").insert(0, "hello");
    // The edit must immediately mark pending, then flush back to not-pending
    // once the server acks — this is the "Saving… → Synced · just now" signal.
    await waitFor(() => pending === true, 4000, "edit marks pending");
    await waitFor(() => pending === false, 8000, "edit flushes");
    expect(flushes).toBeGreaterThan(flushesBefore);
    expect(sync.pending).toBe(false);
  }, 40_000);

  it("attachment blob: A uploads → invited member B lists + downloads byte-identical", async () => {
    const stamp = Date.now();

    // ---- User A (owner) creates org + vault ----
    const a = new ApiClient({ baseUrl: SERVER });
    await a.signUp({ email: `att-a-${stamp}@it.test`, password: "password123", name: "Owner A" });
    const org = await a.createOrganization({ name: `ATT ${stamp}`, slug: `att-${stamp}` });
    await a.setActiveOrganization(org.id);
    const vault = await a.createVault({ name: `AttVault ${stamp}`, organizationId: org.id });

    // ---- User B joins the vault (member) ----
    const b = new ApiClient({ baseUrl: SERVER });
    await b.signUp({ email: `att-b-${stamp}@it.test`, password: "password123", name: "Member B" });
    await a.inviteMember({ email: `att-b-${stamp}@it.test`, role: "member", organizationId: org.id });
    const pending = await a.listInvitations(org.id);
    const invite = pending.find((i) => i.email === `att-b-${stamp}@it.test`) ?? pending[0];
    expect(invite).toBeTruthy();
    await b.acceptInvitation(invite.id);

    // ---- A uploads a binary attachment (non-UTF8 bytes to prove fidelity) ----
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x42]);
    const up = await a.uploadBlob({
      vaultId: vault.id,
      relPath: "attachments/pic.png",
      bytes,
      mime: "image/png",
      fileName: "pic.png",
    });
    expect(up.size).toBe(bytes.byteLength);
    expect(up.deduped).toBe(false);

    // Dedupe: same bytes again → the same row, no second copy.
    const dup = await a.uploadBlob({
      vaultId: vault.id,
      relPath: "attachments/pic-copy.png",
      bytes,
      mime: "image/png",
    });
    expect(dup.deduped).toBe(true);
    expect(dup.id).toBe(up.id);

    // ---- B lists + downloads; bytes are identical ----
    const list = await b.listVaultBlobs(vault.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(up.id);
    const got = await b.downloadBlob(up.id);
    expect(Array.from(got)).toEqual(Array.from(bytes));
  }, 40_000);
});
