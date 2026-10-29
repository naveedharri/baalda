import { describe, expect, it } from "vitest";

import { NOTICE_PRIORITY, pickNotice } from "../../lib/noticeSlot";
import { memberDisplayName } from "../../lib/vaultKeys/names";
import { CONVERTING_LINE, conversionLine, vaultKeySectionView } from "../../lib/vaultKeys/sectionView";
import type { VaultKeyState } from "../../lib/vaultKeys/session";

describe("vault key UI", () => {
  it("names people from the roster, never by raw id", () => {
    const members = [
      { userId: "u1", user: { name: "Sara Khan", email: "sara@example.com" } },
      { userId: "u2", user: { name: " ", email: "lee@example.com" } },
    ];
    expect(memberDisplayName(members, "u1")).toBe("Sara Khan");
    expect(memberDisplayName(members, "u2")).toBe("lee@example.com");
    expect(memberDisplayName(members, "u9")).toBe("A teammate");
  });

  it("Vault Settings offers Encrypt only for an unrequested vault, to owners and admins", () => {
    const view = (state: VaultKeyState | null, role: "owner" | "admin" | "member", hasWords = false) =>
      vaultKeySectionView({ hasWords, state, isOwner: role === "owner", canManage: role !== "member" });
    const unrequested: VaultKeyState = { state: "unkeyed", conversionAllowed: false, encryptionRequested: false };
    const requested: VaultKeyState = { state: "unkeyed", conversionAllowed: false, encryptionRequested: true };

    expect(view(unrequested, "owner")).toBe("encrypt-offer");
    expect(view(unrequested, "admin")).toBe("encrypt-offer");
    expect(view(unrequested, "member")).toBe("hidden");
    expect(view(requested, "owner")).toBe("setting-up");
    expect(view(requested, "admin")).toBe("setting-up");
    expect(view(requested, "member")).toBe("hidden");
    // An older server that converts on its own never gets a button.
    expect(view({ state: "unkeyed", conversionAllowed: true }, "admin")).toBe("setting-up");
    // A server without opt-in (no encryptionRequested) has no request route: no button.
    expect(view({ state: "unkeyed", conversionAllowed: false }, "owner")).toBe("hidden");
    // Unknown state: nothing.
    expect(view(null, "owner")).toBe("hidden");
    // The key itself stays owner-only.
    expect(view({ state: "ready", generation: 1 }, "owner", true)).toBe("reveal");
    expect(view({ state: "ready", generation: 1 }, "admin", true)).toBe("hidden");
    expect(view({ state: "waiting-for-teammate" }, "owner")).toBe("restore");
    expect(view({ state: "waiting-for-teammate" }, "admin")).toBe("hidden");
    expect(view({ state: "security-warning" }, "owner")).toBe("hidden");
  });

  it("the waiting-for-key notice sits below closed-app changes and above not-syncing", () => {
    const at = (id: string) => NOTICE_PRIORITY.indexOf(id as never);
    expect(at("vault-key-waiting")).toBe(at("closed-app-changes") + 1);
    expect(at("not-syncing")).toBe(at("vault-key-waiting") + 1);
    expect(pickNotice(new Set(["vault-key-waiting", "root-missing"]))).toBe("root-missing");
  });

  it("says older content is still being encrypted only while the server reports it", () => {
    const ready: VaultKeyState = { state: "ready", generation: 1 };
    const base = { state: ready, isOwner: true, canManage: true };
    expect(conversionLine({ ...base, fullyEncrypted: false })).toBe(CONVERTING_LINE);
    expect(conversionLine({ ...base, fullyEncrypted: true })).toBeNull();
    // An older server that does not report it: no claim either way.
    expect(conversionLine({ ...base, fullyEncrypted: undefined })).toBeNull();
    // Admins see it too; plain members never do.
    expect(conversionLine({ ...base, isOwner: false, fullyEncrypted: false })).toBe(CONVERTING_LINE);
    expect(conversionLine({ ...base, isOwner: false, canManage: false, fullyEncrypted: false })).toBeNull();
    // Not keyed: nothing to convert.
    expect(conversionLine({ ...base, state: { state: "unkeyed", encryptionRequested: true }, fullyEncrypted: false })).toBeNull();
  });
});
