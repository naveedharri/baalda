// Live-server check (env-gated like the sync integration test): a teammate who
// joins an encrypted vault gets its key from the owner's device, end to end,
// through the real key session and API client both desktops run.
//   KEYS_IT=http://localhost:3010 pnpm vitest run src/lib/vaultKeys/joinKeyShare.it.test.ts
// The server must run with BAALDA_VAULT_KEYS=1. Creates throwaway accounts.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";
import { createVaultKeySession, type KeyPinStore, type VaultKeyStore } from "./session";
import { VAULT_KEYS } from "../serverFeatures";

const BASE = process.env.KEYS_IT;

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
  const email = `keys-it-${label}-${tag}@demo.local`;
  await api.signUp({ email, password: "demopass1234", name: label });
  const session = (await api.getSession())!;
  return { api, email, userId: session.user.id };
}

function sessionOf(p: { api: ApiClient; userId: string }, orgId: () => string | null, opts: { keysAllowed?: boolean } = {}) {
  return createVaultKeySession({
    api: p.api,
    keys: memoryKeys(),
    pins: memoryPins(),
    features: async () => new Set([VAULT_KEYS]),
    keysAllowed: () => opts.keysAllowed ?? false,
    selfUserId: () => p.userId,
    deviceId: () => `dev-${p.userId}`,
    isMember: async (_v, uid) => {
      const id = orgId();
      if (!id) return false;
      const { members } = await p.api.getMembersOverview(id);
      return members.some((m) => m.userId === uid);
    },
  });
}

describe.skipIf(!BASE)("joining an encrypted vault (live server)", () => {
  it("the owner's device shares the key and the teammate opens the vault", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const owner = await person("owner", tag);
    const mate = await person("mate", tag);

    const org = await owner.api.createOrganization({ name: `Keys IT ${tag}`, slug: `keys-it-${tag}` });
    const vault = await owner.api.createVault({ name: `Keys IT ${tag}`, organizationId: org.id });
    const ownerSession = sessionOf(owner, () => org.id, { keysAllowed: true });

    // Owner's device keys the new vault.
    expect((await ownerSession.ensureAccountKeys()).state).toBe("ready");
    expect((await ownerSession.ensureVaultKey(vault.id)).state).toBe("ready");

    // Teammate joins with the vault's code.
    await owner.api.setActiveOrganization(org.id);
    const code = await owner.api.getJoinCode();
    await mate.api.joinVault(code);

    const mateSession = sessionOf(mate, () => org.id);
    // His app opens the vault: account key first, then the gate files the request.
    expect((await mateSession.ensureAccountKeys()).state).toBe("ready");
    expect(await mateSession.gateVaultOpen(vault.id)).toBe("paused");

    // The owner's 2-minute loop: one run.
    expect((await ownerSession.ensureVaultKey(vault.id)).state).toBe("ready");
    const served = await ownerSession.serviceKeyRequests(vault.id);
    console.log("[keys-it] serviced", JSON.stringify(served));
    expect(served.sealed.map((s) => s.userId)).toContain(mate.userId);

    // Teammate retries: the gate now proceeds with a verified key.
    expect(await mateSession.gateVaultOpen(vault.id)).toBe("proceed");
    expect(mateSession.headerFor(vault.id)).toBeTruthy();
  }, 60_000);
});
