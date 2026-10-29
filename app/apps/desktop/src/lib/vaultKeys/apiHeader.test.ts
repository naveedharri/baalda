import { describe, expect, it } from "vitest";
import { ApiClient, VAULT_KEY_HEADER, vaultIdFromPath } from "../api";

describe("X-Baalda-VK header", () => {
  it("finds the vault id of vault-scoped paths only", () => {
    expect(vaultIdFromPath("/api/vaults/v%201/notes")).toBe("v 1");
    expect(vaultIdFromPath("/api/vaults/v1")).toBeNull();
    expect(vaultIdFromPath("/api/orgs/o1/members/overview")).toBeNull();
  });

  it("is added for a keyed vault the resolver knows, and nowhere else", async () => {
    const seen: Record<string, string>[] = [];
    const api = new ApiClient({
      baseUrl: "http://s",
      token: "t",
      fetchImpl: async (_url, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response("[]", { status: 200 });
      },
    });
    api.setVaultKeyResolver((id) => (id === "v1" ? "S0VZ" : null));
    await api.listVaultKeyRequests("v1");
    await api.listVaultKeyRequests("v2");
    expect(seen[0][VAULT_KEY_HEADER]).toBe("S0VZ");
    expect(seen[1][VAULT_KEY_HEADER]).toBeUndefined();
  });
});
