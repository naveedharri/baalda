import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, VAULT_KEY_HEADER, vaultIdFromPath } from "../api";
import { decideSeed } from "../sync/startup";

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

describe("409 key_required", () => {
  function client(answers: Response[]) {
    const calls: Record<string, string>[] = [];
    const api = new ApiClient({
      baseUrl: "http://s",
      token: "t",
      fetchImpl: async (_url, init) => {
        calls.push((init?.headers ?? {}) as Record<string, string>);
        return answers.shift()!;
      },
    });
    return { api, calls };
  }
  const keyRequired = () =>
    new Response(JSON.stringify({ code: "key_required", message: "key required" }), { status: 409 });

  it("ensures the key and retries exactly once", async () => {
    const { api, calls } = client([keyRequired(), new Response("[]", { status: 200 })]);
    let key: string | null = null;
    api.setVaultKeyResolver(() => key);
    api.setKeyRequiredHandler(async () => {
      key = "S0VZ";
      return true;
    });
    expect(await api.listVaultKeyRequests("v1")).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1][VAULT_KEY_HEADER]).toBe("S0VZ");
  });

  it("stays an error (never an empty server) when the key cannot be had", async () => {
    const { api, calls } = client([keyRequired(), keyRequired()]);
    api.setKeyRequiredHandler(async () => true);
    const err = await api.listVaultKeyRequests("v1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(calls).toHaveLength(2); // one retry, no loop
    // The refusal never completes the server sync, so nothing seeds and the
    // local file/CRDT stay untouched (split-brain rule).
    expect(decideSeed({ signedIn: true, serverSynced: false, docEmpty: true, fileHasContent: true }).action).toBe(
      "wait-for-server",
    );
  });
});

describe("vault-scoped calls whose path does not name the vault", () => {
  it("MCP token mint and public links carry the open vault's key", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const api = new ApiClient({
      baseUrl: "http://s",
      token: "t",
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify({ id: "x", token: "mcp_1", link: null }), { status: 200 });
      },
    });
    api.setVaultKeyResolver((id) => (id === "v1" ? "S0VZ" : null));
    await api.createMcpToken("n", "v1");
    await api.createPublicLink("d1", "v1");
    await api.getPublicLink("d1", "v1");
    await api.createMcpToken("n"); // no vault: no key
    expect(seen.slice(0, 3).map((s) => s.headers[VAULT_KEY_HEADER])).toEqual(["S0VZ", "S0VZ", "S0VZ"]);
    expect(seen[3].headers[VAULT_KEY_HEADER]).toBeUndefined();
  });
});
