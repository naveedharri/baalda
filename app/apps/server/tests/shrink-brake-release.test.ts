import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import {
  isShrinkHeld,
  reportShrink,
  setShrinkBrakeHook,
  setShrinkBrakeReleaseHook,
  ShrinkBrake,
  shrinkBrake,
  type BrakeHold,
} from "../src/versions/shrink-guard.js";
import { listBrakeEvents, recordBrakeEngaged } from "../src/versions/brake-events.js";
import { decodePubsub, encodePubsubBrake } from "../src/sync/vault-protocol.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { testAppDeps } from "./helpers/app.js";
import { seedMember, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * The shrink burst brake as people see it (#252 follow-up): the held member is
 * told (a `brake` frame, never `rejected`), owners/admins see the hold in
 * Activity and can release it early, and the release reaches the sync path.
 */

const app = createApp(testAppDeps());
const BODY = "# Notes\n\n" + "A paragraph somebody wrote and wants to keep. ".repeat(12);

function req(user: TestUser, method: string, path: string) {
  return app.fetch(new Request(`http://local${path}`, { method, headers: authHeaders(user) }));
}

afterAll(async () => {
  await pool.end();
});

describe("ShrinkBrake hold details (pure)", () => {
  it("reports when the hold lapses and how many notes engaged it", () => {
    let t = 1_000;
    const b = new ShrinkBrake(3, 60_000, 600_000, () => t);
    for (const d of ["a", "b"]) b.record("u", "v", d);
    expect(b.holdOf("u", "v")).toBeNull();
    expect(b.record("u", "v", "c")).toBe(true);
    expect(b.holdOf("u", "v")).toEqual({ until: 601_000, count: 3 });
    t = 601_000;
    expect(b.holdOf("u", "v")).toBeNull();
  });

  it("release says whether a hold was live and restarts the count", () => {
    const t = 0;
    const b = new ShrinkBrake(2, 60_000, 600_000, () => t);
    b.record("u", "v", "a");
    b.record("u", "v", "b");
    expect(b.release("u", "v")).toBe(true);
    expect(b.isHeld("u", "v")).toBe(false);
    expect(b.release("u", "v")).toBe(false);
    // The burst count restarted: one more note does not re-engage it.
    expect(b.record("u", "v", "c")).toBe(false);
    expect(b.record("u", "v", "d")).toBe(true);
  });

  it("hands the brake hook the hold it engaged", () => {
    shrinkBrake.configure({ threshold: 2, windowMs: 60_000, holdMs: 120_000 });
    const seen: Array<[string, string, BrakeHold]> = [];
    setShrinkBrakeHook((vaultId, userId, hold) => seen.push([vaultId, userId, hold]));
    try {
      reportShrink("v-hook", "a", BODY, "", "u-hook");
      reportShrink("v-hook", "b", BODY, "", "u-hook");
      expect(seen).toHaveLength(1);
      expect(seen[0][0]).toBe("v-hook");
      expect(seen[0][1]).toBe("u-hook");
      expect(seen[0][2].count).toBe(2);
      expect(seen[0][2].until).toBeGreaterThan(Date.now());
    } finally {
      setShrinkBrakeHook(null);
      shrinkBrake.configure({ threshold: 0 });
    }
  });
});

describe("brake pub/sub frame", () => {
  it("round-trips a hold and a lift, and only carries until/count while held", () => {
    expect(decodePubsub(encodePubsubBrake("u1", true, 123, 10))).toEqual({
      type: "brake",
      userId: "u1",
      held: true,
      until: 123,
      count: 10,
    });
    expect(decodePubsub(encodePubsubBrake("u1", false, 123, 10))).toEqual({
      type: "brake",
      userId: "u1",
      held: false,
    });
  });
});

describe("shrink brake routes", () => {
  let owner: TestUser;
  let member: TestUser;
  let other: TestUser;
  let outsider: TestUser;
  let org: string;
  let vault: string;
  let released: Array<[string, string]>;

  beforeEach(async () => {
    await resetDb();
    owner = await signUp("owner@brake-release.test");
    org = (await createOrg(owner, "Brake Co", "brake-co")).id;
    member = await signUp("member@brake-release.test");
    other = await signUp("other@brake-release.test");
    outsider = await signUp("outsider@brake-release.test");
    await seedMember(org, member.userId, "member");
    await seedMember(org, other.userId, "member");
    vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    shrinkBrake.configure({ threshold: 2, windowMs: 60_000, holdMs: 600_000 });
    released = [];
    setShrinkBrakeReleaseHook((vaultId, userId) => released.push([vaultId, userId]));
  });
  afterEach(() => {
    setShrinkBrakeReleaseHook(null);
    shrinkBrake.configure({ threshold: 0 });
  });

  async function engage(user: TestUser) {
    reportShrink(vault, "doc-a", BODY, "", user.userId);
    reportShrink(vault, "doc-b", BODY, "", user.userId);
    expect(isShrinkHeld(user.userId, vault)).toBe(true);
    const hold = shrinkBrake.holdOf(user.userId, vault)!;
    await recordBrakeEngaged(vault, user.userId, hold.count, new Date(hold.until));
  }

  it("owners see every hold; a member sees only their own", async () => {
    await engage(member);
    await engage(other);
    const asOwner = await req(owner, "GET", `/api/vaults/${vault}/shrink-brakes`);
    expect(asOwner.status).toBe(200);
    const ownerBody = (await asOwner.json()) as {
      items: Array<{ userId: string; held: boolean; noteCount: number }>;
      canRelease: boolean;
    };
    expect(ownerBody.canRelease).toBe(true);
    expect(ownerBody.items.map((i) => i.userId).sort()).toEqual([member.userId, other.userId].sort());
    expect(ownerBody.items.every((i) => i.held && i.noteCount === 2)).toBe(true);

    const asMember = await req(member, "GET", `/api/vaults/${vault}/shrink-brakes`);
    const memberBody = (await asMember.json()) as { items: Array<{ userId: string }>; canRelease: boolean };
    expect(memberBody.canRelease).toBe(false);
    expect(memberBody.items.map((i) => i.userId)).toEqual([member.userId]);

    expect((await req(outsider, "GET", `/api/vaults/${vault}/shrink-brakes`)).status).toBe(403);
  });

  it("only an owner/admin can release, and releasing lifts the hold", async () => {
    await engage(member);
    const path = `/api/vaults/${vault}/shrink-brake/${member.userId}/release`;

    const denied = await req(member, "POST", path);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code?: string }).code).toBe("not_manager");
    expect((await req(outsider, "POST", path)).status).toBe(403);
    expect(isShrinkHeld(member.userId, vault)).toBe(true);
    expect(released).toEqual([]);

    const ok = await req(owner, "POST", path);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, releasedRows: 1, heldHere: true });
    expect(isShrinkHeld(member.userId, vault)).toBe(false);
    // The hook is what fans the release out to other instances and the user's app.
    expect(released).toEqual([[vault, member.userId]]);

    const [row] = await listBrakeEvents(vault, new Date(0), null);
    expect(row.held).toBe(false);
    expect(row.releasedBy).toBe(owner.userId);
    expect(row.releasedAt).not.toBeNull();
  });

  it("releasing is idempotent and safe when nothing is held", async () => {
    const res = await req(owner, "POST", `/api/vaults/${vault}/shrink-brake/${member.userId}/release`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, releasedRows: 0, heldHere: false });
  });

  it("after a release, sharp shrinks still count towards a fresh brake", async () => {
    await engage(member);
    await req(owner, "POST", `/api/vaults/${vault}/shrink-brake/${member.userId}/release`);
    reportShrink(vault, "doc-c", BODY, "", member.userId);
    expect(isShrinkHeld(member.userId, vault)).toBe(false);
    reportShrink(vault, "doc-d", BODY, "", member.userId);
    expect(isShrinkHeld(member.userId, vault)).toBe(true);
  });

  it("an unknown vault is 404", async () => {
    expect((await req(owner, "GET", `/api/vaults/nope/shrink-brakes`)).status).toBe(404);
    expect(
      (await req(owner, "POST", `/api/vaults/nope/shrink-brake/${member.userId}/release`)).status,
    ).toBe(404);
  });
});
