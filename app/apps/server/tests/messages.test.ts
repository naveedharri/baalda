// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { makeVkCheck } from "../src/crypto/vk-check.js";
import { VAULT_KEYS_MIN_DESKTOP } from "../src/http/client-version.js";
import { setMessagesPublisher, type MessagesChangedEvent } from "../src/messages/events.js";
import { testAppDeps } from "./helpers/app.js";
import { resetDb } from "./helpers/db.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedVault } from "./helpers/seed.js";

const app = createApp(testAppDeps());
const ADMIN = "a".repeat(40);

function call(user: TestUser, method: string, path: string, body?: unknown, version = "0.1.100") {
  return app.request(`/api${path}`, {
    method,
    headers: { ...authHeaders(user), "content-type": "application/json", "x-baalda-version": version },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function admin(method: string, path: string, body?: unknown, token: string | null = ADMIN) {
  return app.request(`/api/admin${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-baalda-admin-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function pending(user: TestUser, version?: string) {
  const res = await call(user, "GET", "/messages", undefined, version);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: { spec: { id: string }; orgId: string | null }[] }).messages;
}

const base = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: "Hello", body: "Body text", ...extra });

async function keyVault(vaultId: string, generation = 1) {
  await pool.query("UPDATE vaults SET vk_check = $2, key_generation = $3 WHERE id = $1", [
    vaultId,
    makeVkCheck(randomBytes(32), vaultId),
    generation,
  ]);
}

async function setup() {
  const owner = await signUp("owner@msg.test");
  const member = await signUp("member@msg.test");
  const org = await createOrg(owner, "Team", `msg-${Date.now()}`);
  await seedMember(org.id, member.userId, "member");
  const vaultId = await seedVault(org.id);
  return { owner, member, orgId: org.id, vaultId };
}

describe("messages", () => {
  beforeEach(async () => {
    vi.stubEnv("BAALDA_ADMIN_TOKEN", ADMIN);
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    await resetDb();
    await pool.query("DELETE FROM app_messages");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool.query("DELETE FROM app_messages");
    await pool.end();
  });

  it("admin routes are 404 without, with a wrong, or with no configured token", async () => {
    expect((await admin("GET", "/messages", undefined, null)).status).toBe(404);
    expect((await admin("GET", "/messages", undefined, "b".repeat(40))).status).toBe(404);
    expect((await admin("GET", "/messages")).status).toBe(200);
    vi.stubEnv("BAALDA_ADMIN_TOKEN", undefined);
    expect((await admin("GET", "/messages")).status).toBe(404);
    vi.stubEnv("BAALDA_ADMIN_TOKEN", "short");
    expect((await admin("GET", "/messages", undefined, "short")).status).toBe(404);
  });

  it("validates specs strictly", async () => {
    const bad = async (spec: unknown) => {
      const res = await admin("POST", "/messages", spec);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_message");
    };
    await bad(base("m-url", { actions: [{ id: "go", label: "Go", kind: "open-url", url: "http://x.test" }] }));
    await bad(base("m-kind", { actions: [{ id: "x", label: "X", kind: "explode" }] }));
    await bad(base("m-extra", { surprise: true }));
    await bad(base("Bad Id"));
    await bad(base("m-dup", { actions: [{ id: "a", label: "A", kind: "done" }, { id: "a", label: "B", kind: "dismiss" }] }));
    expect((await admin("POST", "/messages", base("m-ok"))).status).toBe(201);
    expect((await admin("POST", "/messages", base("m-ok"))).status).toBe(409);
    expect((await admin("PUT", "/messages/m-ok", base("m-other"))).status).toBe(400);
    expect((await admin("PUT", "/messages/m-ok", base("m-ok", { title: "New" }))).status).toBe(200);
    expect((await admin("DELETE", "/messages/m-ok")).status).toBe(200);
    expect((await admin("PUT", "/messages/m-ok", base("m-ok"))).status).toBe(409);
  });

  it("audience fields combine with AND, versions bound both ways", async () => {
    const s = await setup();
    await admin("POST", "/messages", base("owners-new", { audience: { roles: ["owner"], minVersion: "0.1.100" } }));
    await admin("POST", "/messages", base("old-only", { audience: { maxVersion: "0.1.90" } }));
    expect((await pending(s.owner)).map((m) => m.spec.id)).toEqual(["owners-new"]);
    expect((await pending(s.owner, "0.1.99")).map((m) => m.spec.id)).toEqual([]);
    expect((await pending(s.owner, "0.1.80")).map((m) => m.spec.id)).toEqual(["old-only"]);
    expect((await pending(s.member)).map((m) => m.spec.id)).toEqual([]);
    const delivered = (await pending(s.owner))[0] as unknown as { spec: Record<string, unknown> };
    expect(delivered.spec.audience).toBeUndefined();
  });

  it("vault-key-not-saved: owner of a keyed vault only, until saved for the current generation", async () => {
    const s = await setup();
    await admin("POST", "/messages", base("save-key", { condition: "vault-key-not-saved" }));
    expect(await pending(s.owner)).toEqual([]);
    await keyVault(s.vaultId);
    const got = await pending(s.owner);
    expect(got.map((m) => [m.spec.id, m.orgId])).toEqual([["save-key", s.orgId]]);
    expect(await pending(s.member)).toEqual([]);

    expect((await call(s.member, "POST", `/vaults/${s.vaultId}/keys/saved`, { method: "file" })).status).toBe(403);
    expect((await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/saved`, { method: "file" })).status).toBe(200);
    expect(await pending(s.owner)).toEqual([]);
    const { rows } = await pool.query("SELECT after_state FROM access_audit WHERE action = 'vault_key_saved'");
    expect(rows).toEqual([{ after_state: { method: "file" } }]);

    await keyVault(s.vaultId, 2);
    expect((await pending(s.owner)).map((m) => m.spec.id)).toEqual(["save-key"]);
  });

  it("keys/saved refuses an unkeyed vault", async () => {
    const s = await setup();
    const res = await call(s.owner, "POST", `/vaults/${s.vaultId}/keys/saved`, { method: "confirmed" }, VAULT_KEYS_MIN_DESKTOP);
    expect(res.status).toBe(409);
  });

  it("receipts: snooze, dismiss, done, once and maxShows", async () => {
    const s = await setup();
    const receipt = (id: string, event: string, extra: Record<string, unknown> = {}) =>
      call(s.owner, "POST", `/messages/${id}/receipt`, { orgId: null, event, ...extra });
    await admin("POST", "/messages", base("snoozy", { actions: [{ id: "later", label: "Later", kind: "remind-later", hours: 5 }] }));
    await admin("POST", "/messages", base("one-shot", { frequency: { mode: "once" } }));
    await admin("POST", "/messages", base("twice", { frequency: { maxShows: 2 } }));
    await admin("POST", "/messages", base("finish"));
    const ids = async () => (await pending(s.owner)).map((m) => m.spec.id).sort();
    expect(await ids()).toEqual(["finish", "one-shot", "snoozy", "twice"]);

    expect((await receipt("snoozy", "snooze", { actionId: "later" })).status).toBe(200);
    const { rows } = await pool.query(
      "SELECT extract(epoch FROM snoozed_until - now()) / 3600 AS h FROM app_message_receipts WHERE message_id = 'snoozy'",
    );
    expect(Math.round(Number(rows[0].h))).toBe(5);
    await receipt("one-shot", "shown");
    await receipt("twice", "shown");
    expect(await ids()).toEqual(["finish", "twice"]);
    await receipt("twice", "shown");
    await receipt("finish", "dismiss");
    expect(await ids()).toEqual([]);
    await pool.query("UPDATE app_message_receipts SET dismissed_at = now() - interval '25 hours' WHERE message_id = 'finish'");
    expect(await ids()).toEqual(["finish"]);
    await receipt("finish", "done");
    expect(await ids()).toEqual([]);

    expect((await receipt("nope", "shown")).status).toBe(404);
    expect((await receipt("finish", "explode")).status).toBe(400);
    const stats = await admin("GET", "/messages/twice/stats");
    expect(await stats.json()).toEqual({ shown: 1, snoozed: 0, dismissed: 0, done: 0, people: 1 });
  });

  it("showing: the message on screen survives its own shown receipt, not an answer", async () => {
    const s = await setup();
    const receipt = (id: string, event: string) =>
      call(s.owner, "POST", `/messages/${id}/receipt`, { orgId: null, event });
    await admin("POST", "/messages", base("one-shot", { frequency: { mode: "once", maxShows: 1, minHoursBetweenShows: 24 } }));
    await admin("POST", "/messages", base("other", { frequency: { mode: "once" } }));
    await receipt("one-shot", "shown");
    await receipt("other", "shown");
    const ids = async (q = "") => {
      const res = await call(s.owner, "GET", `/messages${q}`);
      return ((await res.json()) as { messages: { spec: { id: string } }[] }).messages.map((m) => m.spec.id);
    };
    expect(await ids()).toEqual([]);
    expect(await ids("?showing=one-shot&showingOrg=")).toEqual(["one-shot"]);
    expect(await ids("?showing=one-shot&showingOrg=some-org")).toEqual([]);
    await receipt("one-shot", "dismiss");
    expect(await ids("?showing=one-shot&showingOrg=")).toEqual([]);
  });

  it("a per-vault message for other vaults does not crowd out the open vault", async () => {
    const s = await setup();
    await keyVault(s.vaultId);
    const orgs = [s.orgId];
    for (let i = 0; i < 6; i++) {
      const org = await createOrg(s.owner, `Team ${i}`, `msg-${Date.now()}-${i}`);
      await keyVault(await seedVault(org.id));
      orgs.push(org.id);
    }
    await admin("POST", "/messages", base("save-key", { condition: "vault-key-not-saved", priority: 100 }));
    await admin("POST", "/messages", base("everyone"));
    const list = async (q: string) => {
      const res = await call(s.owner, "GET", `/messages${q}`);
      return ((await res.json()) as { messages: { spec: { id: string }; orgId: string | null }[] }).messages.map(
        (m) => [m.spec.id, m.orgId],
      );
    };

    // A build that doesn't name the open vault still gets the capped list.
    const old = await list("");
    expect(old).toHaveLength(5);
    expect(old.some(([id]) => id === "everyone")).toBe(false);

    const open = orgs[6];
    expect(await list(`?org=${open}`)).toEqual([
      ["save-key", open],
      ["everyone", null],
    ]);
    // No synced vault open: only what isn't tied to a vault.
    expect(await list("?org=")).toEqual([["everyone", null]]);
    // The message on screen stays in the list after a vault switch.
    expect(await list(`?org=${open}&showing=save-key&showingOrg=${orgs[0]}`)).toContainEqual(["save-key", orgs[0]]);
  });

  it("keying a vault tells the owner's apps to ask for messages again", async () => {
    vi.stubEnv("VAULT_KEY_CONVERSION", "on");
    const s = await setup();
    const events: MessagesChangedEvent[] = [];
    setMessagesPublisher((e) => events.push(e));
    try {
      const vk = randomBytes(32);
      const res = await app.request(`/api/vaults/${s.vaultId}/keys/init`, {
        method: "POST",
        headers: {
          ...authHeaders(s.owner),
          "content-type": "application/json",
          "x-baalda-version": "0.1.111",
          "x-baalda-vk": vk.toString("base64"),
        },
        body: JSON.stringify({
          vkCheck: makeVkCheck(vk, s.vaultId).toString("base64"),
          generation: 1,
          sealedVkForSelf: randomBytes(80).toString("base64"),
        }),
      });
      expect(res.status).toBe(201);
      expect(events).toContainEqual({ scope: "user", userId: s.owner.userId });
    } finally {
      setMessagesPublisher(null);
    }
  });
});
