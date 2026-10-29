// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultKeysEnabled } from "../src/crypto/config.js";
import { aadFor, ENVELOPE_OVERHEAD, generationOf, isSealed, open, seal } from "../src/crypto/envelope.js";
import { VaultKeyCache } from "../src/crypto/key-cache.js";
import { makeVkCheck, verifyVk } from "../src/crypto/vk-check.js";

const key = () => randomBytes(32);
const aad = aadFor("doc_updates", "update", "vault-1", "42");

describe("envelope", () => {
  it("round-trips and records the generation", () => {
    const k = key();
    const pt = Buffer.from("hello vault");
    const s = seal(k, aad, pt, 7);
    expect(s.length).toBe(pt.length + ENVELOPE_OVERHEAD);
    expect(s[0]).toBe(0x01);
    expect(generationOf(s)).toBe(7);
    expect(isSealed(s)).toBe(true);
    expect(open(k, aad, s).equals(pt)).toBe(true);
    expect(open(k, aad, seal(k, aad, Buffer.alloc(0))).length).toBe(0);
  });

  it("uses a fresh nonce per seal", () => {
    const k = key();
    expect(seal(k, aad, Buffer.from("x")).equals(seal(k, aad, Buffer.from("x")))).toBe(false);
  });

  it("fails with the wrong key", () => {
    expect(() => open(key(), aad, seal(key(), aad, Buffer.from("x")))).toThrow();
  });

  it("fails when the value is moved to another row, column or vault", () => {
    const k = key();
    const s = seal(k, aad, Buffer.from("x"));
    expect(() => open(k, aadFor("doc_updates", "update", "vault-1", "43"), s)).toThrow();
    expect(() => open(k, aadFor("doc_snapshots", "update", "vault-1", "42"), s)).toThrow();
    expect(() => open(k, aadFor("doc_updates", "update", "vault-2", "42"), s)).toThrow();
  });

  it("fails on tampering anywhere, the generation included", () => {
    const k = key();
    const s = seal(k, aad, Buffer.from("some content"), 3);
    for (const i of [1, 2, 5, 16, s.length - 1]) {
      const t = Buffer.from(s);
      t[i] ^= 0x01;
      expect(() => open(k, aad, t)).toThrow();
    }
    expect(() => open(k, aad, s.subarray(0, s.length - 1))).toThrow();
  });

  it("rejects bad keys, generations and AAD parts", () => {
    expect(() => seal(randomBytes(16), aad, Buffer.from("x"))).toThrow();
    expect(() => seal(key(), aad, Buffer.from("x"), 70000)).toThrow();
    expect(() => aadFor("a|b", "c", "v", "r")).toThrow();
    expect(isSealed(Buffer.from([0x01, 0x00]))).toBe(false);
  });
});

describe("vk_check", () => {
  it("verifies the right key and refuses the wrong one, another vault, or garbage", () => {
    const vk = key();
    const check = makeVkCheck(vk, "vault-1");
    expect(verifyVk(vk, "vault-1", check)).toBe(true);
    expect(verifyVk(key(), "vault-1", check)).toBe(false);
    expect(verifyVk(vk, "vault-2", check)).toBe(false);
    expect(verifyVk(vk, "vault-1", Buffer.from("not a check"))).toBe(false);
    expect(verifyVk(Buffer.alloc(5), "vault-1", check)).toBe(false);
  });
});

describe("VaultKeyCache", () => {
  it("holds while referenced, keeps the grace period, then evicts and zeroes", () => {
    let t = 0;
    const cache = new VaultKeyCache({ graceMs: 1000, now: () => t });
    const vk = key();
    const r1 = cache.acquire("v", vk);
    const r2 = cache.acquire("v", vk);
    const cached = cache.get("v")!.key;
    expect(cached.equals(vk)).toBe(true);
    expect(cached).not.toBe(vk);
    r1();
    r1(); // idempotent
    t = 5000;
    expect(cache.get("v")).not.toBeNull();
    r2();
    t = 5999;
    expect(cache.get("v")).not.toBeNull();
    t = 6000;
    expect(cache.get("v")).toBeNull();
    expect(cached.every((b) => b === 0)).toBe(true);
    expect(vk.every((b) => b === 0)).toBe(false);
  });

  it("re-acquire inside the grace period cancels expiry", () => {
    let t = 0;
    const cache = new VaultKeyCache({ graceMs: 1000, now: () => t });
    const vk = key();
    cache.acquire("v", vk)();
    t = 900;
    const r = cache.acquire("v", vk);
    t = 5000;
    expect(cache.get("v")).not.toBeNull();
    r();
    t = 6001;
    expect(cache.get("v")).toBeNull();
  });

  it("replaces on a higher generation and refuses a conflicting key", () => {
    const cache = new VaultKeyCache();
    const a = key();
    const b = key();
    cache.acquire("v", a, 1);
    const old = cache.get("v")!.key;
    cache.acquire("v", b, 2);
    expect(old.every((x) => x === 0)).toBe(true);
    expect(cache.get("v")).toMatchObject({ generation: 2 });
    expect(cache.get("v")!.key.equals(b)).toBe(true);
    expect(() => cache.acquire("v", key(), 2)).toThrow();
    cache.acquire("v", a, 1); // older generation: held, does not replace
    expect(cache.get("v")!.key.equals(b)).toBe(true);
  });

  it("evict and clear zero the key at once", () => {
    const cache = new VaultKeyCache();
    cache.acquire("v", key());
    const k = cache.get("v")!.key;
    cache.clear();
    expect(cache.size).toBe(0);
    expect(k.every((x) => x === 0)).toBe(true);
  });
});

describe("BAALDA_VAULT_KEYS", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults off and refuses a misspelling", () => {
    vi.stubEnv("BAALDA_VAULT_KEYS", undefined);
    expect(vaultKeysEnabled()).toBe(false);
    vi.stubEnv("BAALDA_VAULT_KEYS", "off");
    expect(vaultKeysEnabled()).toBe(false);
    vi.stubEnv("BAALDA_VAULT_KEYS", "on");
    expect(vaultKeysEnabled()).toBe(true);
    vi.stubEnv("BAALDA_VAULT_KEYS", "maybe");
    expect(() => vaultKeysEnabled()).toThrow("BAALDA_VAULT_KEYS");
  });
});
