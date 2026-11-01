// The key-exchange lists arrive wrapped (`{ requests }`, `{ devices }`), as
// http/routes/vault-keys.ts sends them. A bare-array read made both lists
// always empty: no key holder ever shared a vault key with a new member, and
// no computer ever saw a new one waiting for approval.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api";

function clientAnswering(body: unknown) {
  const fetchImpl = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return new ApiClient({ baseUrl: "http://server.test", token: "t", fetchImpl: fetchImpl as never });
}

describe("vault-key list responses", () => {
  const request = { userId: "u1", requestedAt: "2026-11-01T00:00:00Z", publicKey: "cGs=", keyChangedAt: null };
  const device = { deviceId: "d1", publicKey: "cGs=", requestedAt: "2026-11-01T00:00:00Z", name: null };

  it("reads the server's { requests } envelope", async () => {
    expect(await clientAnswering({ requests: [request] }).listVaultKeyRequests("v1")).toEqual([request]);
  });
  it("keeps the contract's `kind` (request | missing) on each row", async () => {
    const rows = [
      { userId: "u1", requestedAt: "2026-11-01T00:00:00Z", publicKey: "cGs=", keyChangedAt: null, kind: "request" },
      { userId: "u2", requestedAt: "2026-10-01T00:00:00Z", publicKey: "cHM=", keyChangedAt: "2026-10-02T00:00:00Z", kind: "missing" },
    ];
    const got = await clientAnswering({ requests: rows }).listVaultKeyRequests("v1");
    expect(got).toEqual(rows);
    expect(got.map((r) => r.kind)).toEqual(["request", "missing"]);
  });
  it("still reads a bare array", async () => {
    expect(await clientAnswering([request]).listVaultKeyRequests("v1")).toEqual([request]);
  });
  it("reads the server's { devices } envelope", async () => {
    expect(await clientAnswering({ devices: [device] }).listPendingDevices()).toEqual([device]);
  });
  it("treats anything else as empty", async () => {
    expect(await clientAnswering({}).listVaultKeyRequests("v1")).toEqual([]);
    expect(await clientAnswering(null).listPendingDevices()).toEqual([]);
  });
});
