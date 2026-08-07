// Live multi-user collaboration suite (invite → join → see content → edit →
// presence → locks). Env-gated like integration.test.ts: needs the real server
// on :3010 (+ Docker Postgres, migrated).
//
//   CONTEXT_IT=1 pnpm --filter desktop test -- multiuser
//
// This drives the REAL client modules end-to-end against a live server:
//  - ApiClient      auth, org invitations, registry, shares, tokens
//  - VaultRegistry  the joining-member reconcile path (ipc mocked to an
//                   in-memory vault) — regression for "invited member sees an
//                   empty vault" (the server vault used to be adopted by
//                   folder-name match only, forking a second empty one)
//  - DocSync        two peers on one doc: convergence, awareness (the presence
//                   circles + activity status), lock → read-only propagation
//  - VaultSyncEngine the always-on background feed: a member receives note
//                   content without opening the note; ACL-change signal fires

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

// ---- ipc mock: an in-memory vault for the member's VaultRegistry ----------
const memberFs = {
  config: null as string | null,
  /** relPath → content written via writeNote (materialized server notes). */
  files: new Map<string, string>(),
};
vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => memberFs.config),
  setVaultConfig: vi.fn(async (raw: string) => {
    memberFs.config = raw;
  }),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [], childrenLoaded: true })),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async (relPath: string, content: string) => {
    memberFs.files.set(relPath, content);
  }),
  // Create-only, like the real command: materialization must never overwrite.
  writeNoteIfMissing: vi.fn(async (relPath: string, content: string) => {
    if (memberFs.files.has(relPath)) return false;
    memberFs.files.set(relPath, content);
    return true;
  }),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import { ApiClient, noteDocId } from "../../api";
import { presenceUser } from "../../presence/color";
import { DocSync } from "../syncManager";
import { VaultRegistry } from "../registry";
import { VaultSyncEngine, type DocUpdateSink } from "../vaultSyncEngine";
import { reconcileWithTree } from "./helpers/reconcile";

const RUN = process.env.CONTEXT_IT === "1";
const SERVER = process.env.CONTEXT_SERVER ?? "http://localhost:3010";
const wsPoly = WebSocket as unknown;

function waitFor(cond: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 30);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Awareness "user" fields visible on a doc — the data behind presence circles. */
function peersOf(sync: DocSync): Array<{ id: string; name: string; color: string; status?: string }> {
  const out: Array<{ id: string; name: string; color: string; status?: string }> = [];
  sync.awareness.getStates().forEach((state) => {
    const u = (state as { user?: { id: string; name: string; color: string; status?: string } })
      .user;
    if (u?.id) out.push(u);
  });
  return out;
}

/** Minimal in-memory sink for the background vault feed. */
function memorySink() {
  const updates = new Map<string, Uint8Array[]>();
  const sink: DocUpdateSink = {
    knownDocs: () => [],
    stateVector: async () => null,
    recentDocs: () => [],
    applyUpdate: async (docId, update) => {
      const list = updates.get(docId) ?? [];
      list.push(update);
      updates.set(docId, list);
    },
    drop: () => {},
  };
  return { sink, updates };
}

// Shared fixture — built once in beforeAll, threaded through ordered tests.
const stamp = Date.now();
const owner = new ApiClient({ baseUrl: SERVER });
const member = new ApiClient({ baseUrl: SERVER });
const outsider = new ApiClient({ baseUrl: SERVER });
let ownerId = "";
let memberId = "";
let orgId = "";
let vaultId = "";
let welcomeDocId = "";
let teamDocId = "";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

describe.skipIf(!RUN)("multi-user collaboration (live server)", () => {
  beforeAll(async () => {
    // Owner signs up, creates the org and its server vault + content registry.
    const a = await owner.signUp({
      email: `mu-owner-${stamp}@it.test`,
      password: "password123",
      name: "Olivia Owner",
    });
    ownerId = a.user.id;
    const org = await owner.createOrganization({ name: `MU ${stamp}`, slug: `mu-${stamp}` });
    orgId = org.id;
    await owner.setActiveOrganization(orgId);
    // NOTE: vault name deliberately ≠ any member folder name (the old bug).
    const vault = await owner.createVault({ name: "Olivia's Notes", organizationId: orgId });
    vaultId = vault.id;
    const folder = await owner.createFolder({
      vaultId,
      name: "Team",
      path: "Team",
      parentId: null,
    });
    const welcome = await owner.createNote({ vaultId, relPath: "Welcome.md", title: "Welcome" });
    welcomeDocId = noteDocId(welcome);
    const teamNote = await owner.createNote({
      vaultId,
      relPath: "Team/plan.md",
      title: "Plan",
      folderId: folder.id,
    });
    teamDocId = noteDocId(teamNote);

    // New vaults are PRIVATE by default (no org-wide grant). These tests
    // exercise team collaboration, so the owner shares the whole vault with
    // the team ("Open" = org-wide edit) — the same action AccessPanel performs
    // via setVaultPosture. Without this, members correctly resolve to "none".
    await owner.createShare({
      resourceType: "vault",
      resourceId: orgId,
      principalType: "org",
      permission: "edit",
    });
  }, 30_000);

  // ── 1. Invite → accept ────────────────────────────────────────────────────
  it("owner invites; member accepts and lands in the vault", async () => {
    await member.signUp({
      email: `mu-member-${stamp}@it.test`,
      password: "password123",
      name: "Riley Member",
    });
    await owner.inviteMember({
      email: `mu-member-${stamp}@it.test`,
      role: "member",
      organizationId: orgId,
    });
    // Invitee-side list-user-invitations needs verified email (deferred in MVP),
    // so the invitation id comes from the admin's list — same as the app does.
    const invites = await owner.listInvitations(orgId);
    const inv = invites.find((i) => i.email === `mu-member-${stamp}@it.test`);
    expect(inv, "invitation visible to admin").toBeTruthy();
    await member.acceptInvitation(inv!.id);
    await member.setActiveOrganization(orgId);

    const session = await member.getSession();
    memberId = session!.user.id;
    expect(session?.activeOrganizationId).toBe(orgId);

    // Both people appear in the member list (the Access panel / avatar data).
    const members = await owner.listMembers(orgId);
    const names = members.map((m) => m.user?.name).sort();
    expect(names).toEqual(["Olivia Owner", "Riley Member"]);
  }, 30_000);

  // ── 2. The regression: joining member must SEE the vault ─────────────────
  it("member reconcile adopts the owner's vault (no fork) and materializes its notes", async () => {
    memberFs.config = null;
    memberFs.files.clear();

    const reg = new VaultRegistry(member);
    // Fresh per-vault folder — name does NOT match the server vault name.
    const { seeded } = await reconcileWithTree(reg, { organizationId: orgId, vaultName: `mu-${stamp}` }, { id: "root", name: `mu-${stamp}`, path: "", isDir: true, children: [] });

    expect(seeded).toBe(false); // never seed a populated vault
    expect(reg.vaultId).toBe(vaultId); // adopted, not forked
    // Server-only notes materialized locally so the sidebar shows them.
    expect([...memberFs.files.keys()].sort()).toEqual(["Team/plan.md", "Welcome.md"]);
    expect(reg.getMapping("Welcome.md")?.docId).toBe(welcomeDocId);
    expect(reg.getMapping("Team/plan.md")?.docId).toBe(teamDocId);
    // The mapping persisted to the vault config (travels with the folder).
    expect(memberFs.config && JSON.parse(memberFs.config).serverVaultId).toBe(vaultId);

    // And crucially: still exactly ONE server vault in the org.
    const vaults = await owner.listVaults();
    expect(vaults.filter((v) => (v.organizationId ?? v.organization_id) === orgId)).toHaveLength(1);

    // The vault was shared with the team (Open) in setup, so a plain member
    // inherits edit access.
    const tok = await member.syncToken(welcomeDocId);
    expect(tok.readOnly).toBe(false);
  }, 30_000);

  // ── 3. Member reconcile with local-only notes pushes them (no fork) ──────
  it("member with pre-existing local notes registers them into the SAME vault", async () => {
    memberFs.config = null;
    memberFs.files.clear();

    const reg = new VaultRegistry(member);
    const tree = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [
        { id: "n1", name: "Scratch.md", path: "Scratch.md", isDir: false },
      ],
    };
    await reconcileWithTree(reg, { organizationId: orgId, vaultName: "laptop" }, tree);
    expect(reg.vaultId).toBe(vaultId);
    const notes = await member.listNotes(vaultId);
    const paths = notes.map((n) => n.relPath ?? n.rel_path).sort();
    expect(paths).toEqual(["Scratch.md", "Team/plan.md", "Welcome.md"]);
  }, 30_000);

  // ── 4. Realtime editing + presence circles + activity status ─────────────
  it("owner and member converge on one doc; each sees the other's presence + status", async () => {
    const ownerDoc = new Y.Doc();
    const memberDoc = new Y.Doc();
    const ownerSync = new DocSync({
      api: owner,
      doc: ownerDoc,
      docId: welcomeDocId,
      vaultId,
      webSocketPolyfill: wsPoly,
    });
    const memberSync = new DocSync({
      api: member,
      doc: memberDoc,
      docId: welcomeDocId,
      vaultId,
      webSocketPolyfill: wsPoly,
    });
    cleanups.push(() => ownerSync.destroy(), () => memberSync.destroy());

    await Promise.all([ownerSync.whenSynced(), memberSync.whenSynced()]);

    // Presence exactly as the app publishes it (docSession.applyPresence).
    ownerSync.awareness.setLocalStateField("user", presenceUser(ownerId, "Olivia Owner", "online"));
    memberSync.awareness.setLocalStateField(
      "user",
      presenceUser(memberId, "Riley Member", "online"),
    );

    // Owner types; member receives.
    ownerDoc.getText("content").insert(0, "# Welcome\n");
    await waitFor(
      () => memberDoc.getText("content").toString().includes("# Welcome"),
      10_000,
      "owner edit reaches member",
    );
    // Member types; owner receives (merge, not clobber).
    memberDoc.getText("content").insert(memberDoc.getText("content").length, "Hi from Riley!\n");
    await waitFor(
      () => ownerDoc.getText("content").toString().includes("Hi from Riley!"),
      10_000,
      "member edit reaches owner",
    );
    expect(ownerDoc.getText("content").toString()).toBe(memberDoc.getText("content").toString());

    // Presence circles: each side sees BOTH users, with stable color + status.
    await waitFor(
      () => peersOf(ownerSync).some((p) => p.id === memberId),
      10_000,
      "member circle visible to owner",
    );
    await waitFor(
      () => peersOf(memberSync).some((p) => p.id === ownerId),
      10_000,
      "owner circle visible to member",
    );
    const riley = peersOf(ownerSync).find((p) => p.id === memberId)!;
    expect(riley.name).toBe("Riley Member");
    expect(riley.status).toBe("online");
    expect(riley.color).toMatch(/^#[0-9a-f]{6}$/i);
    // Deterministic color: the member computes the same color for themselves.
    const rileySelf = peersOf(memberSync).find((p) => p.id === memberId)!;
    expect(rileySelf.color).toBe(riley.color);

    // Activity status change propagates live (online → away).
    memberSync.awareness.setLocalStateField("user", presenceUser(memberId, "Riley Member", "away"));
    await waitFor(
      () => peersOf(ownerSync).find((p) => p.id === memberId)?.status === "away",
      10_000,
      "status change reaches owner",
    );
  }, 45_000);

  // ── 5. Background vault feed: member gets content WITHOUT opening notes ──
  it("vault sync engine backfills doc content to a member device", async () => {
    const { sink, updates } = memorySink();
    let status = "";
    const engine = new VaultSyncEngine({
      api: member,
      vaultId,
      sink,
      onStatus: (s) => {
        status = s;
      },
      wsFactory: (url) => new WebSocket(url) as never,
    });
    engine.start();
    cleanups.push(() => engine.stop());

    await waitFor(() => status === "synced", 15_000, "vault feed synced");
    await waitFor(() => (updates.get(welcomeDocId)?.length ?? 0) > 0, 10_000, "welcome backfilled");

    // The streamed updates reconstruct the real note content.
    const probe = new Y.Doc();
    for (const u of updates.get(welcomeDocId)!) Y.applyUpdate(probe, u);
    expect(probe.getText("content").toString()).toContain("Hi from Riley!");
  }, 45_000);

  // ── 6. Locks: read-only propagates LIVE to the locked member ─────────────
  it("locking a member flips them to read-only mid-session; unlock restores edit", async () => {
    // A second live pair on the Team/plan.md doc.
    const ownerDoc = new Y.Doc();
    const memberDoc = new Y.Doc();
    const ownerSync = new DocSync({
      api: owner,
      doc: ownerDoc,
      docId: teamDocId,
      vaultId,
      webSocketPolyfill: wsPoly,
    });
    const memberSync = new DocSync({
      api: member,
      doc: memberDoc,
      docId: teamDocId,
      vaultId,
      webSocketPolyfill: wsPoly,
    });
    cleanups.push(() => ownerSync.destroy(), () => memberSync.destroy());
    await Promise.all([ownerSync.whenSynced(), memberSync.whenSynced()]);
    expect(memberSync.readOnly).toBe(false);

    // The member ALSO runs the background vault feed — the app uses its
    // ACL-change signal to refresh the open note's access live.
    const { sink } = memorySink();
    let aclChanged = 0;
    const engine = new VaultSyncEngine({
      api: member,
      vaultId,
      sink,
      onAclChanged: () => {
        aclChanged += 1;
        memberSync.refreshAccess(); // what docSession wires up
      },
      wsFactory: (url) => new WebSocket(url) as never,
    });
    engine.start();
    cleanups.push(() => engine.stop());
    await sleep(1000); // let the feed connect before the ACL change

    // Owner locks Riley on this file (per-user read-only).
    const lock = await owner.createShare({
      resourceType: "file",
      resourceId: teamDocId,
      principalType: "user",
      principalId: memberId,
      permission: "locked",
    });

    // Server says: view-only now.
    const tok = await member.syncToken(teamDocId);
    expect(tok.readOnly).toBe(true);

    // The vault channel broadcast the change; the member's editor flipped
    // WITHOUT reopening the note.
    await waitFor(() => aclChanged > 0, 15_000, "ACL change signal received");
    await waitFor(() => memberSync.readOnly, 15_000, "editor flips to read-only");

    // A locked member's edits must NOT reach the owner.
    memberDoc.getText("content").insert(0, "SNEAKY EDIT ");
    await sleep(1500);
    expect(ownerDoc.getText("content").toString()).not.toContain("SNEAKY EDIT");

    // Owner still edits fine, and the member still RECEIVES (view access).
    ownerDoc.getText("content").insert(0, "Q3 plan\n");
    await waitFor(
      () => memberDoc.getText("content").toString().includes("Q3 plan"),
      10_000,
      "locked member still receives owner edits",
    );

    // Unlock → member can edit again.
    await owner.revokeShare(lock.id);
    const tok2 = await member.syncToken(teamDocId);
    expect(tok2.readOnly).toBe(false);
    await waitFor(() => aclChanged > 1, 15_000, "unlock signal received");
    await waitFor(() => !memberSync.readOnly, 15_000, "editor flips back to editable");
  }, 60_000);

  // ── 7. Access-panel data: who can access, and how ─────────────────────────
  it("resolve-access reports each member's effective permission", async () => {
    const res = await owner.resolveAccess("file", welcomeDocId);
    const byId = new Map(res.members.map((m) => [m.userId, m]));
    expect(byId.get(ownerId)?.permission).toBe("edit"); // owner/admin
    expect(byId.get(memberId)?.permission).toBe("edit"); // via the vault-wide team grant
  }, 30_000);

  // ── 8. Outsiders stay out ─────────────────────────────────────────────────
  it("a signed-in non-member gets no registry access and no sync token", async () => {
    await outsider.signUp({
      email: `mu-outsider-${stamp}@it.test`,
      password: "password123",
      name: "Oscar Outsider",
    });
    await expect(outsider.listNotes(vaultId)).rejects.toMatchObject({ status: 403 });
    await expect(outsider.syncToken(welcomeDocId)).rejects.toMatchObject({ status: 403 });
    // And an unauthenticated client can't even list vaults.
    const anon = new ApiClient({ baseUrl: SERVER });
    await expect(anon.listVaults()).rejects.toMatchObject({ status: 401 });
  }, 30_000);

  // ── 9. Edge: member joins an org that has NO server vault yet ────────────
  it("member joining an org with no server vault fails gracefully (cannot create one)", async () => {
    const org2 = await owner.createOrganization({
      name: `MU2 ${stamp}`,
      slug: `mu2-${stamp}`,
    });
    await owner.inviteMember({
      email: `mu-member-${stamp}@it.test`,
      role: "member",
      organizationId: org2.id,
    });
    const inv = (await owner.listInvitations(org2.id)).find((i) => i.status === "pending");
    await member.acceptInvitation(inv!.id);

    memberFs.config = null;
    memberFs.files.clear();
    const reg = new VaultRegistry(member);
    await expect(
      reconcileWithTree(reg, { organizationId: org2.id, vaultName: "riley-folder" }, { id: "root", name: "riley-folder", path: "", isDir: true, children: [] }),
    ).rejects.toMatchObject({ status: 403 });
    // No stray vault appeared.
    const vaults = await owner.listVaults();
    expect(
      vaults.filter((v) => (v.organizationId ?? v.organization_id) === org2.id),
    ).toHaveLength(0);
  }, 30_000);
});
