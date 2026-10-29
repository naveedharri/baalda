import { describe, expect, it } from "vitest";
import {
  fromBase64,
  generateAccountKeypair,
  generateVaultKey,
  isValidRecoveryPhrase,
  makeVkCheck,
  newRecoveryPhrase,
  openSealedVk,
  publicKeyFromPrivate,
  RECOVERY_ARGON2,
  sealVkTo,
  toBase64,
  unwrapPrivateKeyWithPhrase,
  verifyVk,
  vkCheckGeneration,
  wrapPrivateKeyWithPhrase,
} from "./crypto";

// Cheap Argon2 for the round-trip tests; the default is timed once below.
const FAST = { m: 256, t: 1, p: 1 };

describe("vault key", () => {
  it("is 32 random bytes and survives base64", () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    expect(a.length).toBe(32);
    expect(toBase64(a)).not.toBe(toBase64(b));
    expect(fromBase64(toBase64(a))).toEqual(a);
  });
});

describe("vk_check", () => {
  it("verifies the right key and refuses a wrong key or vault", async () => {
    const vk = generateVaultKey();
    const check = await makeVkCheck(vk, "vault-1", 7);
    expect(await verifyVk(vk, "vault-1", check)).toBe(true);
    expect(await verifyVk(generateVaultKey(), "vault-1", check)).toBe(false);
    expect(await verifyVk(vk, "vault-2", check)).toBe(false);
    const tampered = check.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(await verifyVk(vk, "vault-1", tampered)).toBe(false);
  });

  it("has the fixed layout: 0x01 | u16 BE generation | 12-byte nonce | ct | 16-byte tag", async () => {
    const check = await makeVkCheck(generateVaultKey(), "v", 0x0102);
    expect(check[0]).toBe(1);
    expect([check[1], check[2]]).toEqual([1, 2]);
    expect(vkCheckGeneration(check)).toBe(0x0102);
    expect(check.length).toBe(1 + 2 + 12 + "baalda-vk-check-v1".length + 16);
  });

  it("matches the server's construction (AES-256-GCM, AAD bd1|vaults|vk_check|id|id)", async () => {
    const vk = new Uint8Array(32).fill(9);
    const check = await makeVkCheck(vk, "abc", 1);
    const key = await crypto.subtle.importKey("raw", vk, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: check.slice(3, 15),
        additionalData: new TextEncoder().encode("bd1|vaults|vk_check|abc|abc"),
      },
      key,
      check.slice(15),
    );
    expect(new TextDecoder().decode(plain)).toBe("baalda-vk-check-v1");
  });
});

describe("sealed vault key", () => {
  it("round-trips and refuses another key", () => {
    const alice = generateAccountKeypair();
    const bob = generateAccountKeypair();
    expect(publicKeyFromPrivate(alice.privateKey)).toEqual(alice.publicKey);
    const vk = generateVaultKey();
    const sealed = sealVkTo(alice.publicKey, vk);
    expect(openSealedVk(alice.privateKey, sealed)).toEqual(vk);
    expect(() => openSealedVk(bob.privateKey, sealed)).toThrow();
  });

  it("has a stable format and detects tampering", () => {
    const alice = generateAccountKeypair();
    const vk = generateVaultKey();
    const sealed = sealVkTo(alice.publicKey, vk);
    expect(sealed.length).toBe(1 + 32 + 24 + 32 + 16);
    expect(sealed[0]).toBe(1);
    // A fresh ephemeral key every time: two seals of the same VK differ.
    expect(toBase64(sealVkTo(alice.publicKey, vk))).not.toBe(toBase64(sealed));
    for (const i of [1, 40, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] ^= 1;
      expect(() => openSealedVk(alice.privateKey, bad)).toThrow();
    }
  });
});

describe("recovery phrase", () => {
  it("is 24 valid BIP39 words", () => {
    const phrase = newRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidRecoveryPhrase(phrase)).toBe(true);
    expect(isValidRecoveryPhrase(`  ${phrase.toUpperCase()}  `)).toBe(true);
    expect(isValidRecoveryPhrase("abandon ".repeat(24))).toBe(false);
  });

  it("wraps and unwraps the account private key; a wrong phrase fails", async () => {
    const { privateKey } = generateAccountKeypair();
    const phrase = newRecoveryPhrase();
    const wrapped = await wrapPrivateKeyWithPhrase(phrase, privateKey, FAST);
    expect(await unwrapPrivateKeyWithPhrase(` ${phrase.toUpperCase()} `, wrapped)).toEqual(privateKey);
    await expect(unwrapPrivateKeyWithPhrase(newRecoveryPhrase(), wrapped)).rejects.toThrow();
    const bad = wrapped.slice();
    bad[bad.length - 1] ^= 1;
    await expect(unwrapPrivateKeyWithPhrase(phrase, bad)).rejects.toThrow();
  });

  it("refuses hostile Argon2 parameters", async () => {
    const phrase = newRecoveryPhrase();
    const wrapped = await wrapPrivateKeyWithPhrase(phrase, generateAccountKeypair().privateKey, FAST);
    const bad = wrapped.slice();
    new DataView(bad.buffer).setUint32(17, 0xffffffff); // m
    await expect(unwrapPrivateKeyWithPhrase(phrase, bad)).rejects.toThrow(/out of range/);
  });

  it("default parameters (64 MiB, t=3) round-trip", { timeout: 60_000 }, async () => {
    const { privateKey } = generateAccountKeypair();
    const phrase = newRecoveryPhrase();
    const t0 = performance.now();
    const wrapped = await wrapPrivateKeyWithPhrase(phrase, privateKey, RECOVERY_ARGON2);
    const ms = performance.now() - t0;
    console.info(`[vaultKeys] argon2id m=64MiB t=3 p=1: ${Math.round(ms)} ms`);
    expect(await unwrapPrivateKeyWithPhrase(phrase, wrapped)).toEqual(privateKey);
  });
});
