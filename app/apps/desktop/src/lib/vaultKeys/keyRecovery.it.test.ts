// Live-server check of the launch safety net (server crypto/key-recovery.ts +
// scripts/key-recovery.ts): a member nobody shared the key with is rescued from
// the recovery copy with the offline key, and their app then opens the vault.
//   KEYS_IT=http://localhost:3010 KEY_RECOVERY_IT_KEY_FILE=<offline key file> \
//   KEY_RECOVERY_ADMIN_TOKEN=<token> pnpm vitest run src/lib/vaultKeys/keyRecovery.it.test.ts
// The server must run with BAALDA_VAULT_KEYS on and KEY_RECOVERY_PUBLIC_KEY set
// to that key's public half. Creates throwaway @demo.local accounts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import { VAULT_KEYS } from "../serverFeatures";
import { sealVkTo } from "./crypto";
import { createVaultKeySession, type KeyPinStore, type VaultKeyStore } from "./session";
import { openRecoveryCopy } from "../../../../server/src/crypto/recovery-seal";

const BASE = process.env.KEYS_IT;
const KEY_FILE = process.env.KEY_RECOVERY_IT_KEY_FILE;
const ADMIN = process.env.KEY_RECOVERY_ADMIN_TOKEN;

function memoryKeys(): VaultKeyStore {
  let account: Uint8Array | null = null;
  let link: Uint8Array | null = null;
  const vaults = new Map<string, Uint8Array>();
  const provisional = new Set<string>();
  return {
    getAccountPrivateKey: async () => account,
    setAccountPrivateKey: async (k) => void (account = k),
    getDeviceLinkKey: async () => link,
    setDeviceLinkKey: async (k) => void (link = k),
    deleteDeviceLinkKey: async () => void (link = null),
    getVaultKey: async (id) => vaults.get(id) ?? null,
    setVaultKey: async (id, vk) => void vaults.set(id, vk),
    isVaultKeyProvisional: async (id) => provisional.has(id),
    setVaultKeyProvisional: async (id, on) => void (on ? provisional.add(id) : provisional.delete(id)),
    clearCache: () => {},
  };
}
function memoryPins(): KeyPinStore {
  const m = new Map<string, string>();
  return { get: async (u) => m.get(u) ?? null, set: async (u, f) => void m.set(u, f) };
}

async function person(label: string, tag: string) {
  const api = new ApiClient({ baseUrl: BASE });
  const email = `recovery-${label}-${tag}@demo.local`;
  await api.signUp({ email, password: "demopass1234", name: label });
  const session = (await api.getSession())!;
  return { api, email, userId: session.user.id };
}

function device(p: { api: ApiClient; userId: string }, orgId: string, keysAllowed = false) {
  return createVaultKeySession({
    api: p.api,
    keys: memoryKeys(),
    pins: memoryPins(),
    features: async () => new Set([VAULT_KEYS]),
    keysAllowed: () => keysAllowed,
    selfUserId: () => p.userId,
    deviceId: () => `dev-${p.userId}`,
    isMember: async (_v, uid) => (await p.api.getMembersOverview(orgId)).members.some((m) => m.userId === uid),
  });
}

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/api/admin/key-recovery${path}`, {
    ...init,
    headers: { "x-baalda-recovery-admin": ADMIN!, "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe.skipIf(!BASE || !KEY_FILE || !ADMIN)("launch safety net (live server)", () => {
  it("a member nobody shared the key with is rescued from the recovery copy", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const owner = await person("owner", tag);
    const org = await owner.api.createOrganization({ name: `Recovery ${tag}`, slug: `recovery-${tag}` });
    const vault = await owner.api.createVault({ name: `Recovery ${tag}`, organizationId: org.id });
    await owner.api.setActiveOrganization(org.id);
    const ownerDevice = device(owner, org.id, true);
    expect((await ownerDevice.ensureAccountKeys()).state).toBe("ready");
    expect((await ownerDevice.ensureVaultKey(vault.id)).state).toBe("ready");

    // A member who joined with no key travelling along, and no key holder ran.
    const mate = await person("mate", tag);
    await mate.api.joinVault(await owner.api.getJoinCode().then((c) => c.split("-")[0]!));
    const mateDevice = device(mate, org.id);
    expect((await mateDevice.ensureAccountKeys()).state).toBe("ready");
    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("paused");

    // The owner's app uses the vault (here: a search carrying the key), which
    // leaves the recovery copy (the deposit runs off-stack).
    await fetch(`${BASE}/api/vaults/${vault.id}/search?q=x`, {
      headers: { authorization: `Bearer ${owner.api.getToken()}`, "x-baalda-vk": ownerDevice.headerFor(vault.id)! },
    });
    type Listing = { generation: number; copies: Array<{ sealedVk: string; generation: number }>; members: Array<{ userId: string; publicKey: string | null }> };
    let listing: Listing | null = null;
    for (let i = 0; i < 20; i++) {
      listing = (await (await admin(`/${vault.id}`)).json()) as Listing;
      if (listing.copies.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(listing!.copies.length).toBeGreaterThan(0);

    // What scripts/key-recovery.ts rescue does, with the offline private key.
    const priv = Buffer.from(readFileSync(KEY_FILE!, "utf8").trim(), "base64");
    const vk = openRecoveryCopy(Buffer.from(listing!.copies[0]!.sealedVk, "base64"), priv, vault.id, listing!.generation);
    const matePub = listing!.members.find((m) => m.userId === mate.userId)!.publicKey!;
    const sealed = sealVkTo(new Uint8Array(Buffer.from(matePub, "base64")), new Uint8Array(vk));
    const grant = await admin(`/${vault.id}/grant`, {
      method: "POST",
      headers: { "x-baalda-vk": vk.toString("base64") },
      body: JSON.stringify({ userId: mate.userId, generation: listing!.generation, sealedVk: Buffer.from(sealed).toString("base64") }),
    });
    expect(grant.status).toBe(201);

    expect(await mateDevice.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateDevice.headerFor(vault.id)).toBe(ownerDevice.headerFor(vault.id));
  }, 60_000);
});
