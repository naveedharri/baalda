import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecurityCodeRow } from "../SecurityCodeField";
import { ownSecurityCodeView, SECURITY_CODE_HINT } from "../../lib/vaultKeys/sectionView";
import { generateAccountKeypair, shortFingerprint } from "../../lib/vaultKeys/crypto";
import { createVaultKeySession } from "../../lib/vaultKeys/session";

describe("Your security code (Account Settings)", () => {
  it("shows only while the account key is ready on this computer", () => {
    expect(ownSecurityCodeView({ state: "ready" }, "1a2b 3c4d 5e6f 7a8b")).toBe("1a2b 3c4d 5e6f 7a8b");
    expect(ownSecurityCodeView({ state: "disabled" }, "1a2b 3c4d 5e6f 7a8b")).toBeNull();
    expect(ownSecurityCodeView({ state: "awaiting-device-approval" }, "1a2b 3c4d 5e6f 7a8b")).toBeNull();
    expect(ownSecurityCodeView({ state: "security-warning" }, "1a2b 3c4d 5e6f 7a8b")).toBeNull();
    expect(ownSecurityCodeView(null, "1a2b 3c4d 5e6f 7a8b")).toBeNull();
    expect(ownSecurityCodeView({ state: "ready" }, null)).toBeNull();
  });

  it("renders the code with the read-it-out hint", () => {
    const html = renderToStaticMarkup(createElement(SecurityCodeRow, { code: "1a2b 3c4d 5e6f 7a8b" }));
    expect(html).toContain("Your security code");
    expect(html).toContain("1a2b 3c4d 5e6f 7a8b");
    expect(html).toContain(SECURITY_CODE_HINT);
  });

  it("is the same code teammates see in the key-changed prompt", async () => {
    const { privateKey, publicKey } = generateAccountKeypair();
    const session = createVaultKeySession({
      api: {} as never,
      keys: { getAccountPrivateKey: async () => privateKey } as never,
      pins: {} as never,
      features: async () => new Set(["vault-keys"]),
      keysAllowed: () => false,
      isMember: async () => true,
      selfUserId: () => "me",
      deviceId: () => "d1",
    });
    expect(await session.accountKeyCode()).toBe(shortFingerprint(publicKey));
    session.dispose();
  });
});
