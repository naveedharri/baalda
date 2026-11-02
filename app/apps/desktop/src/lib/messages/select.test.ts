import { describe, expect, it } from "vitest";
import { fillPlaceholders, selectMessage } from "./select";
import type { DeliveredMessage, MessageSpec } from "./types";

const msg = (spec: Partial<MessageSpec> & { id: string }, over: Partial<DeliveredMessage> = {}): DeliveredMessage => ({
  spec: { title: "T", body: "B", ...spec },
  orgId: null,
  vaultId: null,
  vaultName: null,
  showCount: 0,
  lastShownAt: null,
  ...over,
});
const ctx = { openOrgId: "org1", canRevealKey: () => true };

describe("selectMessage", () => {
  it("picks the highest priority, then server order", () => {
    const pick = selectMessage([msg({ id: "a", priority: 1 }), msg({ id: "b", priority: 5 }), msg({ id: "c", priority: 5 })], ctx);
    expect(pick?.spec.id).toBe("b");
  });

  it("shows per-vault messages only for the open vault", () => {
    const list = [msg({ id: "v", perVault: true }, { orgId: "org2", vaultId: "x", vaultName: "Other" })];
    expect(selectMessage(list, ctx)).toBeNull();
    expect(selectMessage(list, { ...ctx, openOrgId: "org2" })?.spec.id).toBe("v");
  });

  it("skips a vault-key message this computer cannot reveal", () => {
    const list = [
      msg(
        { id: "k", perVault: true, actions: [{ id: "s", kind: "save-vault-key", label: "Save" }] },
        { orgId: "org1", vaultId: "v1", vaultName: "Mine" },
      ),
    ];
    expect(selectMessage(list, { ...ctx, canRevealKey: () => false })).toBeNull();
    expect(selectMessage(list, ctx)?.spec.id).toBe("k");
  });

  it("skips unknown display kinds and drops unknown or unsafe actions", () => {
    expect(selectMessage([msg({ id: "x", display: { kind: "hologram" } })], ctx)).toBeNull();
    const pick = selectMessage(
      [
        msg({
          id: "y",
          actions: [
            { id: "1", kind: "teleport", label: "Go" },
            { id: "2", kind: "open-url", label: "Bad", url: "http://example.com" },
            { id: "3", kind: "open-url", label: "Good", url: "https://example.com" },
            { id: "4", kind: "open-settings", label: "Nope", target: "vault:nowhere" },
          ],
        }),
      ],
      { ...ctx, knownTarget: (t) => t === "vault:general#security" },
    );
    expect(pick?.actions.map((a) => a.id)).toEqual(["3"]);
  });

  it("fills placeholders and honours the skip set", () => {
    const list = [msg({ id: "p", perVault: true, title: "Hi {name}", body: "{vaultName} {other}" }, { orgId: "org1", vaultId: "v", vaultName: "Acme" })];
    const pick = selectMessage(list, { ...ctx, userName: "Sam" });
    expect(pick?.spec.title).toBe("Hi Sam");
    expect(pick?.spec.body).toBe("Acme {other}");
    expect(selectMessage(list, { ...ctx, skip: new Set([pick!.key]) })).toBeNull();
  });

  it("falls back when a placeholder value is missing", () => {
    expect(fillPlaceholders("{vaultName}", {})).toBe("This vault");
  });
});
