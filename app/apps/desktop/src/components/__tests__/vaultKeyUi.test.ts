import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  FRESH_KEY_EXPLAINER,
  lostDevicesStep,
  offersLostDevices,
  offersRestoreInstead,
  runFreshAccountKey,
  waitingNoticeCode,
  type LostDevicesStep,
} from "../../lib/vaultKeys/recovery";

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

  it("Vault Settings never offers or explains encryption for an unkeyed vault (automatic, no opt-in)", () => {
    const view = (state: VaultKeyState | null, role: "owner" | "admin" | "member", hasWords = false) =>
      vaultKeySectionView({ hasWords, state, isOwner: role === "owner", canManage: role !== "member" });
    for (const state of [
      { state: "unkeyed", conversionAllowed: false, encryptionRequested: false },
      { state: "unkeyed", conversionAllowed: true, encryptionRequested: true },
      { state: "unkeyed", conversionAllowed: true },
    ] as VaultKeyState[]) {
      for (const role of ["owner", "admin", "member"] as const) expect(view(state, role)).toBe("hidden");
    }
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

describe("lost every device", () => {
  it("offers the path only while waiting for another device's approval", () => {
    expect(offersLostDevices({ state: "awaiting-device-approval", code: "ab12 cd34" })).toBe(true);
    expect(offersLostDevices({ state: "ready", isNew: false })).toBe(false);
    expect(offersLostDevices({ state: "security-warning" })).toBe(false);
    expect(offersLostDevices(null)).toBe(false);
  });

  it("restore-instead is owner-only and needs an open vault", () => {
    expect(offersRestoreInstead({ isOwner: true, vaultId: "v1" })).toBe(true);
    expect(offersRestoreInstead({ isOwner: false, vaultId: "v1" })).toBe(false);
    expect(offersRestoreInstead({ isOwner: true, vaultId: null })).toBe(false);
  });

  it("steps: open, confirm, started, waiting with the code; refusals close", () => {
    const closed: LostDevicesStep = { step: "closed" };
    const confirm = lostDevicesStep(closed, { type: "open" });
    expect(confirm).toEqual({ step: "confirm" });
    expect(lostDevicesStep(confirm, { type: "started", code: "1a2b 3c4d 5e6f 7a8b" })).toEqual({
      step: "waiting",
      code: "1a2b 3c4d 5e6f 7a8b",
    });
    expect(lostDevicesStep(confirm, { type: "refused" })).toEqual(closed);
    expect(lostDevicesStep(confirm, { type: "cancel" })).toEqual(closed);
    expect(lostDevicesStep(confirm, { type: "restore" })).toEqual({ step: "restore" });
    // A late "started" never reopens a closed or restoring flow.
    expect(lostDevicesStep(closed, { type: "started", code: "x" })).toEqual(closed);
    expect(lostDevicesStep({ step: "restore" }, { type: "started", code: "x" })).toEqual({ step: "restore" });
  });

  it("runFreshAccountKey: started with the code, not-allowed, rate-limited message, other errors rethrown", async () => {
    const fake = (start: () => Promise<boolean>, code: string | null = "1a2b 3c4d 5e6f 7a8b") => ({
      startFreshAccountKey: vi.fn(start),
      accountKeyCode: vi.fn(async () => code),
    });
    expect(await runFreshAccountKey(fake(async () => true))).toEqual({ kind: "started", code: "1a2b 3c4d 5e6f 7a8b" });
    const refused = fake(async () => false);
    expect(await runFreshAccountKey(refused)).toEqual({ kind: "not-allowed" });
    expect(refused.accountKeyCode).not.toHaveBeenCalled();
    const msg = "Your security key was replaced 3 times in the last day. Try again in about 20 hours.";
    expect(
      await runFreshAccountKey(
        fake(async () => {
          throw new ApiError(429, "x", { error: msg, code: "rate_limited", retryAfter: 72000 });
        }),
      ),
    ).toEqual({ kind: "rate-limited", message: msg });
    await expect(
      runFreshAccountKey(
        fake(async () => {
          throw new Error("network");
        }),
      ),
    ).rejects.toThrow("network");
  });

  it("the waiting notice shows the new key's code only while a teammate must re-seal", () => {
    expect(waitingNoticeCode({ freshCode: "1a2b 3c4d 5e6f 7a8b", vaultState: "waiting-for-teammate" })).toBe(
      "1a2b 3c4d 5e6f 7a8b",
    );
    expect(waitingNoticeCode({ freshCode: "1a2b 3c4d 5e6f 7a8b", vaultState: "key-mismatch" })).toBeNull();
    expect(waitingNoticeCode({ freshCode: "1a2b 3c4d 5e6f 7a8b", vaultState: null })).toBeNull();
    expect(waitingNoticeCode({ freshCode: null, vaultState: "waiting-for-teammate" })).toBeNull();
    expect(FRESH_KEY_EXPLAINER).toContain("Your notes on the server are not affected.");
  });
});
