// The ONE typed HTTP boundary to the Baalda server. Every `fetch`
// to the server lives here — auth, organizations, registry, shares, sync-token.
// Components and managers call these methods; they never call `fetch` directly.
// (Tauri `invoke` lives in `ipc.ts`; these two are the only I/O boundaries.)
//
// Auth: Better Auth issues an opaque session token via the `set-auth-token`
// response header on sign-in/up (bearer plugin). We capture it, then send it as
// `Authorization: Bearer <token>` on every authenticated call. The token is
// persisted in the OS keychain by the auth manager — never here.

// ⚠️ Every call below is a WEBVIEW `fetch`, not Rust — we deliberately do not use
// tauri-plugin-http. So the `connect-src` in tauri.conf.json's CSP has to permit
// whatever server URL the user configures, or WebKit blocks the request before it
// leaves the app and reports only `TypeError: Load failed` (no CORS hint, nothing
// in the network tab). It bit us once: a CSP of `connect-src 'self' ipc: …` broke
// ALL remote traffic in packaged builds while dev kept working, which surfaced as
// a missing "Continue with Google" button (the capability probe below fails
// closed) plus "Load failed" on sign-in. Since self-hosting means the server URL
// is not knowable at build time, connect-src allows `https:`/`wss:` broadly;
// `script-src 'self'` stays the actual XSS boundary.
// The server a build points at before the user picks one in Settings. Dev talks
// to the local stack; a RELEASE build has to default to a server that actually
// exists for the person who just installed it — defaulting release builds to
// localhost:3010 meant a fresh install could only ever report "Load failed"
// until the user found Server settings on their own. Self-hosters override it
// there; nothing here is pinned at build time beyond this default.
/** The managed instance. Named so the dev guard below can recognise it. */
export const PRODUCTION_SERVER_URL = "https://api.baalda.com";
export const LOCAL_SERVER_URL = "http://localhost:3010";

/** Explicit opt-out of everything below: `VITE_SERVER_URL=… pnpm dev:desktop`. */
const ENV_SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() || null;

export const DEFAULT_SERVER_URL =
  ENV_SERVER_URL ?? (import.meta.env.DEV ? LOCAL_SERVER_URL : PRODUCTION_SERVER_URL);

/**
 * The server to actually talk to, given whatever URL was persisted in the app
 * config (Settings → Connection writes it, and it survives across launches).
 *
 * A dev build IGNORES a persisted production URL. That combination is not a
 * preference, it's an accident with real consequences: `pnpm dev:desktop`
 * pointed at the managed instance reads and WRITES real users' vaults, and
 * because the URL is persisted per-device it silently stays that way across
 * every later launch — you only notice when local changes fail to appear in
 * a local Postgres that was never being used.
 *
 * Any OTHER persisted URL is honoured, so switching a dev build to a staging or
 * LAN server from Settings still works; only "dev build → production" is
 * refused, and `VITE_SERVER_URL=https://api.baalda.com` re-enables even that.
 */
export function resolveServerUrl(persisted: string | null | undefined): string {
  const clean = stripTrailingSlash((persisted ?? "").trim());
  if (!clean) return DEFAULT_SERVER_URL;
  if (import.meta.env.DEV && !ENV_SERVER_URL && clean === PRODUCTION_SERVER_URL) {
    return DEFAULT_SERVER_URL;
  }
  return clean;
}

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
  /** Present on our own `/api/invitations/*` routes, absent on Better Auth's —
   *  which is why every consumer treats both as optional and falls back. */
  organizationName?: string;
  inviterName?: string;
}

/**
 * What an invitation id resolves to for someone who is not (yet) signed in as
 * the invitee — the public shoulder-tap an invite deep link lands on.
 *
 * Public because the id IS the capability: an unguessable UUID that only ever
 * reaches the invitee's inbox. It carries the vault name and who invited them
 * so the sign-in card can say what the person is joining instead of asking for
 * a password against an unexplained modal.
 */
export interface InvitationPreview {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  organizationId: string;
  organizationName: string;
  inviterName: string | null;
  expiresAt?: string;
}

/**
 * Which sign-in routes the server actually offers. Every field is a capability,
 * so every field fails CLOSED — see {@link ApiClient.getAuthMethods}.
 */
export interface AuthMethods {
  emailPassword: boolean;
  google: boolean;
  /** Server can send a "choose a new password" email. */
  passwordReset: boolean;
  /** Server delivers invitations by email (otherwise the admin shares a link). */
  invitationEmail: boolean;
}

export interface Vault {
  id: string;
  organizationId?: string;
  organization_id?: string;
  name: string;
  /** True when nothing new may be created at the vault root (see the General
   *  settings toggle). Absent on an older server — treat that as false. */
  rootFrozen?: boolean;
  root_frozen?: boolean;
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
  /** Who last *edited* the note's content (never a rename/move), server-stamped
   *  from the authenticated editor — a teammate or an AI over MCP. Null until
   *  the note has been edited at least once since versioning shipped. */
  lastEditedBy?: string | null;
  last_edited_by?: string | null;
  lastEditedByName?: string | null;
  last_edited_by_name?: string | null;
  lastEditedAt?: string | null;
  last_edited_at?: string | null;
  /** Palette id (see `lib/appearance`), shared by the whole team. */
  color?: string | null;
}

/** The normalized "last edited by" fact for one note (see {@link noteLastEdited}). */
export interface NoteLastEdited {
  userId: string | null;
  name: string | null;
  /** ISO timestamp from the server. */
  at: string;
}

/** Flat structure listing that powers the Access panel (see `listAccessTree`). */
export interface AccessTreeResponse {
  folders: Array<{ id: string; path: string; color: string | null }>;
  notes: Array<{ id: string; relPath: string }>;
}

export interface RegisteredFolder {
  id: string;
  vaultId?: string;
  vault_id?: string;
  parentId?: string | null;
  parent_id?: string | null;
  name: string;
  path: string;
  /** Palette id (see `lib/appearance`), shared by the whole team. */
  color?: string | null;
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
  permission: "view" | "edit" | "locked" | "denied";
  createdBy?: string;
  created_by?: string;
}

export type Permission = "view" | "edit";

/** One member's effective access to a resource, as resolved server-side. */
export interface ResolvedMemberAccess {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  permission: "edit" | "view" | "none";
  /** True when a lock reduced an otherwise-`edit` member down to `view`. */
  capped: boolean;
  /** True when the `none` is an explicit per-member block, not a missing grant. */
  denied?: boolean;
}

export interface AccessResolution {
  members: ResolvedMemberAccess[];
}

/** An MCP access token (metadata only; the plaintext is shown once at creation). */
/** A note's public browser link (server-rendered read-only page). */
export interface PublicLink {
  id: string;
  docId: string;
  /** The full shareable url — built by the server, so it names the right origin. */
  url: string;
  createdAt: string;
}

export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Tool calls made with this connection so far. */
  useCount: number;
  /** The client on the other end (its User-Agent), if it has ever connected. */
  lastClient: string | null;
}

/** One MCP tool a connection can reach, classified for a compact access badge. */
export interface McpToolInfo {
  name: string;
  description: string;
  access: "read" | "write" | "destructive";
}

/** The MCP connections view for a vault: each token plus the shared tool catalog. */
export interface McpConnections {
  tokens: McpTokenRow[];
  tools: McpToolInfo[];
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

// ---- Versioning (per-note history + vault checkpoints) --------------------

/**
 * One stored state of a note. Content is deliberately absent — the list is
 * fetched constantly (every panel open) and a version is the full markdown, so
 * the body only travels when someone actually previews or reverts
 * ({@link NoteVersionDetail}).
 *
 * `id` is a JS number (the server narrows its BIGSERIAL), `size` is bytes.
 */
export interface NoteVersion {
  id: number;
  createdAt: string;
  /** `idle` = captured at the end of an edit session; `pre-revert` = the state
   *  that was replaced, captured so a revert is itself undoable. */
  cause: "idle" | "pre-revert";
  authorId: string | null;
  authorName: string | null;
  sha256: string;
  size: number;
}

export interface NoteVersionDetail extends NoteVersion {
  content: string;
}

/** A vault-wide snapshot (structure + content of every note at one moment). */
export interface VaultCheckpoint {
  id: string;
  kind: "auto" | "manual";
  label: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
  noteCount: number;
}

/** What a whole-vault revert did. Attachments/blobs are never touched. */
export interface VaultRevertResult {
  ok: true;
  docsChanged: number;
  docsRestored: number;
  docsDeleted: number;
  foldersCreated: number;
  /** Notes kept as-is because the snapshot was empty while the live note had
   *  text — the revert's data-loss firewall refusing to bulldoze content. */
  docsKeptOverEmpty?: number;
  /** The auto checkpoint taken just before the revert — this is the undo. */
  preRevertCheckpointId: string;
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

// ---- Billing (subscription) ----------------------------------------------

/** One purchasable plan variant (e.g. Pro monthly / yearly). Amount is in the
 *  currency's minor units (cents). */
export interface BillingPlan {
  id: string;
  label: string;
  amount: number;
  currency: string;
  interval: "month" | "year";
}

/** Server-wide billing capability (public; no auth). `enabled: false` means the
 *  server has no billing configured — a self-host runs with unlimited limits. */
export interface BillingConfig {
  enabled: boolean;
  plans?: BillingPlan[];
  freeLimits?: { vaultsPerUser: number; membersPerVault: number };
}

/** A single vault's subscription state + seat usage. */
export interface OrgBilling {
  plan: "free" | "pro";
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Cadence + price of the live subscription, straight from the provider's
   *  snapshot — so a row can be priced without matching it back to a
   *  `BillingPlan`. All three are null on a vault with no subscription
   *  (#109). `amount` is minor units, like {@link BillingPlan.amount}. */
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
  /** `limit: null` = unlimited (paid). */
  seats: { members: number; pendingInvitations: number; limit: number | null };
}

/** One row of the Subscriptions list: a vault the caller belongs to. */
export interface MyBillingVault {
  orgId: string;
  name: string;
  role: "owner" | "admin" | "member";
  plan: "free" | "pro";
  status: "none" | "active" | "past_due" | "canceled";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
  seats: { members: number; pendingInvitations: number; limit: number | null };
  /** The vault's owner — who to point a member at when they can't act. */
  billingOwner: { userId: string; name: string; email: string } | null;
  /** Owner or admin: may upgrade this vault or open its portal. */
  canManage: boolean;
  /** Owner AND the subscription is live: may move it to another vault. */
  canTransfer: boolean;
}

/**
 * A subscription whose vault is gone. Deleting a vault cancels its
 * subscription at the period end rather than instantly, so the paid time the
 * user already bought survives the vault — and has to be reachable from
 * somewhere (#109/#111). The server keeps the row as a tombstone; this is it.
 */
export interface OrphanedSubscription {
  orgId: string;
  orgName: string | null;
  deletedAt: string;
  status: "active" | "past_due";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  interval: "month" | "year" | null;
  amount: number | null;
  currency: string | null;
}

/**
 * Every subscription the caller can see or act on, in one shot. The per-vault
 * `GET /api/billing/orgs/:orgId` can't answer this: role is only known for the
 * active org and plan is only known one org at a time.
 */
export interface MyBilling {
  vaults: MyBillingVault[];
  orphaned: OrphanedSubscription[];
  freeLimits: {
    vaultsPerUser: number;
    membersPerVault: number;
    /** Owned vaults with no subscription — what counts against the cap. */
    freeVaultsUsed: number;
  };
}

/** What `DELETE /api/orgs/:orgId` reports back. */
export interface VaultDeleteResult {
  deleted: boolean;
  vaults: number;
  docs: number;
  /** Set when the deleted vault carried a live subscription: the server told
   *  the provider to stop at the period end, and this is when that is. */
  subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
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

/**
 * A server address didn't check out. Thrown by {@link ApiClient.health}, which
 * is the one probe in this file that must NOT fail closed.
 *
 * The two kinds are worth telling apart because they send the user to different
 * places: `unreachable` means look at the URL, the DNS and whether the box is
 * up; `not-baalda` means the address is fine and something else is answering on
 * it (a proxy's default page, a different app, the wrong port).
 */
export class ServerCheckError extends Error {
  constructor(
    public kind: "unreachable" | "not-baalda",
    message: string,
  ) {
    super(message);
    this.name = "ServerCheckError";
  }
}

/** How long a server gets to answer `/health` before we call it unreachable. */
export const HEALTH_TIMEOUT_MS = 6000;

// The two things a person can actually act on. Kept as constants so the dialog
// and Settings → Connection say the same words for the same failure.
const UNREACHABLE_MESSAGE =
  "Couldn't reach that server. Check the URL and that it's online.";
const NOT_BAALDA_MESSAGE = "That address answered, but it isn't a Baalda server.";

type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string | null;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Override the generated client instance id (tests). See `getClientId`. */
  clientId?: string;
}

/** Header carrying `ApiClient.getClientId()`; mirrors the server's ORIGIN_HEADER. */
export const ORIGIN_HEADER = "x-baalda-origin";

/** A random opaque id for one app instance. */
function newClientId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}

/**
 * Stateful client: holds the base URL + bearer token in memory. The auth
 * manager owns persistence (keychain) and calls `setToken`.
 */
export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly clientId: string;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_SERVER_URL);
    this.token = opts.token ?? null;
    // Bind so a destructured fetch keeps its `this` (window/globalThis).
    const f = opts.fetchImpl ?? fetch;
    this.fetchImpl = f === fetch ? f.bind(globalThis) : f;
    this.clientId = opts.clientId ?? newClientId();
  }

  /**
   * This app instance's opaque id. Sent on every HTTP call as `x-baalda-origin`
   * and in the vault channel's `hello`, so the server can tell "this structural
   * change came from the client I'm about to notify" and skip the round trip —
   * a reconcile no longer makes the server tell its author to re-pull its own
   * writes (one full ACL recompute per notification). Stable for the process,
   * meaningless across restarts, and never used for authorization.
   */
  getClientId(): string {
    return this.clientId;
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

    const headers: Record<string, string> = {
      Accept: "application/json",
      [ORIGIN_HEADER]: this.clientId,
    };
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

  // ---- Reachability -------------------------------------------------------

  /**
   * Is there a Baalda server at this address? Resolves if yes, throws a
   * {@link ServerCheckError} if no.
   *
   * The ONE probe in this file that fails OPEN, and it exists precisely because
   * the other two don't. `getAuthMethods` and `getBillingConfig` are capability
   * probes: they swallow every failure and answer "not configured", which is
   * right for deciding whether to draw a button and useless for telling someone
   * their server URL is wrong. Building the onboarding check on either of them
   * would report "connected" for a typo'd hostname.
   *
   * Takes an explicit `baseUrl` because it runs BEFORE the URL is adopted —
   * validating a candidate must not disturb the client's current base or its
   * token. It also sends no `Authorization`: `/health` is public, and the point
   * is to test the address, not the session.
   *
   * `AbortController` rather than a bare `fetch`: a host that accepts the TCP
   * connection and then says nothing (a firewall, a hung proxy) would otherwise
   * leave the Connect button spinning indefinitely.
   */
  async health(baseUrl?: string): Promise<void> {
    const base = stripTrailingSlash((baseUrl ?? this.baseUrl).trim());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/health`, {
        method: "GET",
        headers: { Accept: "application/json", [ORIGIN_HEADER]: this.clientId },
        signal: controller.signal,
      });
    } catch {
      // A timeout, DNS failure, refused connection and a CSP block all land
      // here, and the webview reports the last one as a bare `TypeError: Load
      // failed` — so the message stays about the address rather than guessing.
      throw new ServerCheckError("unreachable", UNREACHABLE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    // A 5xx is the server's own, or a proxy in front of it saying the app is
    // down — "check it's online" is the useful thing to say, not "wrong app".
    if (res.status >= 500) throw new ServerCheckError("unreachable", UNREACHABLE_MESSAGE);
    if (!res.ok) throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 200 with HTML: something is there, it just isn't us.
      throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
    }
    const ok =
      !!parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === true;
    if (!ok) throw new ServerCheckError("not-baalda", NOT_BAALDA_MESSAGE);
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

  /**
   * Update the signed-in user's profile. Better Auth stores `name` and `image`
   * (avatar URL) on the user, so these follow the account across devices and
   * every vault. Callers re-fetch the session afterward to pick up the
   * updated user object.
   */
  async updateUser(input: { name?: string; image?: string | null }): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/update-user", { body: input });
  }

  // ---- Google sign-in (social, via desktop loopback) ----------------------

  /**
   * Which sign-in methods the server offers (Google, password reset and invite
   * email are all config-gated).
   *
   * Every field beyond `emailPassword` is read with `!!`, so an OLDER server
   * that answers only `{ emailPassword, google }` reports the new capabilities
   * as absent — which is the right answer for it, and the reason the UI hides
   * "Forgot password?" rather than offering a route that silently does nothing.
   */
  async getAuthMethods(): Promise<AuthMethods> {
    try {
      const { data } = await this.request<Partial<AuthMethods>>("GET", "/api/auth-methods");
      return {
        emailPassword: data.emailPassword !== false,
        google: !!data.google,
        passwordReset: !!data.passwordReset,
        invitationEmail: !!data.invitationEmail,
      };
    } catch {
      // Fails CLOSED, and deliberately so: an older/self-hosted server without
      // this endpoint should hide the Google button rather than offer a route
      // that cannot work. Note the cost of that choice — a plain network failure
      // (server down, wrong URL, CSP blocking us) is indistinguishable here from
      // "Google not configured", so a hidden Google button is not proof the
      // server lacks it. Check /api/auth-methods with curl before believing it.
      return {
        emailPassword: true,
        google: false,
        passwordReset: false,
        invitationEmail: false,
      };
    }
  }

  /**
   * Ask the server to email a password-reset link — and learn what happened.
   *
   * Our own route, not Better Auth's `request-password-reset`: that one answers
   * the same neutral sentence whether the address is unknown, the send failed
   * or the mail went out. This one resolves only when the provider accepted the
   * message, and otherwise throws an `ApiError` whose body carries `error`:
   * `no_account` (404), `send_failed` (502), `too_many_requests` (429) or
   * `email_not_configured` (400). `lib/resetFlow.ts` turns those into copy.
   */
  async requestPasswordReset(email: string): Promise<void> {
    await this.request<unknown>("POST", "/api/password-reset/request", {
      body: { email },
    });
  }

  /**
   * Email an invitation's link to its address. Resolves when the provider took
   * the message; throws `ApiError` with body `error` = `send_failed` (502),
   * `email_not_configured` (400) or `invitation_not_pending` (410). Called
   * right after {@link inviteMember} — creating the invitation sends nothing by
   * itself, precisely so the admin can be told whether the email went out.
   */
  async sendInvitationEmail(invitationId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/api/invitations/${encodeURIComponent(invitationId)}/send`,
    );
  }

  /** Re-send the sign-up confirmation email for the signed-in address. */
  async sendVerificationEmail(email: string): Promise<void> {
    // The server builds its own link and ignores callbackURL, but Better Auth's
    // schema requires the field.
    await this.request<unknown>("POST", "/api/auth/send-verification-email", {
      body: { email, callbackURL: "/email-verified" },
    });
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
      // Better Auth signals "no active session" with a literal `null` body — the
      // only response that should drop the stored token. A well-formed session
      // has a `user`. Anything else (an empty body, a proxy's HTML error page
      // that happened to return 200, an API contract drift) is NOT a trustworthy
      // "signed out" signal: throwing keeps the token so the caller can retry,
      // instead of logging the user out over a transient hiccup.
      if (data == null) return null;
      if (typeof data === "object" && (data as { user?: unknown }).user) {
        return {
          user: data.user,
          activeOrganizationId: data.session?.activeOrganizationId ?? null,
        };
      }
      throw new ApiError(0, "Unexpected get-session response shape");
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
    // Dedupe by id: a user can transiently hold more than one membership row for
    // the same org (invite + join code both add a member), which would otherwise
    // show the same vault twice in the switcher. See issue #14.
    const byId = new Map<string, Organization>();
    for (const org of data ?? []) if (!byId.has(org.id)) byId.set(org.id, org);
    return [...byId.values()];
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

  /** Kill a pending invitation (owner/admin). The link stops working at once. */
  async cancelInvitation(invitationId: string): Promise<void> {
    await this.request<unknown>("POST", "/api/auth/organization/cancel-invitation", {
      body: { invitationId },
    });
  }

  /**
   * What an invitation id names — vault, inviter, invited address, status.
   *
   * Public on the server (the id is the capability), so this works signed out
   * and on whatever server the app is currently pointed at. A bearer header
   * still rides along when we have one; the route ignores it.
   *
   * Throws `ApiError` 404 for an id the server doesn't know, which is what the
   * caller maps to "expired or already used" — an unknown id and a consumed
   * one must stay indistinguishable.
   */
  async previewInvitation(invitationId: string): Promise<InvitationPreview> {
    const { data } = await this.request<InvitationPreview>(
      "GET",
      `/api/invitations/${encodeURIComponent(invitationId)}/preview`,
    );
    return data;
  }

  /**
   * Invitations addressed to the signed-in user (invitee view).
   *
   * Our own `/api/invitations/mine` FIRST, Better Auth's route only as a 404
   * fallback for an older self-hosted server. Better Auth's
   * `list-user-invitations` answers 403 for any user whose email isn't
   * verified — which is every password sign-up — so the in-app invite inbox was
   * silently empty for exactly the people who most needed it.
   */
  async listUserInvitations(): Promise<Invitation[]> {
    try {
      const { data } = await this.request<{ invitations: Invitation[] } | Invitation[]>(
        "GET",
        "/api/invitations/mine",
      );
      return Array.isArray(data) ? data : (data?.invitations ?? []);
    } catch (e) {
      // Only a missing ROUTE falls back. A 403/500 from our own endpoint is a
      // real failure and must not be papered over with a call that returns 403
      // for the same user anyway.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
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

  /** The active vault's shareable join code (owner/admin; lazily created). */
  async getJoinCode(): Promise<string> {
    const { data } = await this.request<{ code: string }>("GET", "/api/orgs/join-code");
    return data.code;
  }

  /** Join a vault by its shared code (any signed-in user). */
  async joinVault(code: string): Promise<{
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
   * Permanently delete a vault and all its server data (owner only). The server
   * cascades members/note-collections/folders/notes/shares and purges the FK-less
   * CRDT stores. Throws ApiError 403 if the caller isn't the owner.
   * (The vault's server identity is the Better Auth organization id.)
   *
   * A vault on Pro is cancelled at the provider FIRST, at the period end; if
   * the provider refuses, nothing is deleted and this throws 502
   * `subscription_cancel_failed` (#111). On success `subscription` says when
   * the paid period runs out — until then it can be moved to another vault.
   */
  async deleteRemoteVault(organizationId: string): Promise<VaultDeleteResult> {
    const { data } = await this.request<VaultDeleteResult>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(organizationId)}`,
    );
    return data;
  }

  /**
   * Remove a member from a vault (owner/admin). The server deletes the
   * membership, purges any shares granted directly to that user, and force-closes
   * their live sync sockets so access is revoked immediately. Throws ApiError 403
   * if the caller lacks permission (e.g. an admin trying to remove another admin).
   */
  async removeMember(organizationId: string, userId: string): Promise<void> {
    await this.request<{ removed: boolean }>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  /**
   * Change a member's role (owner/admin). Same authz shape as removeMember:
   * an admin may only change plain members; nobody touches the owner or
   * themselves. The server force-closes the member's live sync sockets so the
   * new role applies immediately, not at token expiry.
   */
  async updateMemberRole(
    organizationId: string,
    userId: string,
    role: "member" | "admin",
  ): Promise<void> {
    await this.request<{ updated: boolean }>(
      "PATCH",
      `/api/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { body: { role } },
    );
  }

  // ---- MCP tokens ---------------------------------------------------------

  /** The MCP endpoint URL for this server (what an AI client connects to). */
  mcpUrl(): string {
    return `${this.baseUrl}/api/mcp`;
  }

  /** The caller's MCP tokens for the active vault (metadata only). */
  async listMcpTokens(): Promise<McpTokenRow[]> {
    return (await this.listMcpConnections()).tokens;
  }

  /**
   * The caller's MCP connections for the active vault: each token (with live
   * usage/activity metadata) plus the shared tool catalog every one can reach.
   */
  async listMcpConnections(): Promise<McpConnections> {
    const { data } = await this.request<McpConnections>("GET", "/api/mcp/tokens");
    return { tokens: data.tokens ?? [], tools: data.tools ?? [] };
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

  // ---- Public links ---------------------------------------------------------

  /**
   * Create-or-get the note's public browser link (`https://<server>/p/<token>`).
   * Repeated calls return the SAME url until it's revoked; gated server-side
   * like share management (owner/admin or the note's creator).
   */
  async createPublicLink(docId: string): Promise<PublicLink> {
    const { data } = await this.request<PublicLink>(
      "POST",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
    return data;
  }

  /** The note's public link if one exists, else null. */
  async getPublicLink(docId: string): Promise<PublicLink | null> {
    const { data } = await this.request<{ link: PublicLink | null }>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
    return data.link ?? null;
  }

  /** Kill the note's public link — the old url 404s immediately. */
  async revokePublicLink(docId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/notes/${encodeURIComponent(docId)}/public-link`,
    );
  }

  // ---- Billing (subscription) ---------------------------------------------

  /**
   * Server billing capability. Public (no auth). Mirrors {@link getAuthMethods}'
   * capability-probe pattern: ANY failure (older/self-hosted server without the
   * endpoint, network error) is treated as "billing disabled" so the UI simply
   * hides all billing affordances and enforces no limits.
   */
  async getBillingConfig(): Promise<BillingConfig> {
    try {
      const { data } = await this.request<BillingConfig>("GET", "/api/billing/config");
      if (!data || data.enabled !== true) return { enabled: false };
      return { enabled: true, plans: data.plans, freeLimits: data.freeLimits };
    } catch {
      return { enabled: false };
    }
  }

  /** A vault's subscription state + seat usage (any member of the org). */
  async getOrgBilling(orgId: string): Promise<OrgBilling> {
    const { data } = await this.request<OrgBilling>(
      "GET",
      `/api/billing/orgs/${encodeURIComponent(orgId)}`,
    );
    return data;
  }

  /** Start a hosted checkout for the org; returns the URL to open (owner/admin). */
  async createBillingCheckout(
    orgId: string,
    interval: "month" | "year",
  ): Promise<{ url: string }> {
    const { data } = await this.request<{ url: string }>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/checkout`,
      { body: { interval } },
    );
    return data;
  }

  /** Get the customer portal URL to manage/cancel the subscription (owner/admin). */
  async getBillingPortalUrl(orgId: string): Promise<{ url: string }> {
    const { data } = await this.request<{ url: string }>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/portal`,
    );
    return data;
  }

  /**
   * Every vault the caller belongs to with its plan/seats/role, plus any
   * subscription left behind by a deleted vault. One request rather than an
   * N+1 over {@link getOrgBilling}: the server also reconciles stale rows
   * against the provider while it is in there.
   */
  async getMyBilling(): Promise<MyBilling> {
    const { data } = await this.request<MyBilling>("GET", "/api/billing/mine");
    return data;
  }

  /**
   * Cancel a vault's subscription (owner only; admins use the portal).
   * `period_end` keeps the paid time and stops the next charge; `now` revokes
   * immediately — which is what a subscription from an already-deleted vault
   * wants, since there is no vault left to spend the rest of the period on.
   */
  async cancelSubscription(
    orgId: string,
    mode: "period_end" | "now",
  ): Promise<OrgBilling> {
    const { data } = await this.request<OrgBilling>(
      "POST",
      `/api/billing/orgs/${encodeURIComponent(orgId)}/cancel`,
      { body: { mode } },
    );
    return data;
  }

  /**
   * Move a live subscription from one vault to another the caller owns. The
   * source may be a deleted vault's tombstone, which is the whole point: it
   * turns "I deleted the wrong vault" into a recoverable mistake instead of a
   * refund request. Un-cancels at the provider when the source was set to
   * cancel at the period end.
   */
  async transferSubscription(
    sourceOrgId: string,
    targetOrgId: string,
  ): Promise<{ transferred: boolean; orgId: string; billing: OrgBilling }> {
    const { data } = await this.request<{
      transferred: boolean;
      orgId: string;
      billing: OrgBilling;
    }>("POST", `/api/billing/orgs/${encodeURIComponent(sourceOrgId)}/transfer`, {
      body: { targetOrgId },
    });
    return data;
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

  /** Flip a vault-level latch (today: `rootFrozen`). Owner/admin only. */
  async updateVaultSettings(
    vaultId: string,
    input: { rootFrozen: boolean },
  ): Promise<{ id: string; name: string; rootFrozen: boolean }> {
    const { data } = await this.request<{ id: string; name: string; rootFrozen: boolean }>(
      "PATCH",
      `/api/vaults/${encodeURIComponent(vaultId)}`,
      { body: input },
    );
    return data;
  }

  /**
   * The vault's whole structure for the Access panel - ids and paths only, not
   * ACL-filtered. Owner/admin only (403 otherwise).
   *
   * Separate from {@link listFolders}/{@link listNotes} on purpose: those feed
   * the reconciler and MUST stay filtered, or the client would materialise notes
   * it has no right to sync. This one exists so an item you have made Private is
   * still administrable - it has left your disk, and the panel used to draw its
   * list from your disk.
   */
  async listAccessTree(vaultId: string): Promise<AccessTreeResponse> {
    const { data } = await this.request<AccessTreeResponse>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/access-tree`,
    );
    return { folders: data.folders ?? [], notes: data.notes ?? [] };
  }

  async listFolders(vaultId: string): Promise<RegisteredFolder[]> {
    const { data } = await this.request<{ folders: RegisteredFolder[] }>("GET", "/api/folders", {
      query: { vaultId },
    });
    return data.folders ?? [];
  }

  /**
   * The registry pull's view of a vault's folders: the folders the server will
   * show us, plus the folder ids it says are **deleted**.
   *
   * Same `null`-vs-`[]` contract as {@link listNoteRegistry}: `tombstones: null`
   * means the server did not answer (an older server), and the reconciler must
   * never remove or suppress a folder on the strength of "I don't know".
   */
  async listFolderRegistry(
    vaultId: string,
  ): Promise<{ folders: RegisteredFolder[]; tombstones: string[] | null }> {
    const { data } = await this.request<{
      folders: RegisteredFolder[];
      tombstones?: string[];
    }>("GET", "/api/folders", { query: { vaultId } });
    return {
      folders: data.folders ?? [],
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : null,
    };
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

  /** Rename/move a folder (rewrites descendant paths server-side; id stays). */
  async updateFolder(
    id: string,
    input: { name?: string; path?: string; parentId?: string | null; color?: string | null },
  ): Promise<RegisteredFolder> {
    const { data } = await this.request<RegisteredFolder>(
      "PATCH",
      `/api/folders/${encodeURIComponent(id)}`,
      { body: input },
    );
    return data;
  }

  /** Delete a folder subtree (soft-deletes its notes). */
  async deleteFolder(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/folders/${encodeURIComponent(id)}`);
  }

  async listNotes(vaultId: string): Promise<RegisteredNote[]> {
    const { data } = await this.request<{ notes: RegisteredNote[] }>("GET", "/api/notes", {
      query: { vaultId },
    });
    return data.notes ?? [];
  }

  /**
   * The registry pull's view of a vault: the notes the server will show us, plus
   * the doc_ids it says are **deleted**.
   *
   * `tombstones: null` means the server did not answer the question — an older
   * server, a proxy that dropped the field, a truncated body. It is NOT the same
   * as `[]` ("nothing is deleted"), and the reconciler must never infer a delete
   * from `null`, because the fallback for "I don't know" has to be "leave the
   * user's files alone".
   */
  async listNoteRegistry(
    vaultId: string,
  ): Promise<{ notes: RegisteredNote[]; tombstones: string[] | null }> {
    const { data } = await this.request<{ notes: RegisteredNote[]; tombstones?: string[] }>(
      "GET",
      "/api/notes",
      { query: { vaultId } },
    );
    return {
      notes: data.notes ?? [],
      tombstones: Array.isArray(data.tombstones) ? data.tombstones : null,
    };
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

  /** Rename/move a note (rel_path/folder/title); doc_id is unchanged. */
  async updateNote(
    id: string,
    input: {
      relPath?: string;
      title?: string | null;
      folderId?: string | null;
      color?: string | null;
    },
  ): Promise<RegisteredNote> {
    const { data } = await this.request<RegisteredNote>(
      "PATCH",
      `/api/notes/${encodeURIComponent(id)}`,
      { body: input },
    );
    return data;
  }

  /** Soft-delete a note (keeps its doc_id row; drops it from the registry list). */
  async deleteNote(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/notes/${encodeURIComponent(id)}`);
  }

  // ---- Versioning ---------------------------------------------------------

  /** A note's stored versions, newest first (no content). Needs `view`. */
  async listNoteVersions(docId: string): Promise<NoteVersion[]> {
    const { data } = await this.request<{ versions: NoteVersion[] }>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/versions`,
    );
    return data.versions ?? [];
  }

  /** One version *with* its markdown — the preview/revert payload. */
  async getNoteVersion(docId: string, versionId: number): Promise<NoteVersionDetail> {
    const { data } = await this.request<NoteVersionDetail>(
      "GET",
      `/api/notes/${encodeURIComponent(docId)}/versions/${encodeURIComponent(String(versionId))}`,
    );
    return data;
  }

  /**
   * Restore a version as a forward CRDT edit (never a backwards state merge, which
   * would resurrect deleted text). The server captures the pre-revert state first
   * unless the live text already matches the newest stored version — that's when
   * `preRevertVersionId` comes back null. Needs `edit`; a locked share 403s.
   */
  async revertNoteToVersion(
    docId: string,
    versionId: number,
  ): Promise<{ ok: true; preRevertVersionId: number | null }> {
    const { data } = await this.request<{ ok: true; preRevertVersionId: number | null }>(
      "POST",
      `/api/notes/${encodeURIComponent(docId)}/versions/${encodeURIComponent(String(versionId))}/revert`,
    );
    return data;
  }

  /**
   * How many bytes of CRDT the server holds for a note, and whether that puts it
   * over the sync cap. Needs `edit` — it is only actionable by someone who could
   * reset the doc. See `resetNoteHistory`.
   */
  async noteCrdtSize(
    docId: string,
  ): Promise<{ docId: string; bytes: number; capBytes: number; overCap: boolean }> {
    const { data } = await this.request<{
      docId: string;
      bytes: number;
      capBytes: number;
      overCap: boolean;
    }>("GET", `/api/notes/${encodeURIComponent(docId)}/crdt-size`);
    return data;
  }

  /**
   * Discard a note's edit history server-side and re-seed it from `content`.
   *
   * The repair for a note whose Yjs state has grown past the server's cap: it is
   * refused on every connect, so it can never be edited back down through normal
   * means. DESTRUCTIVE — the text survives (you are supplying it), the history
   * does not. Callers must clear the LOCAL CRDT too, or the old state merges
   * straight back in; `SyncManager.resetNoteHistory` does both in the right
   * order.
   */
  async resetNoteHistory(
    docId: string,
    content: string,
  ): Promise<{ docId: string; bytesBefore: number; bytesAfter: number }> {
    const { data } = await this.request<{
      docId: string;
      bytesBefore: number;
      bytesAfter: number;
    }>("POST", `/api/notes/${encodeURIComponent(docId)}/reset-crdt`, {
      body: { content },
    });
    return data;
  }

  /** A note collection's checkpoints, newest first (any vault member). */
  async listCheckpoints(vaultId: string): Promise<VaultCheckpoint[]> {
    const { data } = await this.request<{ checkpoints: VaultCheckpoint[] }>(
      "GET",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints`,
    );
    return data.checkpoints ?? [];
  }

  /** Take a manual checkpoint (owner/admin). Throws ApiError(409) while another
   *  checkpoint/revert holds the vault's lock. */
  async createCheckpoint(vaultId: string, label?: string): Promise<VaultCheckpoint> {
    const { data } = await this.request<VaultCheckpoint>(
      "POST",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints`,
      { body: label ? { label } : {} },
    );
    return data;
  }

  async deleteCheckpoint(vaultId: string, checkpointId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
    );
  }

  /** Revert the whole vault to a checkpoint (**owner only**; admins 403).
   *  Synchronous and convergent — re-running it lands in the same place. */
  async revertToCheckpoint(vaultId: string, checkpointId: string): Promise<VaultRevertResult> {
    const { data } = await this.request<VaultRevertResult>(
      "POST",
      `/api/vaults/${encodeURIComponent(vaultId)}/checkpoints/${encodeURIComponent(checkpointId)}/revert`,
    );
    return data;
  }

  // ---- Shares -------------------------------------------------------------

  async listShares(
    resourceType: "folder" | "file" | "vault",
    resourceId: string,
  ): Promise<Share[]> {
    const { data } = await this.request<{ shares: Share[] }>("GET", "/api/shares", {
      query: { resourceType, resourceId },
    });
    return data.shares ?? [];
  }

  /** Vault-level shares (the Open/Read-only posture: an org-wide grant on the
   *  vault). resourceId is the organization id. */
  async listVaultShares(orgId: string): Promise<Share[]> {
    return this.listShares("vault", orgId);
  }

  async createShare(input: {
    resourceType: "folder" | "file" | "vault";
    resourceId: string;
    /** Required for user shares; ignored for org-wide grants/locks. */
    principalId?: string;
    principalType?: "user" | "org";
    permission: Permission | "locked" | "denied";
  }): Promise<Share> {
    const { data } = await this.request<Share>("POST", "/api/shares", { body: input });
    return data;
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/shares/${encodeURIComponent(shareId)}`);
  }

  /** Resolve every member's effective access to a resource (the "who can access"
   *  view). Same manage-gate as {@link listShares}. */
  async resolveAccess(
    resourceType: "folder" | "file",
    resourceId: string,
  ): Promise<AccessResolution> {
    const { data } = await this.request<AccessResolution>("GET", "/api/resolve-access", {
      query: { resourceType, resourceId },
    });
    return { members: data.members ?? [] };
  }

  /** All locks in a vault (readable by any vault member — drives lock badges). */
  /**
   * Every access OVERLAY row in a note collection: `locked` (the read-only cap)
   * and `denied` (Private). One request because both are read for the same
   * reason — badging the tree and resolving what an item inherits — and both
   * need the whole vault's set, which a per-resource read can't give.
   */
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
   *  Throws ApiError(403) when the user isn't a member of the vault. */
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
/**
 * The note's last-edit stamp, or null when it has never been edited (or the
 * server predates versioning). Null is the honest answer — a row with no
 * `last_edited_at` must show no "edited by" tag rather than a bare avatar.
 */
export function noteLastEdited(n: RegisteredNote): NoteLastEdited | null {
  const at = n.lastEditedAt ?? n.last_edited_at ?? null;
  if (!at) return null;
  return {
    userId: n.lastEditedBy ?? n.last_edited_by ?? null,
    name: n.lastEditedByName ?? n.last_edited_by_name ?? null,
    at,
  };
}
export function vaultOrgId(v: Vault): string | undefined {
  return v.organizationId ?? v.organization_id;
}
/** Whether this vault's root is closed to new folders/notes. */
export function vaultRootFrozen(v: Vault): boolean {
  return (v.rootFrozen ?? v.root_frozen) === true;
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
