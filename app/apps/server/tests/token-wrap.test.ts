// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allowMac, unwrapVk, verifyAllowMac, wrapVk } from "../src/crypto/token-wrap.js";

const T = "mcp_token_keys";

describe("token-wrapped vault keys", () => {
  it("round-trips under the same token, vault and row", () => {
    const vk = randomBytes(32);
    const w = wrapVk("mcp_secret", "mcp-vk", T, "vault-1", "tok-1", vk, 1);
    expect(unwrapVk("mcp_secret", "mcp-vk", T, "vault-1", "tok-1", w)?.equals(vk)).toBe(true);
    expect(w.includes(vk)).toBe(false);
  });

  it("fails with another token, vault, row, purpose or tampering", () => {
    const vk = randomBytes(32);
    const w = wrapVk("mcp_secret", "mcp-vk", T, "vault-1", "tok-1", vk, 1);
    expect(unwrapVk("mcp_other", "mcp-vk", T, "vault-1", "tok-1", w)).toBeNull();
    expect(unwrapVk("mcp_secret", "mcp-vk", T, "vault-2", "tok-1", w)).toBeNull();
    expect(unwrapVk("mcp_secret", "mcp-vk", T, "vault-1", "tok-2", w)).toBeNull();
    expect(unwrapVk("mcp_secret", "link", T, "vault-1", "tok-1", w)).toBeNull();
    const bad = Buffer.from(w);
    bad[bad.length - 1] ^= 1;
    expect(unwrapVk("mcp_secret", "mcp-vk", T, "vault-1", "tok-1", bad)).toBeNull();
  });

  it("allow-list MAC verifies only with the vault key and the exact token", () => {
    const vk = randomBytes(32);
    const hash = createHash("sha256").update("mcp_secret").digest("hex");
    const mac = allowMac(vk, "tok-1", hash);
    expect(verifyAllowMac(vk, "tok-1", hash, mac)).toBe(true);
    expect(verifyAllowMac(randomBytes(32), "tok-1", hash, mac)).toBe(false);
    expect(verifyAllowMac(vk, "tok-2", hash, mac)).toBe(false);
    expect(verifyAllowMac(vk, "tok-1", hash.replace(/^./, "0"), mac)).toBe(hash[0] === "0");
    expect(verifyAllowMac(vk, "tok-1", hash, mac.subarray(0, 16))).toBe(false);
  });
});
