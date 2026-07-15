// The ONE typed HTTP boundary to the Baalda server. Every `fetch`
// to the server lives here — auth, organizations, registry, shares, sync-token.
// Components and managers call these methods; they never call `fetch` directly.
// (Tauri `invoke` lives in `ipc.ts`; these two are the only I/O boundaries.)
//
// Auth: Better Auth issues an opaque session token via the `set-auth-token`
// response header on sign-in/up (bearer plugin). We capture it, then send it as
// `Authorization: Bearer <token>` on every authenticated call. The token is
// persisted in the OS keychain by the auth manager — never here.

export const DEFAULT_SERVER_URL = "http://localhost:3010";

// ---- Types (mirror the server's JSON) -------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  image?: string | null;
}

export interface SessionInfo {
  user: AuthUser;
  activeOrganizationId: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
}

export interface Member {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt?: string;
  user?: { id: string; email: string; name: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  inviterId?: string;
  expiresAt?: string;
}

export interface Vault {
  id: string;
  organizationId?: string;
  organization_id?: string;
  name: string;
}

export interface RegisteredNote {
  id: string;
  docId?: string;
  doc_id?: string;
  vaultId?: string;
  vault_id?: string;
  folderId?: string | null;
  folder_id?: string | null;
  title: string | null;
  relPath?: string;
  rel_path?: string;
}

export interface RegisteredFolder {
  id: string;
  vaultId?: string;
  vault_id?: string;
  parentId?: string | null;
  parent_id?: string | null;
  name: string;
  path: string;
}

export interface Share {
  id: string;
  resourceType?: "folder" | "file";
  resource_type?: "folder" | "file";
  resourceId?: string;
  resource_id?: string;
  principalType?: "user" | "org";
  principal_type?: "user" | "org";
  principalId?: string;
  principal_id?: string;
  permission: "view" | "edit" | "locked";
  createdBy?: string;
  created_by?: string;
}

export type Permission = "view" | "edit";

/** An MCP access token (metadata only; the plaintext is shown once at creation). */
export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Attachment blob metadata returned by the server (camelCase). */
export interface BlobMeta {
  id: string;
  sha256: string;
  size: number;
  mime: string | null;
  relPath: string | null;
  filename?: string | null;
  /** True when the upload deduped to an existing row (server-set). */
  deduped?: boolean;
}

export interface SyncTokenResponse {
  token: string;
  docId: string;
  vaultId: string;
  readOnly: boolean;
  permission: Permission;
}

/** Vault-scoped token for the background replication channel (spec 05 §7). */
export interface VaultSyncTokenResponse {
  token: string;
  vaultId: string;
}

/** A rejected server response — carries the HTTP status for callers to branch on. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string | null;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Stateful client: holds the base URL + bearer token in memory. The auth
 * manager owns persistence (keychain) and calls `setToken`.
 */
export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_SERVER_URL);
    this.token = opts.token ?? null;
    // Bind so a destructured fetch keeps its `this` (window/globalThis).
    const f = opts.fetchImpl ?? fetch;
    this.fetchImpl = f === fetch ? f.bind(globalThis) : f;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
  setBaseUrl(url: string): void {
    this.baseUrl = stripTrailingSlash(url);
  }
  getToken(): string | null {
    return this.token;
  }
  setToken(token: string | null): void {
    this.token = token;
  }

  // ---- low-level request --------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; captureAuthToken?: boolean; query?: Record<string, string | undefined> } = {},
  ): Promise<{ data: T; authToken: string | null }> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    // Better Auth requires an Origin (CSRF). In the Tauri webview the browser
    // sets the real webview origin (the server trusts it via trustedOrigins);
    // in Node (tests) fetch sends none, so we supply the server's own origin,
    // which Better Auth trusts by default. Browsers ignore this forbidden header.
    try {
      headers.Origin = new URL(this.baseUrl).origin;
    } catch {
      /* leave unset */
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let bodyInit: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body: bodyInit });

    // Better Auth returns the opaque session token in this header on sign-in/up.
    const authToken = opts.captureAuthToken ? res.headers.get("set-auth-token") : null;

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message?: unknown }).message)
          : undefined) ??
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : undefined) ??
        `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, parsed);
    }

    return { data: parsed as T, authToken };
  }

  // ---- Auth (Better Auth) -------------------------------------------------

  /** Sign up with email+password. Returns the session token to persist. */
  async signUp(input: { email: string; password: string; name: string }): Promise<{
    user: AuthUser;
    token: string | null;
  }> {
    const { data, authToken } = await this.request<{ user: AuthUser; token?: string }>(
      "POST",
      "/api/auth/sign-up/email",
      { body: input, captureAuthToken: true },
    );
    const token = authToken ?? data.token ?? null;
    if (token) this.token = token;
    return { user: data.user, token };
  }

  /** Sign in with email+password. Returns the session token to persist. */
  async signIn(input: { email: string; password: string }): Promise<{
    user: AuthUser;
    token: string | null;
  }> {
    const { data, authToken } = await this.request<{ user: AuthUser; token?: string }>(
      "POST",
      "/api/auth/sign-in/email",
      { body: input, captureAuthToken: true },
    );
    const token = authToken ?? data.token ?? null;
    if (token) this.token = token;
    return { user: data.user, token };
  }

  async signOut(): Promise<void> {
    try {
      await this.request<unknown>("POST", "/api/auth/sign-out", { body: {} });
    } finally {
      this.token = null;
    }
  }

  // ---- Google sign-in (social, via desktop loopback) ----------------------

  /** Which sign-in methods the server offers (Google is config-gated). */
  async getAuthMethods(): Promise<{ emailPassword: boolean; google: boolean }> {
    try {
      const { data } = await this.request<{ emailPassword: boolean; google: boolean }>(
        "GET",
        "/api/auth-methods",
      );
      return { emailPassword: data.emailPassword !== false, google: !!data.google };
    } catch {
      // Older server without the endpoint: assume email/password only.
      return { emailPassword: true, google: false };
    }
  }

  /**
   * Kick off a social sign-in and get the provider's authorization URL to open
   * in the system browser. `callbackURL` is where the server bounces the browser
   * after the OAuth callback (our /api/desktop-auth/finish handoff).
   */
  async socialSignInUrl(provider: "google", callbackURL: string): Promise<string> {
    const { data } = await this.request<{ url?: string; redirect?: boolean }>(
      "POST",
      "/api/auth/sign-in/social",
      { body: { provider, callbackURL } },
    );
    if (!data?.url) {
      throw new ApiError(500, "Server did not return an authorization URL");
    }
    return data.url;
  }

  /** Redeem the one-time handoff code for the session token + user. */
  async exchangeDesktopCode(code: string): Promise<{ user: AuthUser; token: string }> {
    const { data } = await this.request<{ token: string; user: AuthUser }>(
      "POST",
      "/api/desktop-auth/exchange",
      { body: { code } },
    );
    if (data.token) this.token = data.token;
    return { user: data.user, token: data.token };
  }

  /** Current session, or null if the token is missing/expired/revoked. */
  async getSession(): Promise<SessionInfo | null> {
    if (!this.token) return null;
    try {
      const { data } = await this.request<{
        user: AuthUser;
        session: { activeOrganizationId?: string | null };
      } | null>("GET", "/api/auth/get-session");
      if (!data || !data.user) return null;
      return {
        user: data.user,
        activeOrganizationId: data.session?.activeOrganizationId ?? null,
      };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
  }

  // ---- Organizations (org plugin) -----------------------------------------

  async createOrganization(input: { name: string; slug: string }): Promise<Organization> {
    const { data } = await this.request<Organization>("POST", "/api/auth/organization/create", {
      body: input,
    });
    return data;
  }

  async listOrganizations(): Promise<Organization[]> {
    const { data } = await this.request<Organization[]>("GET", "/api/auth/organization/list");
    return data ?? [];
  }

  async setActiveOrganization(organizationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/set-active", {
      body: { organizationId },
    });
  }

  async listMembers(organizationId?: string): Promise<Member[]> {
    const { data } = await this.request<{ members: Member[] } | Member[]>(
      "GET",
      "/api/auth/organization/list-members",
      { query: organizationId ? { organizationId } : undefined },
    );
    return Array.isArray(data) ? data : (data?.members ?? []);
  }

  async inviteMember(input: {
    email: string;
    role: "member" | "admin" | "owner";
    organizationId?: string;
  }): Promise<Invitation> {
    const { data } = await this.request<Invitation>(
      "POST",
      "/api/auth/organization/invite-member",
      { body: input },
    );
    return data;
  }

  /** Invitations pending on the ACTIVE organization (admin view). */
  async listInvitations(organizationId?: string): Promise<Invitation[]> {
    const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
      "GET",
      "/api/auth/organization/list-invitations",
      { query: organizationId ? { organizationId } : undefined },
    );
    return Array.isArray(data) ? data : (data?.invitations ?? []);
  }

  /** Invitations addressed to the signed-in user (invitee view). */
  async listUserInvitations(): Promise<Invitation[]> {
    const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
      "GET",
      "/api/auth/organization/list-user-invitations",
    );
    return Array.isArray(data) ? data : (data?.invitations ?? []);
  }

  async acceptInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/accept-invitation", {
      body: { invitationId },
    });
  }

  async rejectInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/reject-invitation", {
      body: { invitationId },
    });
  }

  // ---- Join codes -----------------------------------------------------------

  /** The active workspace's shareable join code (owner/admin; lazily created). */
  async getJoinCode(): Promise<string> {
    const { data } = await this.request<{ code: string }>("GET", "/api/orgs/join-code");
    return data.code;
  }

  /** Join a workspace by its shared code (any signed-in user). */
  async joinWorkspace(code: string): Promise<{
    organizationId: string;
    name?: string;
    alreadyMember?: boolean;
  }> {
    const { data } = await this.request<{
      organizationId: string;
      name?: string;
      alreadyMember?: boolean;
    }>("POST", "/api/orgs/join", { body: { code } });
    return data;
  }

  /**
   * Permanently delete a workspace and all its server data (owner only). The
   * server cascades members/vaults/folders/notes/shares and purges the FK-less
   * CRDT stores. Throws ApiError 403 if the caller isn't the owner.
   */
  async deleteWorkspace(
    organizationId: string,
  ): Promise<{ deleted: boolean; vaults: number; docs: number }> {
    const { data } = await this.request<{ deleted: boolean; vaults: number; docs: number }>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(organizationId)}`,
    );
    return data;
  }

  // ---- MCP tokens ---------------------------------------------------------

  /** The MCP endpoint URL for this server (what an AI client connects to). */
  mcpUrl(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  /** The caller's MCP tokens for the active workspace (metadata only). */
  async listMcpTokens(): Promise<McpTokenRow[]> {
    const { data } = await this.request<{ tokens: McpTokenRow[] }>(
      "GET",
      "/api/mcp/tokens",
    );
    return data.tokens ?? [];
  }

  /** Mint a new MCP token. The `token` field is the plaintext — shown once. */
  async createMcpToken(name: string): Promise<McpTokenRow & { token: string }> {
    const { data } = await this.request<McpTokenRow & { token: string }>(
      "POST",
      "/api/mcp/tokens",
      { body: { name } },
    );
    return data;
  }

  async revokeMcpToken(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/mcp/tokens/${encodeURIComponent(id)}`);
  }

  // ---- Registry -----------------------------------------------------------

  async listVaults(): Promise<Vault[]> {
    const { data } = await this.request<{ vaults: Vault[] }>("GET", "/api/vaults");
    return data.vaults ?? [];
  }

  async createVault(input: { name: string; organizationId?: string }): Promise<Vault> {
    const { data } = await this.request<Vault>("POST", "/api/vaults", { body: input });
    return data;
  }

  async listFolders(vaultId: string): Promise<RegisteredFolder[]> {
    const { data } = await this.request<{ folders: RegisteredFolder[] }>("GET", "/api/folders", {
      query: { vaultId },
    });
    return data.folders ?? [];
  }

  async createFolder(input: {
    vaultId: string;
    name: string;
    path: string;
    parentId?: string | null;
  }): Promise<RegisteredFolder> {
    const { data } = await this.request<RegisteredFolder>("POST", "/api/folders", { body: input });
    return data;
  }

  async listNotes(vaultId: string): Promise<RegisteredNote[]> {
    const { data } = await this.request<{ notes: RegisteredNote[] }>("GET", "/api/notes", {
      query: { vaultId },
    });
    return data.notes ?? [];
  }

  async createNote(input: {
    vaultId: string;
    relPath: string;
    title?: string | null;
    folderId?: string | null;
    docId?: string;
  }): Promise<RegisteredNote> {
    const { data } = await this.request<RegisteredNote>("POST", "/api/notes", { body: input });
    return data;
  }

  // ---- Shares -------------------------------------------------------------

  async listShares(resourceType: "folder" | "file", resourceId: string): Promise<Share[]> {
    const { data } = await this.request<{ shares: Share[] }>("GET", "/api/shares", {
      query: { resourceType, resourceId },
    });
    return data.shares ?? [];
  }

  async createShare(input: {
    resourceType: "folder" | "file";
    resourceId: string;
    /** Required for user shares; ignored for org-wide locks. */
    principalId?: string;
    principalType?: "user" | "org";
    permission: Permission | "locked";
  }): Promise<Share> {
    const { data } = await this.request<Share>("POST", "/api/shares", { body: input });
    return data;
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/shares/${encodeURIComponent(shareId)}`);
  }

  /** All locks in a vault (readable by any workspace member — drives lock badges). */
  async listVaultLocks(vaultId: string): Promise<Share[]> {
    const { data } = await this.request<{ locks: Share[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/locks`,
    );
    return data.locks ?? [];
  }

  // ---- Sync token ---------------------------------------------------------

  /** Mint a per-doc sync JWT. Throws ApiError(403) when the user has no access. */
  async syncToken(docId: string): Promise<SyncTokenResponse> {
    const { data } = await this.request<SyncTokenResponse>("POST", "/api/sync-token", {
      body: { docId },
    });
    return data;
  }

  /** Mint a vault-scoped token for the background replication channel (spec 05).
   *  Throws ApiError(403) when the user isn't a member of the vault's workspace. */
  async vaultSyncToken(vaultId: string): Promise<VaultSyncTokenResponse> {
    const { data } = await this.request<VaultSyncTokenResponse>(
      "POST",
      "/api/vault-sync-token",
      { body: { vaultId } },
    );
    return data;
  }

  // ---- Attachment blobs (Phase 3 blob store, spec 02 §2/§5A) --------------

  /** Common headers (Origin + bearer) shared by the binary blob endpoints. */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    try {
      headers.Origin = new URL(this.baseUrl).origin;
    } catch {
      /* leave unset */
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** List attachment metadata for a vault. */
  async listVaultBlobs(vaultId: string): Promise<BlobMeta[]> {
    const { data } = await this.request<{ blobs: BlobMeta[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/blobs`,
    );
    return data.blobs ?? [];
  }

  /** Upload raw bytes as a vault attachment; server dedupes by sha256. */
  async uploadBlob(input: {
    vaultId: string;
    relPath: string;
    bytes: Uint8Array;
    mime?: string;
    fileName?: string;
  }): Promise<BlobMeta> {
    const headers = this.baseHeaders();
    headers["Content-Type"] = input.mime ?? "application/octet-stream";
    headers["x-rel-path"] = input.relPath;
    if (input.fileName) headers["x-file-name"] = input.fileName;

    // Copy into a fresh ArrayBuffer so the fetch body is a clean BodyInit.
    const buf = input.bytes.slice().buffer;
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/vaults/${encodeURIComponent(input.vaultId)}/blobs`,
      { method: "POST", headers, body: buf },
    );
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, parsed);
    }
    return parsed as unknown as BlobMeta;
  }

  /** Download an attachment's bytes by blob id. */
  async downloadBlob(id: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/blobs/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: this.baseHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Normalize snake/camel doc-id/vault-id fields the server may return. */
export function noteDocId(n: RegisteredNote): string {
  return n.docId ?? n.doc_id ?? n.id;
}
export function noteVaultId(n: RegisteredNote): string | undefined {
  return n.vaultId ?? n.vault_id;
}
export function noteRelPath(n: RegisteredNote): string | undefined {
  return n.relPath ?? n.rel_path;
}
export function vaultOrgId(v: Vault): string | undefined {
  return v.organizationId ?? v.organization_id;
}
export function sharePrincipalId(s: Share): string {
  return s.principalId ?? s.principal_id ?? "";
}
export function sharePrincipalType(s: Share): "user" | "org" {
  return s.principalType ?? s.principal_type ?? "user";
}
export function shareResourceType(s: Share): "folder" | "file" {
  return s.resourceType ?? s.resource_type ?? "file";
}
export function shareResourceId(s: Share): string {
  return s.resourceId ?? s.resource_id ?? "";
}
